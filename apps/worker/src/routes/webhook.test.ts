import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
  startLoadingAnimation: vi.fn().mockResolvedValue(undefined),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/satoyama-onboarding-reminder.js', () => ({
  scheduleFriendOnboardingReminder: vi.fn().mockResolvedValue(undefined),
  cancelFriendOnboardingReminder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
  messageToLogPayload: vi.fn(),
}));

vi.mock('../services/llm.js', () => ({
  invokeLLM: vi.fn(),
  isConsultationRateLimited: vi.fn(),
}));

// チャット駆動予約フロー — 大半のテストはセッション未使用の既存パスを検証するため、
// デフォルトで「セッションなし」を返す。専用テストのみ個別に mockResolvedValueOnce する。
vi.mock('../services/chatBookingSession.js', () => ({
  getChatBookingSession: vi.fn().mockResolvedValue(null),
  upsertChatBookingSession: vi.fn().mockResolvedValue(undefined),
  clearChatBookingSession: vi.fn().mockResolvedValue(undefined),
}));

// 外部チャットバックエンド連携 — デフォルトはゲート閉（isChatParityEnabled=false）で
// 既存Gemini経路のテストに影響しないようにする。専用テストのみ個別に上書きする。
vi.mock('../services/chatBackend.js', async () => {
  // buildQuickReplyItems は純粋な変換関数（LINEのlabel長・件数上限のトリミングのみ）
  // のため、実装をそのまま使う（importActual）。他はモックのまま従来通り。
  const actual = await vi.importActual<typeof import('../services/chatBackend.js')>('../services/chatBackend.js');
  return {
    isChatParityEnabled: vi.fn().mockReturnValue(false),
    invokeChatBackend: vi.fn(),
    fetchBookingSlots: vi.fn(),
    submitBooking: vi.fn(),
    formatSlotLabel: vi.fn((iso: string) => `label(${iso})`),
    formatDayLabel: vi.fn((dateKey: string) => `day(${dateKey})`),
    buildSlotPickerFlexContents: vi.fn().mockReturnValue({ type: 'bubble' }),
    buildDayPickerFlexContents: vi.fn().mockReturnValue({ type: 'bubble', variant: 'day' }),
    parseSlotPostbackData: vi.fn().mockReturnValue(null),
    parseDayPostbackData: vi.fn().mockReturnValue(null),
    groupSlotsByJstDay: vi.fn().mockReturnValue([]),
    filterSlotsByJstDay: vi.fn().mockReturnValue([]),
    buildQuickReplyItems: actual.buildQuickReplyItems,
    // isExplicitBookingIntent / BOOKING_QUICK_REPLY_LABEL は決定論的な純粋関数・定数
    // （2026-07-17 STEP1追加）のため、buildQuickReplyItemsと同様に実装をそのまま使う。
    isExplicitBookingIntent: actual.isExplicitBookingIntent,
    BOOKING_QUICK_REPLY_LABEL: actual.BOOKING_QUICK_REPLY_LABEL,
    // resolveQuickReplyOptions も同様に決定論的な純粋関数（2026-07-17 毎ターン常時表示化で
    // 追加）のため実装をそのまま使う。モックすると「常に空にフォールバックしない」誤検知の
    // テストになってしまう。
    resolveQuickReplyOptions: actual.resolveQuickReplyOptions,
  };
});

import { verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserId,
  getLineAccounts,
  getMessageTemplateById,
  getScenarioSteps,
  getScenarios,
  jstNow,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, messageToLogPayload } from '../services/step-delivery.js';
