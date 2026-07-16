import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage, Message } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
  computeNextDeliveryAt,
  resolveStepContent,
  addTagToFriend,
  getEntryRouteByRefCode,
  getMessageTemplateById,
} from '@line-crm/db';
import type { EntryRoute, Friend } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { invokeLLM, isConsultationRateLimited } from '../services/llm.js';
import { buildConsultationPrompt, CONSULTATION_FALLBACK_MESSAGE } from '../services/consultationPrompt.js';
import { isOwnerLineUserId, matchOwnerCommand } from '../services/owner-commands.js';
import {
  isChatParityEnabled,
  invokeChatBackend,
  fetchBookingSlots,
  submitBooking,
  formatSlotLabel,
  buildSlotPickerFlexContents,
  parseSlotPostbackData,
  type BookingSlot,
} from '../services/chatBackend.js';
import {
  getChatBookingSession,
  upsertChatBookingSession,
  clearChatBookingSession,
  type ChatBookingSession,
} from '../services/chatBookingSession.js';
import type { Env } from '../index.js';

/** webhook.ts 内から handleEvent 系関数へ渡す、外部チャットバックエンド関連の env 束。 */
interface ChatBackendEnv {
  backendUrl?: string;
  backendSecret?: string;
  testUserIds?: string;
  parityEnabled?: string;
}

const webhook = new Hono<Env>();

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB

// テキストメッセージ受信直後に出す LINE ローディングアニメーションの表示秒数。
// 相談窓口 AI 一次応答 (Gemini) の生成待ち体感を改善する目的 (体感速度対策)。
// 実際の表示は「生成完了 (= 返信メッセージ到着)」または本値の経過のどちらか早い方で
// 消えるため (LINE 仕様)、長めに倒しても生成が速く終われば長く表示され続けることはない。
// 現状の実測 (30秒程度) をカバーしつつ LINE 仕様の上限 (60秒) に収める値として 30 とする。
const LOADING_ANIMATION_SECONDS = 30;

async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  let friend = await getFriendByLineUserId(db, userId);

  if (!friend) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      // A signed webhook already proves this user interacted with the bot.
      // If profile lookup is temporarily unavailable, keep the event processable
      // by creating the friend with the LINE userId and filling profile later.
      console.error('[webhook] Failed to get profile for unknown user', userId, err);
    }

    friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });
    console.log(`[webhook] auto-registered existing friend userId=${userId} friendId=${friend.id}`);
  }

  if (lineAccountId && friend.line_account_id !== lineAccountId) {
    const now = jstNow();
    await db
      .prepare('UPDATE friends SET line_account_id = ?, is_following = 1, updated_at = ? WHERE id = ?')
      .bind(lineAccountId, now, friend.id)
      .run();
    friend = { ...friend, line_account_id: lineAccountId, is_following: 1, updated_at: now };
  }

  return friend;
}

// ─── チャット駆動予約フロー（外部チャットバックエンド連携） ─────────────────
//
// 空き枠提示 → 日時選択(postback) → 氏名/メール収集(text) → 確定 の一連の流れを
// 扱うヘルパー群。会話状態は services/chatBookingSession.ts (D1) が正本、
// AI応答そのものは外部バックエンド (services/chatBackend.ts) が正本。

async function logOutgoingMessage(
  db: D1Database,
  friendId: string,
  payload: { messageType: string; content: string },
  source: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, payload.messageType, payload.content, source, jstNow())
      .run();
  } catch (err) {
    console.error('[webhook] failed to log outgoing chat-booking message', err);
  }
}

async function sendReplyAndLog(
  lineClient: LineClient,
  db: D1Database,
  friendId: string,
  replyToken: string,
  messages: Message[],
  source: string,
): Promise<void> {
  await lineClient.replyMessage(replyToken, messages);
  const { messageToLogPayload } = await import('../services/step-delivery.js');
  for (const msg of messages) {
    await logOutgoingMessage(db, friendId, messageToLogPayload(msg), source);
  }
}

