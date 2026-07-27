import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/liff-auth.js', () => ({
  verifyLiffAccountCaller: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return {
    ...actual,
    getSatoyamaOnboardingState: vi.fn(),
    markSatoyamaOnboardingBonusOpened: vi.fn(),
    markSatoyamaOnboardingCtaClicked: vi.fn(),
    markSatoyamaOnboardingQuestionsStarted: vi.fn(),
    saveSatoyamaOnboardingAnswers: vi.fn(),
    skipSatoyamaOnboarding: vi.fn(),
  };
});

import {
  SatoyamaOnboardingIdempotencyConflict,
  SatoyamaOnboardingRateLimitExceeded,
  getSatoyamaOnboardingState,
  markSatoyamaOnboardingCtaClicked,
  markSatoyamaOnboardingQuestionsStarted,
  saveSatoyamaOnboardingAnswers,
} from '@line-crm/db';
import { verifyLiffAccountCaller } from '../services/liff-auth.js';
import { satoyamaOnboarding } from './satoyama-onboarding.js';

const completedState = {
  line_account_id: 'account-satoyama',
  friend_id: 'friend-from-verified-token',
  program_version: 1,
  status: 'completed',
  issue_code: 'handoff',
  role_code: 'internal_lead',
  area_code: 'admin',
  common_bonus_opened_at: null,
  questions_started_at: '2026-07-26T11:59:00.000+09:00',
  issue_bonus_opened_at: null,
  cta_clicked_at: null,
  reminder_due_at: null,
  reminder_claimed_at: null,
  reminder_sent_at: null,
  reminder_cancelled_at: '2026-07-26T12:00:00.000+09:00',
  reminder_attempts: 0,
  reminder_error_code: null,
  completed_at: '2026-07-26T12:00:00.000+09:00',
  created_at: '2026-07-26T12:00:00.000+09:00',
  updated_at: '2026-07-26T12:00:00.000+09:00',
} as const;

function friendDb(isFollowing = 1): D1Database {
  const statement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue({
      id: 'friend-from-verified-token',
      is_following: isFollowing,
      line_account_id: 'account-satoyama',
    }),
  };
  statement.bind.mockReturnValue(statement);
  return { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database;
}

function setup() {
  const app = new Hono();
  app.route('/', satoyamaOnboarding);
  return app;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: friendDb(),
    SATOYAMA_ONBOARDING_ENABLED: 'true',
    SATOYAMA_ONBOARDING_ACCOUNT_ID: 'account-satoyama',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyLiffAccountCaller).mockResolvedValue({
    ok: true,
    lineUserId: 'U-verified',
    accountId: 'account-satoyama',
    liffId: '123456-test',
  });
  vi.mocked(getSatoyamaOnboardingState).mockResolvedValue(null);
  vi.mocked(saveSatoyamaOnboardingAnswers).mockResolvedValue({
    state: completedState,
    idempotentReplay: false,
  });
  vi.mocked(markSatoyamaOnboardingQuestionsStarted).mockResolvedValue({
    ...completedState,
    status: 'started',
    completed_at: null,
  });
  vi.mocked(markSatoyamaOnboardingCtaClicked).mockResolvedValue({
    ...completedState,
    cta_clicked_at: '2026-07-26T12:01:00.000+09:00',
  });
});