import { invokeLLM, isConsultationRateLimited } from '../services/llm.js';
import { buildConsultationPrompt, CONSULTATION_FALLBACK_MESSAGE } from '../services/consultationPrompt.js';
import {
  getChatBookingSession,
  upsertChatBookingSession,
  clearChatBookingSession,
} from '../services/chatBookingSession.js';
import {
  isChatParityEnabled,
  invokeChatBackend,
  fetchBookingSlots,
  submitBooking,
  parseSlotPostbackData,
  parseDayPostbackData,
  groupSlotsByJstDay,
  filterSlotsByJstDay,
} from '../services/chatBackend.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLineAccounts).mockResolvedValue([]);

  // チャット駆動予約フロー系の mock は複数 describe ブロックで permanent
  // mockResolvedValue/mockReturnValue を使っているため、vi.clearAllMocks()
  // だけでは前のテストの実装が漏れる。テストごとに安全なデフォルトへ戻す。
  vi.mocked(getChatBookingSession).mockResolvedValue(null);
  vi.mocked(upsertChatBookingSession).mockResolvedValue(undefined);
  vi.mocked(clearChatBookingSession).mockResolvedValue(undefined);
  vi.mocked(isChatParityEnabled).mockReturnValue(false);
  vi.mocked(parseSlotPostbackData).mockReturnValue(null);
  vi.mocked(parseDayPostbackData).mockReturnValue(null);
  vi.mocked(groupSlotsByJstDay).mockReturnValue([]);
  vi.mocked(filterSlotsByJstDay).mockReturnValue([]);
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      null,
    );
    expect(getScenarios).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // Keep the unrelated DB stubs quiet but type-checked as mocked imports.
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — AI consultation fallback (Gemini)', () => {
  const aiTestFriend = {
    id: 'friend-ai-1',
    line_user_id: 'U-ai-1',
    display_name: 'AI Test Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-01T00:00:00.000+09:00',
    updated_at: '2026-07-01T00:00:00.000+09:00',
  };

  function makeStmt() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      // Empty auto_replies match set → `matched` stays false so every test here
      // exercises the fallback branch under test.
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  function makeEvent(text: string, replyToken: string) {
    return {
      type: 'message',
      replyToken,
      message: { type: 'text', id: 'message-ai-1', text },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-ai-1' },
      webhookEventId: 'event-ai-1',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    };
  }

  async function postConsultation(envOverrides: Record<string, unknown>, text = '営業時間を教えてください') {
    const replyToken = 'reply-token-ai';
    const stmt = makeStmt();
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({ destination: 'bot', events: [makeEvent(text, replyToken)] }),
      },
      { ...baseEnv, DB: db, ...envOverrides },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    return { res, db, stmt, replyToken };
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(
      aiTestFriend as unknown as Awaited<ReturnType<typeof getFriendByLineUserId>>,
    );
    vi.mocked(jstNow).mockReturnValue('2026-07-01T12:00:00.000+09:00');
  });

  test('(a) matched=false: invokes Gemini and replies with its text via replyMessage', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('担当者が確認のうえご連絡します。');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '担当者が確認のうえご連絡します。' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '担当者が確認のうえご連絡します。' });

    const { res, replyToken } = await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' }, '営業時間を教えてください');

    expect(res.status).toBe(200);
    expect(isConsultationRateLimited).toHaveBeenCalledWith(expect.anything(), 'friend-ai-1');
    expect(invokeLLM).toHaveBeenCalledWith({
      apiKey: 'test-gemini-key',
      prompt: buildConsultationPrompt('営業時間を教えてください'),
    });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: '担当者が確認のうえご連絡します。' },
    ]);
  });

  test('(a-2) fires the loading animation for the sender before replying (体感速度対策)', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('担当者が確認のうえご連絡します。');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '担当者が確認のうえご連絡します。' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '担当者が確認のうえご連絡します。' });

    await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' }, '営業時間を教えてください');

    expect(lineClientMocks.startLoadingAnimation).toHaveBeenCalledWith('U-ai-1', 30);
  });

  test('(a-3) loading animation failure does not block the AI reply (fire-and-forget)', async () => {
    lineClientMocks.startLoadingAnimation.mockRejectedValueOnce(new Error('LINE API error: 400 not viewing chat'));
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('担当者が確認のうえご連絡します。');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '担当者が確認のうえご連絡します。' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '担当者が確認のうえご連絡します。' });

    const { res, replyToken } = await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' }, '営業時間を教えてください');

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: '担当者が確認のうえご連絡します。' },
    ]);
  });

  test('(b) LLM success: replyTokenConsumed=true so fireEvent does not receive the replyToken', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('AI reply text');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'AI reply text' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'AI reply text' });

    await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' });

    expect(fireEvent).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(fireEvent).mock.calls[0][2] as { replyToken?: string };
    expect(payload.replyToken).toBeUndefined();
  });

  test('(c) LLM error/timeout/MAX_TOKENS: sends the fixed fallback text instead of staying silent, consumes replyToken', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockRejectedValue(new Error('Gemini API error: 500 Internal Server Error'));
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: CONSULTATION_FALLBACK_MESSAGE });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: CONSULTATION_FALLBACK_MESSAGE });

    const { res, replyToken } = await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' });

    expect(res.status).toBe(200);
    // 中途半端な生成文は送らないが、無応答のまま放置もしない — 定型フォールバック文を送る
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: CONSULTATION_FALLBACK_MESSAGE },
    ]);
    expect(upsertChatOnMessage).toHaveBeenCalledWith(expect.anything(), 'friend-ai-1');

    // replyToken を消費したので fireEvent には渡らない（二重消費防止）
    const payload = vi.mocked(fireEvent).mock.calls[0][2] as { replyToken?: string };
    expect(payload.replyToken).toBeUndefined();
  });

  test('(c-2) LLM error AND the fallback replyMessage itself also fails: stays silent, keeps replyTokenConsumed=false (original safety net)', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockRejectedValue(new Error('Gemini API error: 500 Internal Server Error'));
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: CONSULTATION_FALLBACK_MESSAGE });
    lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('LINE API error: 500'));

    const { res, replyToken } = await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' });

    expect(res.status).toBe(200);
    expect(upsertChatOnMessage).toHaveBeenCalledWith(expect.anything(), 'friend-ai-1');

    const payload = vi.mocked(fireEvent).mock.calls[0][2] as { replyToken?: string };
    expect(payload.replyToken).toBe(replyToken);
  });

  test('(d) rate limit exceeded (>3 in 60s): skips invokeLLM entirely', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(true);

    const { res, replyToken } = await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' });

    expect(res.status).toBe(200);
    expect(isConsultationRateLimited).toHaveBeenCalledWith(expect.anything(), 'friend-ai-1');
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();

    const payload = vi.mocked(fireEvent).mock.calls[0][2] as { replyToken?: string };
    expect(payload.replyToken).toBe(replyToken);
  });

  test('(e) message longer than 500 chars: prompt sent to Gemini is truncated via buildConsultationPrompt', async () => {
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('AI reply text');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'AI reply text' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'AI reply text' });

    const longMessage = 'あ'.repeat(700);
    await postConsultation({ GEMINI_API_KEY: 'test-gemini-key' }, longMessage);

    const calledPrompt = vi.mocked(invokeLLM).mock.calls[0][0].prompt;
    expect(calledPrompt).toBe(buildConsultationPrompt(longMessage));
    expect(calledPrompt).not.toContain('あ'.repeat(501));
  });

  test('does not check the rate limit or call Gemini at all when GEMINI_API_KEY is unset', async () => {
    const { res, replyToken } = await postConsultation({});

    expect(res.status).toBe(200);
    expect(isConsultationRateLimited).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();

    const payload = vi.mocked(fireEvent).mock.calls[0][2] as { replyToken?: string };
    expect(payload.replyToken).toBe(replyToken);
  });
});