/** 日時選択(postback)を受けた直後の処理。氏名が既知(409再選択等)ならメール収集へ直行する。 */
async function handleChatBookingSlotSelection(
  db: D1Database,
  lineClient: LineClient,
  replyToken: string,
  friend: Friend,
  slot: BookingSlot,
): Promise<void> {
  const session = await getChatBookingSession(db, friend.id);
  const label = formatSlotLabel(slot.start);

  if (session?.name) {
    await upsertChatBookingSession(db, friend.id, {
      state: 'awaiting_email',
      selectedStart: slot.start,
      selectedEnd: slot.end,
    });
    const msg = buildMessage(
      'text',
      `${label} で承ります。\nメールアドレスは分かりますか？（確認メールをお送りします。なければ「なし」とお送りください）`,
    );
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  await upsertChatBookingSession(db, friend.id, {
    state: 'awaiting_name',
    selectedStart: slot.start,
    selectedEnd: slot.end,
  });
  const msg = buildMessage('text', `${label} で承ります。\nお名前を教えてください。`);
  await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
}

const CHAT_BOOKING_RESET_COMMANDS = ['最初から', 'キャンセル'];
const CHAT_BOOKING_NO_EMAIL_KEYWORDS = ['なし', 'ない', '無し', 'skip', 'スキップ'];

/** セッション進行中に届いたテキストメッセージ（氏名/メール入力・リセット・迷子ガード）を処理する。 */
async function handleChatBookingTextStep(
  db: D1Database,
  lineClient: LineClient,
  replyToken: string,
  friend: Friend,
  session: ChatBookingSession,
  chatEnv: Pick<ChatBackendEnv, 'backendUrl' | 'backendSecret'>,
  incomingText: string,
): Promise<void> {
  const trimmed = incomingText.trim();

  if (CHAT_BOOKING_RESET_COMMANDS.includes(trimmed)) {
    await clearChatBookingSession(db, friend.id);
    const msg = buildMessage(
      'text',
      '予約の入力を最初からやり直します。改めて「無料相談を予約したい」とお送りください。',
    );
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  if (session.state === 'awaiting_slot_selection') {
    const msg = buildMessage(
      'text',
      '上に表示された候補からタップして日時を選んでください。\nやり直す場合は「最初から」とお送りください。',
    );
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  if (session.state === 'awaiting_name') {
    if (trimmed.length < 1 || trimmed.length > 255) {
      const msg = buildMessage('text', 'お名前を1〜255文字で教えてください。');
      await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
      return;
    }
    await upsertChatBookingSession(db, friend.id, { state: 'awaiting_email', name: trimmed });
    const msg = buildMessage(
      'text',
      'メールアドレスは分かりますか？（確認メールをお送りします。なければ「なし」とお送りください）',
    );
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  // state === 'awaiting_email'
  if (!session.selectedStart || !session.name) {
    // 想定外の状態崩れ（バグ防御）。安全にリセットしてやり直しを促す。
    await clearChatBookingSession(db, friend.id);
    const msg = buildMessage(
      'text',
      '入力内容を確認できませんでした。恐れ入りますが「無料相談を予約したい」と改めてお送りください。',
    );
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  if (!chatEnv.backendUrl || !chatEnv.backendSecret) {
    await clearChatBookingSession(db, friend.id);
    const msg = buildMessage('text', '只今予約処理を行えませんでした。お手数ですが担当者へ直接ご連絡ください。');
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  const email = CHAT_BOOKING_NO_EMAIL_KEYWORDS.includes(trimmed) ? undefined : trimmed;

  const result = await submitBooking({
    backendUrl: chatEnv.backendUrl,
    backendSecret: chatEnv.backendSecret,
    start: session.selectedStart,
    name: session.name,
    email,
    lineUserId: friend.line_user_id,
  });

  if (result.success) {
    await clearChatBookingSession(db, friend.id);
    const label = formatSlotLabel(result.start);
    const meetLine = result.meetLink
      ? `オンライン相談リンク: ${result.meetLink}`
      : '相談方法は担当者から改めてご連絡します。';
    const msg = buildMessage(
      'text',
      `ご予約を承りました。\n\n日時: ${label}\n${meetLine}\n\nご不明点があれば、このトーク画面からいつでもご連絡ください。`,
    );
    await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    return;
  }

  if (result.code === 'slot_taken') {
    const slotsResult = await fetchBookingSlots({
      backendUrl: chatEnv.backendUrl,
      backendSecret: chatEnv.backendSecret,
    });
    if (slotsResult.ok && slotsResult.slots.length > 0) {
      await upsertChatBookingSession(db, friend.id, {
        state: 'awaiting_slot_selection',
        selectedStart: null,
        selectedEnd: null,
      });
      const textMsg = buildMessage(
        'text',
        'せっかくお選びいただきましたが、その枠はちょうど埋まってしまったようです。改めて空き枠をお送りします。',
      );
      const flexMsg = buildMessage(
        'flex',
        JSON.stringify(buildSlotPickerFlexContents(slotsResult.slots)),
        '空いている日時を選択してください',
      );
      await sendReplyAndLog(lineClient, db, friend.id, replyToken, [textMsg, flexMsg], 'chat_booking_flow');
    } else {
      await clearChatBookingSession(db, friend.id);
      const msg = buildMessage(
        'text',
        'せっかくお選びいただきましたが、その枠はちょうど埋まってしまったようです。恐れ入りますが、改めて「無料相談を予約したい」とお送りください。',
      );
      await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
    }
    return;
  }

  await clearChatBookingSession(db, friend.id);
  const errorText =
    result.code === 'not_configured'
      ? '現在、オンラインでの予約受付を停止しております。恐れ入りますが、担当者からのご連絡をお待ちください。'
      : '只今予約処理でエラーが発生しました。お手数ですが、少し時間をおいて改めてお試しください。';
  const msg = buildMessage('text', errorText);
  await sendReplyAndLog(lineClient, db, friend.id, replyToken, [msg], 'chat_booking_flow');
}

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  // Verify signature BEFORE JSON.parse so attacker-controlled bodies never reach the parser.
  // Fast path: try env default secret first so malformed/unauthenticated traffic
  //   fails fast without a D1 lookup. The main account is typically also registered
  //   in line_accounts; on env match we still look it up so matchedAccountId binds
  //   correctly for downstream account-scoped filters.
  // Slow path: iterate DB-registered accounts for genuinely multi-account installs.
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;
  let valid = false;

  const envSecret = c.env.LINE_CHANNEL_SECRET;
  if (envSecret) {
    valid = await verifySignature(envSecret, rawBody, signature);
    if (valid) {
      const accounts = await getLineAccounts(db);
      const main = accounts.find(
        (a) => a.is_active && a.channel_secret === envSecret,
      );
      if (main) {
        channelAccessToken = main.channel_access_token;
        matchedAccountId = main.id;
      }
    }
  }

  if (!valid) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if (envSecret && account.channel_secret === envSecret) continue; // already tried via fast path
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        valid = true;
        break;
      }
    }
  }

  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    const chatBackendEnv: ChatBackendEnv = {
      backendUrl: c.env.CHAT_BACKEND_URL,
      backendSecret: c.env.CHAT_BACKEND_SECRET,
      testUserIds: c.env.CHAT_PARITY_TEST_USER_IDS,
      parityEnabled: c.env.CHAT_PARITY_ENABLED,
    };
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env.LIFF_URL, c.env.IMAGES, c.env.GEMINI_API_KEY, c.env.OWNER_LINE_USER_IDS, chatBackendEnv);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  geminiApiKey?: string,
  ownerLineUserIds?: string,
  chatBackendEnv: ChatBackendEnv = {},
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    console.log(`[follow] userId=${userId} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    console.log(`[follow] profile=${profile?.displayName ?? 'null'}`);

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Set line_account_id for multi-account tracking (always update on follow)
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), friend.id).run();
      console.log(`[follow] line_account_id set to ${lineAccountId} for friend ${friend.id}`);
    }

    // Resolve referral link (entry_route) for this friend.
    // /auth/callback (OAuth path) writes friends.ref_code in parallel with
    // this follow webhook, so the field can briefly be NULL when LINE
    // delivers the event. Retry a few times (~1s total) before giving up,
    // otherwise override mode and intro pushes silently fall back to the
    // account default whenever the webhook wins the race.
    const { getFriendById } = await import('@line-crm/db');
    let friendRefCode = (friend as { ref_code?: string | null }).ref_code ?? null;
    if (!friendRefCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const refreshed = await getFriendById(db, friend.id);
        const refreshedRef = (refreshed as { ref_code?: string | null } | null)?.ref_code ?? null;
        if (refreshedRef) {
          friendRefCode = refreshedRef;
          break;
        }
      }
    }
    const referralRoute: EntryRoute | null = friendRefCode
      ? await getEntryRouteByRefCode(db, friendRefCode)
      : null;
    const runAccountScenarios =
      !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    // Skip entirely when a referral link explicitly overrides (run_account_friend_add_scenarios=0).
    const scenarios = runAccountScenarios ? await getScenarios(db) : [];
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

            // Immediate delivery: scenario.delivery_mode を踏まえて step1 が「now 以前」に
            // スケジュールされる場合のみ replyMessage で即時送信する。
            // - relative + delay_minutes=0 → 即時
            // - elapsed + offset_days=0 + offset_minutes=0 → 即時
            // - absolute_time で過去時刻 → computeNextDeliveryAt が now に clamp するので即時
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            const deliveryMode = scenario.delivery_mode ?? 'relative';
            const enrolledAtJst = new Date(Date.now() + 9 * 60 * 60_000);
            const firstScheduledAt = firstStep
              ? computeNextDeliveryAt(
                  { delivery_mode: deliveryMode },
                  firstStep,
                  { enrolledAt: enrolledAtJst, previousDeliveredAt: enrolledAtJst, now: enrolledAtJst },
                )
              : null;
            const shouldSendImmediately =
              firstStep &&
              firstScheduledAt !== null &&
              firstScheduledAt.getTime() <= enrolledAtJst.getTime() &&
              friendScenario.status === 'active';
            if (firstStep && shouldSendImmediately) {
              try {
                // Resolve template_id → templates table (参照型)
                const resolved = await resolveStepContent(db, firstStep);
                const { resolveMetadata } = await import('../services/step-delivery.js');
                const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
                const expandedContent = expandVariables(resolved.messageContent, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1]);
                const message = buildMessage(resolved.messageType, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log what was actually delivered (post buildMessage normalization)
                // so the dashboard chat view mirrors LINE 1:1.
                const logId = crypto.randomUUID();
                const { messageToLogPayload: logPayload1 } = await import('../services/step-delivery.js');
                const wbScenarioPayload = logPayload1(message);
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, template_id_at_send, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', 'scenario', ?, ?)`,
                  )
                  .bind(logId, friend.id, wbScenarioPayload.messageType, wbScenarioPayload.content, firstStep.id, resolved.templateIdAtSend, jstNow())
                  .run();

                // Advance or complete the friend_scenario — step 2 のスケジュールも
                // computeNextDeliveryAt で計算する（elapsed/absolute_time で正しく動かすため）
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = computeNextDeliveryAt(
                    { delivery_mode: deliveryMode },
                    secondStep,
                    { enrolledAt: enrolledAtJst, previousDeliveredAt: enrolledAtJst, now: enrolledAtJst },
                  );
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }

                // 到達タグ付与 (advance / complete の後)
                if (firstStep.on_reach_tag_id) {
                  try {
                    await addTagToFriend(db, friend.id, firstStep.on_reach_tag_id);
                  } catch (err) {
                    console.error(`[scenario] tag attach failed step=${firstStep.id}:`, err);
                  }
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // Referral link side-effects (intro push + dedicated scenario)
    if (referralRoute) {
      // Intro push from referral link
      if (referralRoute.intro_template_id) {
        try {
          const template = await getMessageTemplateById(db, referralRoute.intro_template_id);
          if (template) {
            const message = buildMessage(template.message_type, template.message_content);
            await lineClient.pushMessage(userId, [message]);
            console.log(`[follow] referral intro push sent route=${referralRoute.id}`);
          }
        } catch (err) {
          console.error('[follow] referral intro push failed', err);
        }
      }

      // Dedicated scenario enrollment from referral link
      if (referralRoute.scenario_id) {
        try {
          await enrollFriendInScenario(db, friend.id, referralRoute.scenario_id);
          console.log(`[follow] referral scenario enrolled scenario=${referralRoute.scenario_id}`);
        } catch (err) {
          console.error('[follow] referral scenario enrollment failed', err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // Match postback data against auto_replies (exact match on keyword)
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
      }>();

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
     // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
     // delivery_type='push' は厳密には push ではないが、incoming/non-test として
     // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    try {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, postbackData, lineAccountId ?? null, jstNow())
        .run();
    } catch (err) {
      console.error('Failed to log incoming postback', err);
    }

    // チャット駆動予約フロー — 空き枠選択ボタンの postback は auto_replies を通さず
    // 専用ハンドラで処理する（氏名/メール収集ステップへ進める）。
    const chatBookingSlot = parseSlotPostbackData(postbackData);
    if (chatBookingSlot) {
      try {
        await handleChatBookingSlotSelection(db, lineClient, event.replyToken, friend, chatBookingSlot);
      } catch (err) {
        console.error('[webhook] chat booking slot selection failed', err);
        await clearChatBookingSession(db, friend.id).catch(() => undefined);
      }
      return;
    }

    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ — Rich Menu 経由の Flex 応答もチャット詳細に残るようにする。
          // テキスト auto_reply (line ~390) と同じパターン。
          const { messageToLogPayload: logPayload } = await import('../services/step-delivery.js');
          const replyPayload = logPayload(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
            )
            .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
      fileName?: string;
      title?: string;
      packageId?: string | number;
      package_id?: string | number;
      stickerId?: string | number;
      sticker_id?: string | number;
      stickerResourceType?: string | number;
      sticker_resource_type?: string | number;
    };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if (msg.type === 'image' && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, msg.type, finalContent, jstNow())
      .run();
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // 受信直後・Gemini呼び出し前にローディングアニメーションを出す（体感速度対策）。
    // fire-and-forget: メイン処理の待ち時間には入れない。1:1トーク限定の LINE 仕様
    // なので失敗しても本処理には影響させず、ログのみ残す。
    try {
      void lineClient.startLoadingAnimation(userId, LOADING_ANIMATION_SECONDS).catch((err) => {
        console.error('[webhook] loading animation failed', err);
      });
    } catch (err) {
      console.error('[webhook] loading animation failed (sync)', err);
    }

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // オーナーコマンド: OWNER_LINE_USER_IDS に登録された送信者だけが対象。
    // 非オーナーは isOwnerLineUserId() で弾かれ、以降の通常処理 (体験トリガー/自動返信/
    // AI一次応答) にそのままフォールスルーする — コマンドの存在自体を漏らさないため。
    if (isOwnerLineUserId(userId, ownerLineUserIds)) {
      const ownerReply = matchOwnerCommand(incomingText);
      if (ownerReply) {
        try {
          const ownerMsg = buildMessage('text', ownerReply);
          await lineClient.replyMessage(event.replyToken, [ownerMsg]);

          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
               VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', 'owner_command', ?)`,
            )
            .bind(crypto.randomUUID(), friend.id, ownerReply, jstNow())
            .run();
        } catch (err) {
          console.error('[webhook] owner command reply failed', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // チャット駆動予約フロー — 進行中のセッションがあれば最優先で処理し、
    // auto_replies / AI一次応答には進まない（氏名入力等をキーワードマッチや
    // AI応答に誤って回さないため）。常に replyToken を消費する。
    const chatBookingSession = await getChatBookingSession(db, friend.id);
    if (chatBookingSession) {
      try {
        await handleChatBookingTextStep(
          db,
          lineClient,
          event.replyToken,
          friend,
          chatBookingSession,
          chatBackendEnv,
          incomingText,
        );
      } catch (err) {
        console.error('[webhook] chat booking text step failed', err);
        await clearChatBookingSession(db, friend.id).catch(() => undefined);
      }
      await fireEvent(db, 'message_received', {
        friendId: friend.id,
        eventData: { text: incomingText, matched: true },
      }, lineAccessToken, lineAccountId);
      return;
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        // silent タイプ: 返信しないが matched=true にして unread / push を抑止する
        if (rule.response_type === 'silent') {
          matched = true;
          break;
        }

        try {
          const { resolveMetadata: resolveMeta2 } = await import('../services/step-delivery.js');
          const resolvedMeta2 = await resolveMeta2(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta2 } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）— derive content from the built
          // reply message so any cleanEmptyNodes / parse-failure fallback is
          // reflected in the dashboard.
          const outLogId = crypto.randomUUID();
          const { messageToLogPayload: logPayload2 } = await import('../services/step-delivery.js');
          const wbAutoReplyPayload = logPayload2(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?)`,
            )
            .bind(outLogId, friend.id, wbAutoReplyPayload.messageType, wbAutoReplyPayload.content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    // auto_replies にマッチしなかった = 自発メッセージ → unread にする
    if (!matched) {
      await upsertChatOnMessage(db, friend.id);

      // 外部チャットバックエンド連携（Ryo限定テストゲート・CHAT_PARITY_TEST_USER_IDS）。
      // Webチャットと同一プロンプト/予約誘導ロジックで応答する新フロー。ゲート対象外
      // or バックエンド未設定 or 呼び出し失敗時は、下の既存Gemini単発応答へ完全に
      // フォールバックする（本番の他ユーザーの挙動には一切影響しない・安全側)。
      let handledByChatParity = false;
      if (
        chatBackendEnv.backendUrl &&
        chatBackendEnv.backendSecret &&
        isChatParityEnabled(userId, chatBackendEnv)
      ) {
        const parityStart = Date.now();
        try {
          const backendReply = await invokeChatBackend({
            backendUrl: chatBackendEnv.backendUrl,
            backendSecret: chatBackendEnv.backendSecret,
            lineUserId: userId,
            message: incomingText,
          });
          console.log(`[webhook][perf] chat backend invoke: ${Date.now() - parityStart}ms`);

          const messagesToSend: Message[] = [buildMessage('text', backendReply.reply)];

          if (backendReply.book) {
            const slotsResult = await fetchBookingSlots({
              backendUrl: chatBackendEnv.backendUrl,
              backendSecret: chatBackendEnv.backendSecret,
            });
            if (slotsResult.ok && slotsResult.slots.length > 0) {
              messagesToSend.push(
                buildMessage(
                  'flex',
                  JSON.stringify(buildSlotPickerFlexContents(slotsResult.slots)),
                  '空いている日時を選択してください',
                ),
              );
              await upsertChatBookingSession(db, friend.id, { state: 'awaiting_slot_selection' });
            } else if (slotsResult.ok) {
              // 空き枠0件 — フローには入らず、担当者フォローに委ねる（返信テキストのみ送信）。
              console.log(`[webhook] chat parity book=true but no slots available friendId=${friend.id}`);
            } else if (slotsResult.reason === 'not_configured' && slotsResult.message) {
              messagesToSend.push(buildMessage('text', slotsResult.message));
            } else {
              console.error('[webhook] chat parity slots fetch failed', slotsResult);
            }
          }

          if (backendReply.escalate) {
            // Ryo宛の通知は satoyama 側で送信済み（契約: docs/line-booking-integration.md §3.3）。
            // Harness側での追加送信は不要。観測用にログのみ残す。
            console.log(`[webhook] chat parity escalate=true friendId=${friend.id}`);
          }

          await lineClient.replyMessage(event.replyToken, messagesToSend);
          replyTokenConsumed = true;
          handledByChatParity = true;

          const { messageToLogPayload: logPayloadChatParity } = await import('../services/step-delivery.js');
          for (const sentMsg of messagesToSend) {
            await logOutgoingMessage(db, friend.id, logPayloadChatParity(sentMsg), 'ai_consultation');
          }
        } catch (err) {
          console.error(
            `[webhook] chat parity backend failed after ${Date.now() - parityStart}ms, falling back to existing consultation`,
            err,
          );
        }
      }

      // 相談窓口 AI 一次応答 (Gemini)。GEMINI_API_KEY 未設定 / レート超過時は何もせず
      // 従来どおり応答なし (fireEvent 側の通知のみ) にフォールバックする。
      // LLM生成そのものが失敗/タイムアウト/MAX_TOKENS切れした場合は、中途半端な文を
      // 送らずに定型フォールバック文 (CONSULTATION_FALLBACK_MESSAGE) を送る
      // （無応答よりユーザー体験が良く、replyToken を確実に消費できる）。
      // replyToken を消費した場合のみ replyTokenConsumed=true にし、下の fireEvent には
      // 渡さない（二重消費防止）。
      if (!handledByChatParity && geminiApiKey) {
        // レイテンシ計測（30秒問題の内訳特定用・恒久計装）。D1レート制限クエリ /
        // Gemini生成 / LINE reply の各区間でどこが支配的かを wrangler tail で
        // 追えるようにする。本番トラフィック量はレート制限 (60秒3件) で自然に
        // 抑えられるため常時onでもログ量は問題にならない。
        const consultationStart = Date.now();
        try {
          const rateLimited = await isConsultationRateLimited(db, friend.id);
          console.log(`[webhook][perf] rateLimit check: ${Date.now() - consultationStart}ms`);
          if (!rateLimited) {
            let aiText: string;
            let logSource: 'ai_consultation' | 'ai_consultation_fallback' = 'ai_consultation';
            const geminiStart = Date.now();
            try {
              const prompt = buildConsultationPrompt(incomingText);
              aiText = await invokeLLM({ apiKey: geminiApiKey, prompt });
              console.log(`[webhook][perf] gemini invokeLLM: ${Date.now() - geminiStart}ms`);
            } catch (llmErr) {
              console.error(
                `[webhook] AI consultation generation failed after ${Date.now() - geminiStart}ms, sending fallback text`,
                llmErr,
              );
              aiText = CONSULTATION_FALLBACK_MESSAGE;
              logSource = 'ai_consultation_fallback';
            }

            const aiReplyMsg = buildMessage('text', aiText);
            const lineReplyStart = Date.now();
            await lineClient.replyMessage(event.replyToken, [aiReplyMsg]);
            console.log(
              `[webhook][perf] line replyMessage: ${Date.now() - lineReplyStart}ms / total ai-consultation path: ${Date.now() - consultationStart}ms`,
            );
            replyTokenConsumed = true;

            // 送信ログ（他の reply 経路と同じ messages_log 記録パターン）
            const aiLogId = crypto.randomUUID();
            const { messageToLogPayload: logPayload3 } = await import('../services/step-delivery.js');
            const aiReplyPayload = logPayload3(aiReplyMsg);
            await db
              .prepare(
                `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
                 VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?, ?)`,
              )
              .bind(aiLogId, friend.id, aiReplyPayload.messageType, aiReplyPayload.content, logSource, jstNow())
              .run();
          }
        } catch (err) {
          // replyMessage 自体の失敗 (LINE API エラー等) 時は reply 未消費のまま。
          // replyTokenConsumed は false のままなので、下の fireEvent に replyToken が
          // そのまま渡り従来動作を維持する。
          console.error('[webhook] AI consultation reply failed, falling back', err);
        }
      }
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

/**
 * auto_reply 行の content/type を resolve する。template_id が set なら templates
 * から取得、参照切れや NULL のときは inline response_content/response_type を使う。
 */
async function resolveAutoReplyContent(
  db: D1Database,
  rule: { template_id: string | null; response_type: string; response_content: string },
): Promise<{ messageType: string; content: string }> {
  if (rule.template_id) {
    const { getTemplateById } = await import('@line-crm/db');
    const tpl = await getTemplateById(db, rule.template_id);
    if (tpl) {
      return { messageType: tpl.message_type, content: tpl.message_content };
    }
  }
  return { messageType: rule.response_type, content: rule.response_content };
}

export { webhook };
