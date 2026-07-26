import { Hono, type Context } from 'hono';
import {
  getSatoyamaOnboardingState,
  markSatoyamaOnboardingBonusOpened,
  markSatoyamaOnboardingCtaClicked,
  markSatoyamaOnboardingQuestionsStarted,
  SatoyamaOnboardingIdempotencyConflict,
  SatoyamaOnboardingRateLimitExceeded,
  saveSatoyamaOnboardingAnswers,
  skipSatoyamaOnboarding,
  toJstString,
  type Friend,
  type SatoyamaOnboardingState,
} from '@line-crm/db';
import type { Env } from '../index.js';
import {
  SATOYAMA_ONBOARDING_TAGS,
  buildSatoyamaOnboardingOutcome,
  isSatoyamaAreaCode,
  isSatoyamaIssueCode,
  isSatoyamaRoleCode,
  publicSatoyamaOnboardingContent,
} from '../features/satoyama-onboarding/content.js';
import { verifyLiffAccountCaller } from '../services/liff-auth.js';
import { configuredSatoyamaAccountId } from '../services/satoyama-onboarding-reminder.js';

const satoyamaOnboarding = new Hono<Env>();

interface AuthenticatedOnboardingCaller {
  lineAccountId: string;
  friend: Pick<Friend, 'id' | 'is_following' | 'line_account_id'>;
}

type CallerResult =
  | { ok: true; caller: AuthenticatedOnboardingCaller }
  | { ok: false; response: Response };

async function authenticateCaller(c: Context<Env>): Promise<CallerResult> {
  const configuredAccountId = configuredSatoyamaAccountId(c.env);
  if (!configuredAccountId) {
    return { ok: false, response: c.json({ success: false, error: 'Not found' }, 404) };
  }

  const verified = await verifyLiffAccountCaller(
    c.req.header('Authorization'),
    c.req.query('liffId'),
    configuredAccountId,
    c.env,
  );
  if (!verified.ok) {
    if (verified.reason === 'unknown_liff') {
      return { ok: false, response: c.json({ success: false, error: 'Not found' }, 404) };
    }
    if (
      verified.reason === 'login_channel_not_configured' ||
      verified.reason === 'verification_unavailable'
    ) {
      return {
        ok: false,
        response: c.json({ success: false, error: 'Authentication unavailable' }, 503),
      };
    }
    return { ok: false, response: c.json({ success: false, error: 'Unauthorized' }, 401) };
  }

  // The public liffId must resolve to the one explicitly enabled account.
  if (verified.accountId !== configuredAccountId) {
    return { ok: false, response: c.json({ success: false, error: 'Not found' }, 404) };
  }

  const friend = await c.env.DB
    .prepare(
      `SELECT id, is_following, line_account_id
         FROM friends
        WHERE line_user_id = ?
          AND line_account_id = ?`,
    )
    .bind(verified.lineUserId, verified.accountId)
    .first<Pick<Friend, 'id' | 'is_following' | 'line_account_id'>>();
  if (!friend) {
    return { ok: false, response: c.json({ success: false, error: 'Friend not found' }, 404) };
  }

  return {
    ok: true,
    caller: {
      lineAccountId: verified.accountId,
      friend,
    },
  };
}

function serializeState(state: SatoyamaOnboardingState | null) {
  if (!state) return null;
  return {
    status: state.status,
    answers:
      state.issue_code && state.role_code && state.area_code
        ? {
            issue: state.issue_code,
            role: state.role_code,
            area: state.area_code,
          }
        : null,
    commonBonusOpened: Boolean(state.common_bonus_opened_at),
    questionsStarted: Boolean(state.questions_started_at),
    issueBonusOpened: Boolean(state.issue_bonus_opened_at),
    ctaClicked: Boolean(state.cta_clicked_at),
    reminderAttempted: state.reminder_attempts === 1,
    completedAt: state.completed_at,
  };
}

function outcomeFor(state: SatoyamaOnboardingState | null) {
  if (
    !state ||
    state.status !== 'completed' ||
    !state.issue_code ||
    !state.role_code ||
    !state.area_code
  ) {
    return null;
  }
  return buildSatoyamaOnboardingOutcome(
    state.issue_code,
    state.role_code,
    state.area_code,
  );
}

function notFollowing(c: Context<Env>): Response {
  return c.json(
    {
      success: false,
      error: 'not_following',
      message: 'LINE公式アカウントを友だち追加した状態で開いてください。',
    },
    409,
  );
}