describe('POST /webhook — chat parity (external chat backend, Ryo限定テストゲート)', () => {
  const parityTestFriend = {
    id: 'friend-parity-1',
    line_user_id: 'U-parity-1',
    display_name: 'Parity Test Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-01T00:00:00.000+09:00',
    updated_at: '2026-07-01T00:00:00.000+09:00',
  };

  function makeStmt() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  function makeEvent(text: string, replyToken: string) {
    return {
      type: 'message',
      replyToken,
      message: { type: 'text', id: 'message-parity-1', text },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-parity-1' },
      webhookEventId: 'event-parity-1',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    };
  }

  // 2026-07-17 STEP1: デフォルト文言は isExplicitBookingIntent() に一致しない
  // 中立な発話にする（「予約管理を自動化したい」等の業務ワードは対象外・
  // chatSystemPrompt.tsの「予約管理」誤発火注意と同じ理由）。明示的な予約意図を
  // 検証したいテストは text 引数で個別に上書きする。
  async function postParity(envOverrides: Record<string, unknown>, text = '予約管理を自動化したい') {
    const replyToken = 'reply-token-parity';
    const stmt = makeStmt();
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': validShapedSignature },
        body: JSON.stringify({ destination: 'bot', events: [makeEvent(text, replyToken)] }),
      },
      { ...baseEnv, DB: db, ...envOverrides },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    return { res, db, stmt, replyToken };
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(
      parityTestFriend as unknown as Awaited<ReturnType<typeof getFriendByLineUserId>>,
    );
    vi.mocked(jstNow).mockReturnValue('2026-07-01T12:00:00.000+09:00');
    vi.mocked(getChatBookingSession).mockResolvedValue(null);
  });

  test('gate closed (isChatParityEnabled=false): never calls the external backend, falls straight to Gemini', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(false);
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('Gemini fallback reply');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'Gemini fallback reply' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'Gemini fallback reply' });

    const { res } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      // CHAT_PARITY_TEST_USER_IDS 未設定 → ゲート閉
    });

    expect(res.status).toBe(200);
    expect(invokeChatBackend).not.toHaveBeenCalled();
    expect(invokeLLM).toHaveBeenCalledTimes(1);
  });

  test('backend not configured (CHAT_BACKEND_URL/SECRET missing) even if gate is open: falls to Gemini without calling the backend', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('Gemini fallback reply');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'Gemini fallback reply' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'Gemini fallback reply' });

    const { res } = await postParity({ GEMINI_API_KEY: 'test-gemini-key' });

    expect(res.status).toBe(200);
    expect(invokeChatBackend).not.toHaveBeenCalled();
    expect(invokeLLM).toHaveBeenCalledTimes(1);
  });

  test('gate open + backend success (book=false): replies with backend text, never touches Gemini', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({ reply: 'Webと同じトーンの返信です', book: false, escalate: false });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'Webと同じトーンの返信です' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'Webと同じトーンの返信です' });

    const { res, replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    expect(res.status).toBe(200);
    expect(invokeChatBackend).toHaveBeenCalledWith({
      backendUrl: 'https://backend.example',
      backendSecret: 'secret',
      lineUserId: 'U-parity-1',
      message: '予約管理を自動化したい',
    });
    // 2026-07-17追加: quickReplies無し・book=falseでも、Harness側の構造フォールバック
    // （resolveQuickReplyOptions）により既定の3件クイックリプライが付く（詳細は
    // 「falls back to the default 3-item quick reply」テスト参照）。このテストの主眼は
    // invokeChatBackendの呼び出しパラメータとinvokeLLMが呼ばれないことの検証のため、
    // quickReplyの中身はここでは緩く確認する。
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ type: 'text', text: 'Webと同じトーンの返信です' }),
    ]);
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(fetchBookingSlots).not.toHaveBeenCalled();
  });

  test('gate open + backend success + book=true (non-explicit text): AIの判定だけでは即Flexを出さず、「無料相談を予約する」クイックリプライボタンだけを添える（2026-07-17 STEP1構造変更）', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({ reply: '空いている日時をお伝えしますね', book: true, escalate: false });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '空いている日時をお伝えしますね' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '空いている日時をお伝えしますね' });

    const { res, replyToken } = await postParity(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
      },
      '予約管理を自動化したい', // isExplicitBookingIntent()に一致しない業務文脈の発話
    );

    expect(res.status).toBe(200);
    // book=trueだけではFlexを出さない・fetchBookingSlotsは呼ばれない・セッションも開かない
    expect(fetchBookingSlots).not.toHaveBeenCalled();
    expect(upsertChatBookingSession).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      {
        type: 'text',
        text: '空いている日時をお伝えしますね',
        quickReply: {
          items: [{ type: 'action', action: { type: 'message', label: '無料相談を予約する', text: '無料相談を予約する' } }],
        },
      },
    ]);
  });

  // 2026-07-17 実機バグ再現テスト（受け入れテスト③）: 「AIの導入について相談したいです」
  // のような、ただの相談の切り出し文言が isExplicitBookingIntent() に誤って一致し、
  // AIを一切介さず日付ピッカーFlexへ直行していた（"相談したい"の部分一致が原因）。
  // 修正後は通常のAI会話ルート（invokeChatBackend）に入り、Flexは出ないことを検証する。
  test('"AIの導入について相談したいです" (a plain consultation opener) routes to the AI backend, does NOT jump straight to the date-picker Flex — regression: 実機バグ', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({
      reply: 'かしこまりました。今どんなことに時間を取られていますか？',
      book: false,
      escalate: false,
      quickReplies: ['予約や問い合わせの対応', 'SNSやチラシなどの発信', 'その他'],
    });
    vi.mocked(buildMessage).mockReturnValue({
      type: 'text',
      text: 'かしこまりました。今どんなことに時間を取られていますか？',
    });
    vi.mocked(messageToLogPayload).mockReturnValue({
      messageType: 'text',
      content: 'かしこまりました。今どんなことに時間を取られていますか？',
    });

    const { res, replyToken } = await postParity(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
      },
      'AIの導入について相談したいです',
    );

    expect(res.status).toBe(200);
    // AIを介す（invokeChatBackendが呼ばれる）。fetchBookingSlots（＝Flex直行）は呼ばれない
    expect(invokeChatBackend).toHaveBeenCalledWith({
      backendUrl: 'https://backend.example',
      backendSecret: 'secret',
      lineUserId: 'U-parity-1',
      message: 'AIの導入について相談したいです',
    });
    expect(fetchBookingSlots).not.toHaveBeenCalled();
    expect(upsertChatBookingSession).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ type: 'text', text: 'かしこまりました。今どんなことに時間を取られていますか？' }),
    ]);
  });

  test('明示的な予約意図の自由文（例: 「無料相談を予約したい」）: AIを介さず直接fetchBookingSlots→日付ピッカーFlexへ入る（2026-07-17 STEP1）', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(fetchBookingSlots).mockResolvedValue({
      ok: true,
      slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }],
    });
    vi.mocked(groupSlotsByJstDay).mockReturnValue([
      {
        dateKey: '2026-08-01',
        label: '8/1(土)',
        slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }],
      },
    ]);
    vi.mocked(buildMessage).mockImplementation((type) =>
      type === 'flex'
        ? { type: 'flex', altText: 'x', contents: {} }
        : { type: 'text', text: 'かしこまりました。ご希望の日を選んでください。' },
    );
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'x' });

    const { res, replyToken } = await postParity(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
      },
      '無料相談を予約したい',
    );

    expect(res.status).toBe(200);
    // AIは介さない（invokeChatBackendは呼ばれない）
    expect(invokeChatBackend).not.toHaveBeenCalled();
    expect(fetchBookingSlots).toHaveBeenCalledWith({ backendUrl: 'https://backend.example', backendSecret: 'secret' });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: 'かしこまりました。ご希望の日を選んでください。' },
      { type: 'flex', altText: 'x', contents: {} },
    ]);
    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-parity-1', {
      state: 'awaiting_slot_selection',
    });
  });

  test('「無料相談を予約する」ボタン（クイックリプライのラベルそのもの）を押した場合も、直接日付ピッカーFlexへ入る', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(fetchBookingSlots).mockResolvedValue({
      ok: true,
      slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }],
    });
    vi.mocked(groupSlotsByJstDay).mockReturnValue([
      { dateKey: '2026-08-01', label: '8/1(土)', slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }] },
    ]);
    vi.mocked(buildMessage).mockImplementation((type) =>
      type === 'flex'
        ? { type: 'flex', altText: 'x', contents: {} }
        : { type: 'text', text: 'かしこまりました。ご希望の日を選んでください。' },
    );
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'x' });

    await postParity(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
      },
      '無料相談を予約する',
    );

    expect(invokeChatBackend).not.toHaveBeenCalled();
    expect(fetchBookingSlots).toHaveBeenCalledTimes(1);
  });

  test('明示的な予約意図だが空き枠0件: Flexは出さず、理由を伝えるテキストで終わる', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(fetchBookingSlots).mockResolvedValue({ ok: true, slots: [] });
    vi.mocked(groupSlotsByJstDay).mockReturnValue([]);
    vi.mocked(buildMessage).mockImplementation((_type, content) => ({ type: 'text', text: content as string }));
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'x' });

    const { replyToken } = await postParity(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
      },
      '無料相談を予約したい',
    );

    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: 'かしこまりました。ご希望の日を選んでください。' },
      { type: 'text', text: 'あいにく、ただいま空いている日時がございません。恐れ入りますが、担当者からのご連絡をお待ちください。' },
    ]);
    expect(upsertChatBookingSession).not.toHaveBeenCalled();
  });

  test('gate open + backend throws (timeout/network): falls back to existing Gemini flow, replyToken still gets consumed via fallback text', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockRejectedValue(new Error('chat backend error: 500 Internal Server Error'));
    vi.mocked(isConsultationRateLimited).mockResolvedValue(false);
    vi.mocked(invokeLLM).mockResolvedValue('Gemini fallback reply');
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'Gemini fallback reply' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'Gemini fallback reply' });

    const { res, replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    expect(res.status).toBe(200);
    expect(invokeChatBackend).toHaveBeenCalledTimes(1);
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [{ type: 'text', text: 'Gemini fallback reply' }]);
  });

  test('gate open + backend returns quickReplies: attaches a LINE quick reply to the text message (2026-07-17追加)', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({
      reply: '今どんなことに困っていますか？',
      book: false,
      escalate: false,
      quickReplies: ['予約対応', '発信', 'その他'],
    });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '今どんなことに困っていますか？' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '今どんなことに困っていますか？' });

    const { replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      {
        type: 'text',
        text: '今どんなことに困っていますか？',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '予約対応', text: '予約対応' } },
            { type: 'action', action: { type: 'message', label: '発信', text: '発信' } },
            { type: 'action', action: { type: 'message', label: 'その他', text: 'その他' } },
          ],
        },
      },
    ]);
  });

  test('gate open + backend returns book=true + quickReplies: AI自身の選択肢と「無料相談を予約する」ボタンが同じテキストメッセージに並んで添付される（2026-07-17 STEP1で仕様変更・Flexは出さない）', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({
      reply: '空いている日時をお伝えしますね',
      book: true,
      escalate: false,
      quickReplies: ['やっぱり検討します'],
    });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '空いている日時をお伝えしますね' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '空いている日時をお伝えしますね' });

    const { replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    expect(fetchBookingSlots).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      {
        type: 'text',
        text: '空いている日時をお伝えしますね',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: 'やっぱり検討します', text: 'やっぱり検討します' } },
            { type: 'action', action: { type: 'message', label: '無料相談を予約する', text: '無料相談を予約する' } },
          ],
        },
      },
    ]);
  });

  test('gate open + backend success without quickReplies and book=false: falls back to the default 3-item quick reply (2026-07-17 毎ターン常時表示化)', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({ reply: 'Webと同じトーンの返信です', book: false, escalate: false });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: 'Webと同じトーンの返信です' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'Webと同じトーンの返信です' });

    const { replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    // satoyama側がquickReplies無し・book=falseを返しても、Harness側の構造フォールバック
    // （resolveQuickReplyOptions）により、LINE画面には必ず何かタップできるボタンが付く。
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      {
        type: 'text',
        text: 'Webと同じトーンの返信です',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: 'もっと詳しく', text: 'もっと詳しく' } },
            { type: 'action', action: { type: 'message', label: '別のことを相談する', text: '別のことを相談する' } },
            { type: 'action', action: { type: 'message', label: '無料相談を予約する', text: '無料相談を予約する' } },
          ],
        },
      },
    ]);
  });

  test('gate open + backend returns book=true without quickReplies: falls back to booking button only, no duplicate default items (2026-07-17追加)', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({ reply: '個別に設計した方が良さそうです', book: true, escalate: false });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '個別に設計した方が良さそうです' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '個別に設計した方が良さそうです' });

    const { replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    // book=trueの場合は「無料相談を予約する」ボタンが既に非空を作るため、
    // デフォルト3件フォールバックには落ちない（もっと詳しく／別のことを相談するは付かない）。
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      {
        type: 'text',
        text: '個別に設計した方が良さそうです',
        quickReply: {
          items: [{ type: 'action', action: { type: 'message', label: '無料相談を予約する', text: '無料相談を予約する' } }],
        },
      },
    ]);
  });

  test('CHAT_PARITY_ENABLED="all" gate — a user not in CHAT_PARITY_TEST_USER_IDS still gets the new flow', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({ reply: '全開放後の返信', book: false, escalate: false });
    vi.mocked(buildMessage).mockReturnValue({ type: 'text', text: '全開放後の返信' });
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: '全開放後の返信' });

    await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_ENABLED: 'all',
    });

    expect(isChatParityEnabled).toHaveBeenCalledWith(
      'U-parity-1',
      expect.objectContaining({ testUserIds: undefined, parityEnabled: 'all' }),
    );
    expect(invokeLLM).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — chat booking flow (会話中のセッション)', () => {
  const bookingFriend = {
    id: 'friend-booking-1',
    line_user_id: 'U-booking-1',
    display_name: 'Booking Flow Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-01T00:00:00.000+09:00',
    updated_at: '2026-07-01T00:00:00.000+09:00',
  };

  function makeStmt() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  function makeEvent(text: string, replyToken: string) {
    return {
      type: 'message',
      replyToken,
      message: { type: 'text', id: 'message-booking-1', text },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-booking-1' },
      webhookEventId: 'event-booking-1',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    };
  }

  async function postBookingStep(text: string, envOverrides: Record<string, unknown> = {}) {
    const replyToken = 'reply-token-booking';
    const stmt = makeStmt();
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': validShapedSignature },
        body: JSON.stringify({ destination: 'bot', events: [makeEvent(text, replyToken)] }),
      },
      {
        ...baseEnv,
        DB: db,
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        ...envOverrides,
      },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    return { res, db, stmt, replyToken };
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(
      bookingFriend as unknown as Awaited<ReturnType<typeof getFriendByLineUserId>>,
    );
    vi.mocked(jstNow).mockReturnValue('2026-07-01T12:00:00.000+09:00');
    vi.mocked(buildMessage).mockImplementation((type, content) => ({ type, text: content } as never));
    vi.mocked(messageToLogPayload).mockImplementation((m) => ({ messageType: (m as { type: string }).type, content: 'x' }));
  });

  test('awaiting_name: saves the name and asks for email — never touches auto_replies/Gemini/chat backend', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_name',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });

    const { res, replyToken } = await postBookingStep('山田太郎');

    expect(res.status).toBe(200);
    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1', {
      state: 'awaiting_email',
      name: '山田太郎',
    });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ type: 'text' }),
    ]);
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(invokeChatBackend).not.toHaveBeenCalled();
  });

  test('awaiting_name: rejects an empty name and re-prompts without advancing the session', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_name',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });

    await postBookingStep('   ');

    expect(upsertChatBookingSession).not.toHaveBeenCalled();
  });

  test('awaiting_email: "なし" is treated as no-email and submitBooking is called with email:undefined', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_email',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: '山田太郎',
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(submitBooking).mockResolvedValue({
      success: true,
      reservationId: 42,
      start: '2026-08-01T01:00:00.000Z',
      end: '2026-08-01T01:30:00.000Z',
      meetLink: 'https://meet.google.com/abc-defg-hij',
    });

    await postBookingStep('なし');

    expect(submitBooking).toHaveBeenCalledWith({
      backendUrl: 'https://backend.example',
      backendSecret: 'secret',
      start: '2026-08-01T01:00:00.000Z',
      name: '山田太郎',
      email: undefined,
      lineUserId: 'U-booking-1',
    });
    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1');
  });

  test('awaiting_email: a real address is passed through to submitBooking as email', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_email',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: '山田太郎',
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(submitBooking).mockResolvedValue({
      success: true,
      reservationId: 42,
      start: '2026-08-01T01:00:00.000Z',
      end: '2026-08-01T01:30:00.000Z',
    });

    await postBookingStep('yamada@example.com');

    expect(submitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'yamada@example.com' }),
    );
  });

  test('awaiting_email: 409 slot_taken re-fetches slots and returns to awaiting_slot_selection while keeping the name', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_email',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: '山田太郎',
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(submitBooking).mockResolvedValue({ success: false, code: 'slot_taken' });
    vi.mocked(fetchBookingSlots).mockResolvedValue({
      ok: true,
      slots: [{ start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' }],
    });
    vi.mocked(groupSlotsByJstDay).mockReturnValue([
      {
        dateKey: '2026-08-02',
        label: '8/2(日)',
        slots: [{ start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' }],
      },
    ]);

    await postBookingStep('なし');

    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1', {
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
    });
    expect(clearChatBookingSession).not.toHaveBeenCalled();
  });

  test('awaiting_email: not_configured (503) clears the session and tells the user booking is paused', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_email',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: '山田太郎',
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(submitBooking).mockResolvedValue({ success: false, code: 'not_configured' });

    const { replyToken } = await postBookingStep('なし');

    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1');
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ text: expect.stringContaining('停止しております') }),
    ]);
  });

  test('reset command "最初から" clears the session regardless of state', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });

    await postBookingStep('最初から');

    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1');
    expect(upsertChatBookingSession).not.toHaveBeenCalled();
  });

  // 2026-07-17 実機バグ再現テスト（受け入れテスト①）: 予約枠選択中(awaiting_slot_selection)
  // に「リセット」と送っても無視され、「上に表示された候補から…」に吸われていた。
  // 「最初から」と同じ完全リセットとして扱われることを検証する。
  test('reset command "リセット" (not just "最初から") clears the session from awaiting_slot_selection — regression: 実機バグ', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(invokeChatBackend).mockResolvedValue({
      reply: 'かしこまりました。これまでの会話内容をリセットしました。最初からご相談どうぞ。',
      book: false,
      escalate: false,
    });

    const { replyToken } = await postBookingStep('リセット');

    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1');
    expect(upsertChatBookingSession).not.toHaveBeenCalled();
    // 予約の入力を最初からやり直す旨の定型文で、必ずreplyTokenを消費する
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ text: expect.stringContaining('最初からやり直します') }),
    ]);
  });

  // 受け入れテスト①の後半: 「リセット」「最初から」等の完全リセットは、予約サブフロー
  // だけでなくAI相談の会話記憶（satoyama側 conversationsテーブル）もクリアする必要がある。
  // ここではHarness側が invokeChatBackend() 経由でリセット文言をベストエフォート転送する
  // ことだけを検証する（実際のconversationsクリア自体はsatoyama側の責務・別リポジトリ）。
  test('full reset ("リセット"/"最初から") forwards the reset text to the AI backend so satoyama-side conversation memory clears too', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_email',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: '山田太郎',
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(invokeChatBackend).mockResolvedValue({
      reply: 'かしこまりました。これまでの会話内容をリセットしました。最初からご相談どうぞ。',
      book: false,
      escalate: false,
    });

    await postBookingStep('リセット');

    expect(invokeChatBackend).toHaveBeenCalledWith({
      backendUrl: 'https://backend.example',
      backendSecret: 'secret',
      lineUserId: 'U-booking-1',
      message: 'リセット',
    });
  });

  // 「キャンセル」は予約サブフローだけを取り消す表現であり、AI相談の会話記憶までは
  // 消さない（意味が異なる：予約をやめたいだけで、それまでのAI相談内容を消したい
  // わけではない）。invokeChatBackendは呼ばれないことを検証する。
  test('"キャンセル" clears only the booking session, does NOT forward to the AI backend (会話記憶は残す)', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });

    await postBookingStep('キャンセル');

    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1');
    expect(invokeChatBackend).not.toHaveBeenCalled();
  });

  // ベストエフォート性の検証: バックエンド呼び出しが失敗しても、予約フロー向けの
  // ローカルなリプライ（replyToken消費）は必ず届く。
  test('full reset still replies to the user even if the best-effort AI backend reset call throws', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });
    vi.mocked(invokeChatBackend).mockRejectedValue(new Error('chat backend error: 500 Internal Server Error'));

    const { res, replyToken } = await postBookingStep('リセット');

    expect(res.status).toBe(200);
    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-booking-1');
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ text: expect.stringContaining('最初からやり直します') }),
    ]);
  });

  test('awaiting_slot_selection + unrelated free text: reminds the user to tap a button, does not advance state', async () => {
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-booking-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: null,
      updatedAt: '2026-07-01T12:00:00.000',
    });

    await postBookingStep('こんにちは');

    expect(upsertChatBookingSession).not.toHaveBeenCalled();
    expect(clearChatBookingSession).not.toHaveBeenCalled();
    expect(submitBooking).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — chat booking slot selection (postback)', () => {
  const slotFriend = {
    id: 'friend-slot-1',
    line_user_id: 'U-slot-1',
    display_name: 'Slot Select Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-01T00:00:00.000+09:00',
    updated_at: '2026-07-01T00:00:00.000+09:00',
  };

  function makeStmt() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  function makePostbackEvent(data: string, replyToken: string) {
    return {
      type: 'postback',
      replyToken,
      postback: { data },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-slot-1' },
      webhookEventId: 'event-slot-1',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    };
  }

  async function postSlotSelection(data: string) {
    const replyToken = 'reply-token-slot';
    const stmt = makeStmt();
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': validShapedSignature },
        body: JSON.stringify({ destination: 'bot', events: [makePostbackEvent(data, replyToken)] }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    return { res, db, stmt, replyToken };
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(
      slotFriend as unknown as Awaited<ReturnType<typeof getFriendByLineUserId>>,
    );
    vi.mocked(jstNow).mockReturnValue('2026-07-01T12:00:00.000+09:00');
    vi.mocked(buildMessage).mockImplementation((type, content) => ({ type, text: content } as never));
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'x' });
  });

  test('unrelated postback data (parseSlotPostbackData → null) falls through to normal auto_replies handling', async () => {
    vi.mocked(parseSlotPostbackData).mockReturnValue(null);

    const { res } = await postSlotSelection('コスト比較');

    expect(res.status).toBe(200);
    expect(getChatBookingSession).not.toHaveBeenCalled();
  });

  test('slot postback with no existing session (fresh flow): asks for name', async () => {
    vi.mocked(parseSlotPostbackData).mockReturnValue({
      start: '2026-08-01T01:00:00.000Z',
      end: '2026-08-01T01:30:00.000Z',
    });
    vi.mocked(getChatBookingSession).mockResolvedValue(null);

    const { res, replyToken } = await postSlotSelection('CHATBOOK_SLOT:2026-08-01T01:00:00.000Z|2026-08-01T01:30:00.000Z');

    expect(res.status).toBe(200);
    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-slot-1', {
      state: 'awaiting_name',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
    });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [expect.objectContaining({ type: 'text' })]);
  });

  test('slot postback with a session that already has a name (409 re-selection): skips straight to email', async () => {
    vi.mocked(parseSlotPostbackData).mockReturnValue({
      start: '2026-08-02T01:00:00.000Z',
      end: '2026-08-02T01:30:00.000Z',
    });
    vi.mocked(getChatBookingSession).mockResolvedValue({
      friendId: 'friend-slot-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: '山田太郎',
      updatedAt: '2026-07-01T12:00:00.000',
    });

    await postSlotSelection('CHATBOOK_SLOT:2026-08-02T01:00:00.000Z|2026-08-02T01:30:00.000Z');

    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-slot-1', {
      state: 'awaiting_email',
      selectedStart: '2026-08-02T01:00:00.000Z',
      selectedEnd: '2026-08-02T01:30:00.000Z',
    });
  });
});