describe('SATOYAMA onboarding routes', () => {
  it('is fail-closed until one account is explicitly enabled', async () => {
    const response = await setup().request(
      '/api/liff/onboarding/satoyama?liffId=123456-test',
      { headers: { Authorization: 'Bearer token' } },
      {
        DB: friendDb(),
        SATOYAMA_ONBOARDING_ENABLED: 'false',
        SATOYAMA_ONBOARDING_ACCOUNT_ID: 'account-satoyama',
      },
    );
    expect(response.status).toBe(404);
    expect(verifyLiffAccountCaller).not.toHaveBeenCalled();
  });

  it('rejects a valid token from a different LIFF account', async () => {
    const db = friendDb();
    vi.mocked(verifyLiffAccountCaller).mockResolvedValue({
      ok: true,
      lineUserId: 'U-other',
      accountId: 'account-other',
      liffId: '999999-other',
    });
    const response = await setup().request(
      '/api/liff/onboarding/satoyama?liffId=999999-other',
      { headers: { Authorization: 'Bearer token' } },
      env({ DB: db }),
    );
    expect(response.status).toBe(404);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('returns a retryable 503 when LINE token verification times out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyLiffAccountCaller).mockResolvedValue({
      ok: false,
      reason: 'verification_timeout',
    });

    const response = await setup().request(
      '/api/liff/onboarding/satoyama?liffId=123456-test',
      { headers: { Authorization: 'Bearer token' } },
      env(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Authentication unavailable',
    });
  });

  it('returns an optional three-question program without requiring admin CSRF cookies', async () => {
    const response = await setup().request(
      '/api/liff/onboarding/satoyama?liffId=123456-test',
      { headers: { Authorization: 'Bearer token' } },
      env(),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { program: { questions: unknown[]; commonBonus: { templates: unknown[] } } };
    };
    expect(body.data.program.questions).toHaveLength(3);
    expect(body.data.program.commonBonus.templates).toHaveLength(3);
  });

  it('tracks question start and explicit CTA without accepting client identity fields', async () => {
    const app = setup();
    const requestEnv = env();
    const headers = {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    };
    const started = await app.request(
      '/api/liff/onboarding/satoyama/questions/started?liffId=123456-test',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lineAccountId: 'attacker-account',
          friendId: 'attacker-friend',
        }),
      },
      requestEnv,
    );
    expect(started.status).toBe(200);
    expect(markSatoyamaOnboardingQuestionsStarted).toHaveBeenCalledWith(
      requestEnv.DB,
      expect.objectContaining({
        lineAccountId: 'account-satoyama',
        friendId: 'friend-from-verified-token',
      }),
    );

    const clicked = await app.request(
      '/api/liff/onboarding/satoyama/cta/clicked?liffId=123456-test',
      { method: 'POST', headers },
      requestEnv,
    );
    expect(clicked.status).toBe(200);
    expect(markSatoyamaOnboardingCtaClicked).toHaveBeenCalledWith(
      requestEnv.DB,
      expect.objectContaining({
        lineAccountId: 'account-satoyama',
        friendId: 'friend-from-verified-token',
      }),
    );
  });

  it('uses only the verified friend and ignores client-supplied identity fields', async () => {
    const response = await setup().request(
      '/api/liff/onboarding/satoyama/submit?liffId=123456-test',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          issue: 'handoff',
          role: 'internal_lead',
          area: 'admin',
          idempotencyKey: 'idem-000000000100',
          lineUserId: 'U-attacker-controlled',
          friendId: 'friend-attacker-controlled',
        }),
      },
      env(),
    );
    expect(response.status).toBe(200);
    expect(saveSatoyamaOnboardingAnswers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lineAccountId: 'account-satoyama',
        friendId: 'friend-from-verified-token',
        answers: {
          issue: 'handoff',
          role: 'internal_lead',
          area: 'admin',
        },
      }),
    );
    const body = await response.json() as {
      data: { outcome: { cta: { message: string } } };
    };
    expect(body.data.outcome.cta.message).not.toMatch(/無料相談|予約/);
  });

  it('rejects unknown enum values before touching profile or tags', async () => {
    const response = await setup().request(
      '/api/liff/onboarding/satoyama/submit?liffId=123456-test',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          issue: 'made_up',
          role: 'owner',
          area: 'admin',
          idempotencyKey: 'idem-000000000101',
        }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    expect(saveSatoyamaOnboardingAnswers).not.toHaveBeenCalled();
  });

  it('maps idempotency key reuse with different answers to 409', async () => {
    vi.mocked(saveSatoyamaOnboardingAnswers).mockRejectedValue(
      new SatoyamaOnboardingIdempotencyConflict(),
    );
    const response = await setup().request(
      '/api/liff/onboarding/satoyama/submit?liffId=123456-test',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          issue: 'handoff',
          role: 'owner',
          area: 'admin',
          idempotencyKey: 'idem-000000000102',
        }),
      },
      env(),
    );
    expect(response.status).toBe(409);
  });

  it('maps the persistent answer submission limit to 429 without logging a server failure', async () => {
    vi.mocked(saveSatoyamaOnboardingAnswers).mockRejectedValue(
      new SatoyamaOnboardingRateLimitExceeded(),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await setup().request(
      '/api/liff/onboarding/satoyama/submit?liffId=123456-test',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          issue: 'handoff',
          role: 'owner',
          area: 'admin',
          idempotencyKey: 'idem-000000000104',
        }),
      },
      env(),
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'rate_limited',
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not write onboarding data after unfollow', async () => {
    const response = await setup().request(
      '/api/liff/onboarding/satoyama/submit?liffId=123456-test',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          issue: 'handoff',
          role: 'owner',
          area: 'admin',
          idempotencyKey: 'idem-000000000103',
        }),
      },
      env({ DB: friendDb(0) }),
    );
    expect(response.status).toBe(409);
    expect(saveSatoyamaOnboardingAnswers).not.toHaveBeenCalled();
  });
});