// All state-changing endpoints use a verified LINE ID token in the Bearer
// header. They do not accept lineUserId/friendId from the client, and do not
// use cookie auth, so the admin double-submit CSRF mechanism is not involved.
satoyamaOnboarding.get('/api/liff/onboarding/satoyama', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  try {
    const state = await getSatoyamaOnboardingState(
      c.env.DB,
      auth.caller.lineAccountId,
      auth.caller.friend.id,
    );
    return c.json({
      success: true,
      data: {
        program: publicSatoyamaOnboardingContent(),
        state: serializeState(state),
        outcome: outcomeFor(state),
      },
    });
  } catch {
    console.error('[satoyama-onboarding] get failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

satoyamaOnboarding.post('/api/liff/onboarding/satoyama/bonus/common/opened', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  try {
    const state = await markSatoyamaOnboardingBonusOpened(c.env.DB, {
      lineAccountId: auth.caller.lineAccountId,
      friendId: auth.caller.friend.id,
      kind: 'common',
      now: toJstString(new Date()),
    });
    return c.json({ success: true, data: { state: serializeState(state) } });
  } catch {
    console.error('[satoyama-onboarding] common bonus tracking failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

satoyamaOnboarding.post('/api/liff/onboarding/satoyama/questions/started', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  try {
    const state = await markSatoyamaOnboardingQuestionsStarted(c.env.DB, {
      lineAccountId: auth.caller.lineAccountId,
      friendId: auth.caller.friend.id,
      now: toJstString(new Date()),
    });
    return c.json({ success: true, data: { state: serializeState(state) } });
  } catch {
    console.error('[satoyama-onboarding] question start tracking failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

satoyamaOnboarding.post('/api/liff/onboarding/satoyama/submit', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  let body: {
    issue?: unknown;
    role?: unknown;
    area?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  if (
    !isSatoyamaIssueCode(body.issue) ||
    !isSatoyamaRoleCode(body.role) ||
    !isSatoyamaAreaCode(body.area)
  ) {
    return c.json({ success: false, error: 'Invalid answers' }, 400);
  }
  if (
    typeof body.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey)
  ) {
    return c.json({ success: false, error: 'Invalid idempotency key' }, 400);
  }

  try {
    const result = await saveSatoyamaOnboardingAnswers(c.env.DB, {
      lineAccountId: auth.caller.lineAccountId,
      friendId: auth.caller.friend.id,
      answers: {
        issue: body.issue,
        role: body.role,
        area: body.area,
      },
      idempotencyKey: body.idempotencyKey,
      tags: SATOYAMA_ONBOARDING_TAGS,
      now: toJstString(new Date()),
    });
    return c.json({
      success: true,
      data: {
        state: serializeState(result.state),
        outcome: outcomeFor(result.state),
        idempotentReplay: result.idempotentReplay,
      },
    });
  } catch (error) {
    if (error instanceof SatoyamaOnboardingIdempotencyConflict) {
      return c.json({ success: false, error: 'Idempotency conflict' }, 409);
    }
    if (error instanceof SatoyamaOnboardingRateLimitExceeded) {
      return c.json({ success: false, error: 'rate_limited' }, 429);
    }
    console.error('[satoyama-onboarding] submit failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

satoyamaOnboarding.post('/api/liff/onboarding/satoyama/skip', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  try {
    const state = await skipSatoyamaOnboarding(c.env.DB, {
      lineAccountId: auth.caller.lineAccountId,
      friendId: auth.caller.friend.id,
      now: toJstString(new Date()),
    });
    return c.json({ success: true, data: { state: serializeState(state) } });
  } catch {
    console.error('[satoyama-onboarding] skip failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

satoyamaOnboarding.post('/api/liff/onboarding/satoyama/bonus/issue/opened', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  try {
    const state = await markSatoyamaOnboardingBonusOpened(c.env.DB, {
      lineAccountId: auth.caller.lineAccountId,
      friendId: auth.caller.friend.id,
      kind: 'issue',
      now: toJstString(new Date()),
    });
    if (!state || state.status !== 'completed') {
      return c.json({ success: false, error: 'Complete onboarding first' }, 409);
    }
    return c.json({ success: true, data: { state: serializeState(state) } });
  } catch {
    console.error('[satoyama-onboarding] issue bonus tracking failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

satoyamaOnboarding.post('/api/liff/onboarding/satoyama/cta/clicked', async (c) => {
  const auth = await authenticateCaller(c);
  if (!auth.ok) return auth.response;
  if (!auth.caller.friend.is_following) return notFollowing(c);

  try {
    const state = await markSatoyamaOnboardingCtaClicked(c.env.DB, {
      lineAccountId: auth.caller.lineAccountId,
      friendId: auth.caller.friend.id,
      now: toJstString(new Date()),
    });
    if (!state || state.status !== 'completed') {
      return c.json({ success: false, error: 'Complete onboarding first' }, 409);
    }
    return c.json({ success: true, data: { state: serializeState(state) } });
  } catch {
    console.error('[satoyama-onboarding] CTA tracking failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { satoyamaOnboarding };