describe('POST /webhook — chat booking day selection (postback)', () => {
  const dayFriend = {
    id: 'friend-day-1',
    line_user_id: 'U-day-1',
    display_name: 'Day Select Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-01T00:00:00.000+09:00',
    updated_at: '2026-07-01T00:00:00.000+09:00',
  };

  function makeStmt() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  function makePostbackEvent(data: string, replyToken: string) {
    return {
      type: 'postback',
      replyToken,
      postback: { data },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-day-1' },
      webhookEventId: 'event-day-1',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    };
  }

  async function postDaySelection(data: string, envOverrides: Record<string, unknown> = {}) {
    const replyToken = 'reply-token-day';
    const stmt = makeStmt();
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': validShapedSignature },
        body: JSON.stringify({ destination: 'bot', events: [makePostbackEvent(data, replyToken)] }),
      },
      {
        ...baseEnv,
        DB: db,
        CHAT_BACKEND_URL: 'https://backend.example',
        CHAT_BACKEND_SECRET: 'secret',
        ...envOverrides,
      },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    return { res, db, stmt, replyToken };
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(
      dayFriend as unknown as Awaited<ReturnType<typeof getFriendByLineUserId>>,
    );
    vi.mocked(jstNow).mockReturnValue('2026-07-01T12:00:00.000+09:00');
    vi.mocked(buildMessage).mockImplementation((type, content) => ({ type, text: content } as never));
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'x' });
  });

  test('unrelated postback data (parseDayPostbackData → null) does not touch day-selection handling', async () => {
    vi.mocked(parseDayPostbackData).mockReturnValue(null);
    vi.mocked(parseSlotPostbackData).mockReturnValue(null);

    const { res } = await postDaySelection('コスト比較');

    expect(res.status).toBe(200);
    expect(fetchBookingSlots).not.toHaveBeenCalled();
  });

  test('day postback with slots available for that day: shows the time picker for that day and keeps awaiting_slot_selection', async () => {
    vi.mocked(parseDayPostbackData).mockReturnValue('2026-08-01');
    vi.mocked(fetchBookingSlots).mockResolvedValue({
      ok: true,
      slots: [
        { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' },
        { start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' },
      ],
    });
    vi.mocked(filterSlotsByJstDay).mockReturnValue([
      { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' },
    ]);

    const { res, replyToken } = await postDaySelection('CHATBOOK_DAY:2026-08-01');

    expect(res.status).toBe(200);
    expect(fetchBookingSlots).toHaveBeenCalledWith({ backendUrl: 'https://backend.example', backendSecret: 'secret' });
    expect(filterSlotsByJstDay).toHaveBeenCalledWith(
      [
        { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' },
        { start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' },
      ],
      '2026-08-01',
    );
    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-day-1', {
      state: 'awaiting_slot_selection',
    });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [expect.objectContaining({ type: 'flex' })]);
  });

  test('day postback but that day is now fully booked (race): falls back to a fresh day picker', async () => {
    vi.mocked(parseDayPostbackData).mockReturnValue('2026-08-01');
    vi.mocked(fetchBookingSlots).mockResolvedValue({
      ok: true,
      slots: [{ start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' }],
    });
    vi.mocked(filterSlotsByJstDay).mockReturnValue([]);
    vi.mocked(groupSlotsByJstDay).mockReturnValue([
      {
        dateKey: '2026-08-02',
        label: '8/2(日)',
        slots: [{ start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' }],
      },
    ]);

    const { res, replyToken } = await postDaySelection('CHATBOOK_DAY:2026-08-01');

    expect(res.status).toBe(200);
    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-day-1', {
      state: 'awaiting_slot_selection',
    });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'flex' }),
    ]);
    expect(clearChatBookingSession).not.toHaveBeenCalled();
  });

  test('day postback but slots fetch fails entirely: clears the session and asks to restart', async () => {
    vi.mocked(parseDayPostbackData).mockReturnValue('2026-08-01');
    vi.mocked(fetchBookingSlots).mockResolvedValue({ ok: false, reason: 'fetch_failed' });

    const { res, replyToken } = await postDaySelection('CHATBOOK_DAY:2026-08-01');

    expect(res.status).toBe(200);
    expect(clearChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-day-1');
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [expect.objectContaining({ type: 'text' })]);
  });

  test('day postback but backend not configured: tells the user booking is temporarily unavailable', async () => {
    vi.mocked(parseDayPostbackData).mockReturnValue('2026-08-01');

    const { res, replyToken } = await postDaySelection('CHATBOOK_DAY:2026-08-01', {
      CHAT_BACKEND_URL: undefined,
      CHAT_BACKEND_SECRET: undefined,
    });

    expect(res.status).toBe(200);
    expect(fetchBookingSlots).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [expect.objectContaining({ type: 'text' })]);
  });
});

