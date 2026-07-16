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
