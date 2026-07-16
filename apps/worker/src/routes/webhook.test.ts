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
vi.mock('../services/chatBackend.js', () => ({
  isChatParityEnabled: vi.fn().mockReturnValue(false),
  invokeChatBackend: vi.fn(),
  fetchBookingSlots: vi.fn(),
  submitBooking: vi.fn(),
  formatSlotLabel: vi.fn((iso: string) => `label(${iso})`),
  buildSlotPickerFlexContents: vi.fn().mockReturnValue({ type: 'bubble' }),
  parseSlotPostbackData: vi.fn().mockReturnValue(null),
}));

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

  async function postParity(envOverrides: Record<string, unknown>, text = '無料相談を予約したい') {
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
      message: '無料相談を予約したい',
    });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: 'Webと同じトーンの返信です' },
    ]);
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(fetchBookingSlots).not.toHaveBeenCalled();
  });

  test('gate open + backend success + book=true + slots available: sends reply text + slot picker flex, and opens a booking session', async () => {
    vi.mocked(isChatParityEnabled).mockReturnValue(true);
    vi.mocked(invokeChatBackend).mockResolvedValue({ reply: '空いている日時をお伝えしますね', book: true, escalate: false });
    vi.mocked(fetchBookingSlots).mockResolvedValue({
      ok: true,
      slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }],
    });
    vi.mocked(buildMessage).mockImplementation((type) =>
      type === 'flex' ? { type: 'flex', altText: 'x', contents: {} } : { type: 'text', text: '空いている日時をお伝えしますね' },
    );
    vi.mocked(messageToLogPayload).mockReturnValue({ messageType: 'text', content: 'x' });

    const { res, replyToken } = await postParity({
      GEMINI_API_KEY: 'test-gemini-key',
      CHAT_BACKEND_URL: 'https://backend.example',
      CHAT_BACKEND_SECRET: 'secret',
      CHAT_PARITY_TEST_USER_IDS: 'U-parity-1',
    });

    expect(res.status).toBe(200);
    expect(fetchBookingSlots).toHaveBeenCalledWith({ backendUrl: 'https://backend.example', backendSecret: 'secret' });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: '空いている日時をお伝えしますね' },
      { type: 'flex', altText: 'x', contents: {} },
    ]);
    expect(upsertChatBookingSession).toHaveBeenCalledWith(expect.anything(), 'friend-parity-1', {
      state: 'awaiting_slot_selection',
    });
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

  test('owner sending the exact keyword gets the admin URL via replyMessage, and does not reach fireEvent/AI', async () => {
    const { res, replyToken } = await postOwnerMessage('U-owner-1', '管理画面', {
      OWNER_LINE_USER_IDS: 'U-owner-1',
    });

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(replyToken, [
      { type: 'text', text: 'https://satoyama-ai-base.vercel.app/admin' },
    ]);
    // Short-circuits before the normal message pipeline (no unread/AI-consultation side effects).
    expect(fireEvent).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
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