describe('POST /webhook — owner command ("管理画面")', () => {
  const ownerFriend = {
    id: 'friend-owner-1',
    line_user_id: 'U-owner-1',
    display_name: 'ryosuke.ina',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-01T00:00:00.000+09:00',
    updated_at: '2026-07-01T00:00:00.000+09:00',
  };

  function makeStmt() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  function makeEvent(userId: string, text: string, replyToken = 'reply-token-owner') {
    return {
      type: 'message',
      replyToken,
      message: { type: 'text', id: 'message-owner-1', text },
      timestamp: Date.now(),
      source: { type: 'user', userId },
      webhookEventId: 'event-owner-1',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    };
  }

  async function postOwnerMessage(
    userId: string,
    text: string,
    envOverrides: Record<string, unknown>,
  ) {
    const replyToken = 'reply-token-owner';
    const stmt = makeStmt();
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({ destination: 'bot', events: [makeEvent(userId, text, replyToken)] }),
      },
      { ...baseEnv, DB: db, ...envOverrides },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    return { res, db, stmt, replyToken };
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(
      ownerFriend as unknown as Awaited<ReturnType<typeof getFriendByLineUserId>>,
    );
    vi.mocked(jstNow).mockReturnValue('2026-07-17T09:00:00.000+09:00');
    vi.mocked(buildMessage).mockImplementation(
      (messageType: string, content: string) => ({ type: messageType, text: content }) as never,
    );
  });

  test('owner sending the exact keyword without CHAT_BACKEND_URL/SECRET configured falls back to the static admin URL + external-browser notice, and does not reach fireEvent/AI', async () => {
    // "管理画面" は動的コマンド（services/adminMagicLink.ts が SATOYAMA 側の magic link
    // 発行APIを叩く）。CHAT_BACKEND_URL/SECRET 未設定時は発行APIを呼ばずフォールバック文言
    // を返す（requestAdminMagicLinkUrl の早期return・fetchは呼ばれない）。
    const { res, replyToken } = await postOwnerMessage('U-owner-1', '管理画面', {
      OWNER_LINE_USER_IDS: 'U-owner-1',
    });

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      {
        type: 'text',
        text: 'https://satoyama-ai-base.vercel.app/admin?openExternalBrowser=1\n\n※LINE内で開けない場合は、外部ブラウザ（Safari/Chrome等）で開いてログインしてください。',
      },
    ]);
    // Short-circuits before the normal message pipeline (no unread/AI-consultation side effects).
    expect(fireEvent).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  test('owner sending the exact keyword with CHAT_BACKEND_URL/SECRET configured returns the one-time magic link URL from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ url: 'https://satoyama-ai-base.vercel.app/admin-login?token=one-time-token' }),
      } as unknown as Response),
    );

    try {
      const { res, replyToken, stmt } = await postOwnerMessage('U-owner-1', '管理画面', {
        OWNER_LINE_USER_IDS: 'U-owner-1',
        CHAT_BACKEND_URL: 'https://satoyama-ai-base.vercel.app',
        CHAT_BACKEND_SECRET: 'shared-secret',
      });

      expect(res.status).toBe(200);
      expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
        { type: 'text', text: 'https://satoyama-ai-base.vercel.app/admin-login?token=one-time-token&openExternalBrowser=1' },
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(String(url)).toBe('https://satoyama-ai-base.vercel.app/api/admin/magic-link');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer shared-secret');
      expect(fireEvent).not.toHaveBeenCalled();

      // messages_log（会話履歴の監査ログ）にはトークン入りURLをそのまま残さない
      // （services/adminMagicLink.ts redactAdminMagicLinkForLog）。
      const lastBindArgs = stmt.bind.mock.calls[stmt.bind.mock.calls.length - 1];
      const loggedContent = lastBindArgs?.[2];
      expect(loggedContent).toBe('https://satoyama-ai-base.vercel.app/admin-login?token=[REDACTED]');
      expect(loggedContent).not.toContain('one-time-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('owner sending the exact keyword with backend configured but failing falls back to the static URL notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    try {
      const { res, replyToken } = await postOwnerMessage('U-owner-1', '管理画面', {
        OWNER_LINE_USER_IDS: 'U-owner-1',
        CHAT_BACKEND_URL: 'https://satoyama-ai-base.vercel.app',
        CHAT_BACKEND_SECRET: 'shared-secret',
      });

      expect(res.status).toBe(200);
      expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
        {
          type: 'text',
          text: 'https://satoyama-ai-base.vercel.app/admin?openExternalBrowser=1\n\n※LINE内で開けない場合は、外部ブラウザ（Safari/Chrome等）で開いてログインしてください。',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('owner sending a non-command message falls through to normal handling (no reply from owner-command layer)', async () => {
    const { res } = await postOwnerMessage('U-owner-1', 'こんにちは', {
      OWNER_LINE_USER_IDS: 'U-owner-1',
    });

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  test('non-owner sending the exact keyword gets no special reply — command existence is not leaked', async () => {
    const { res } = await postOwnerMessage('U-stranger', '管理画面', {
      OWNER_LINE_USER_IDS: 'U-owner-1',
    });

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    // Falls through to the normal pipeline exactly like any other unmatched text.
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  test('OWNER_LINE_USER_IDS unset: even the configured keyword gets no owner-command reply (safe default)', async () => {
    const { res } = await postOwnerMessage('U-owner-1', '管理画面', {});

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });
});
