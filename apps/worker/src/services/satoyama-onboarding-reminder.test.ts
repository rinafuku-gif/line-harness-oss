import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  followState: vi.fn(),
  due: vi.fn(),
  claim: vi.fn(),
  state: vi.fn(),
  mark: vi.fn(),
}));

const lineMocks = vi.hoisted(() => ({
  pushMessage: vi.fn(),
  LineClient: vi.fn(),
}));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return {
    ...actual,
    scheduleSatoyamaOnboardingReminder: dbMocks.schedule,
    markSatoyamaOnboardingFollowState: dbMocks.followState,
    getDueSatoyamaOnboardingReminders: dbMocks.due,
    claimSatoyamaOnboardingReminder: dbMocks.claim,
    getSatoyamaOnboardingState: dbMocks.state,
    markSatoyamaOnboardingReminderResult: dbMocks.mark,
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: lineMocks.LineClient,
}));

import {
  buildSatoyamaOnboardingLiffUrl,
  cancelFriendOnboardingReminder,
  processSatoyamaOnboardingReminders,
  scheduleFriendOnboardingReminder,
} from './satoyama-onboarding-reminder.js';

const db = {} as D1Database;
const enabledEnv = {
  SATOYAMA_ONBOARDING_ENABLED: 'true',
  SATOYAMA_ONBOARDING_ACCOUNT_ID: 'account-satoyama',
  SATOYAMA_ONBOARDING_REMINDER_ENABLED: 'true',
};

const dueRow = {
  line_account_id: 'account-satoyama',
  friend_id: 'friend-1',
  channel_access_token: 'secret-channel-token',
  liff_id: '1234567890-AbCdEfGh',
  line_user_id: 'U123456789',
};

const pendingState = {
  status: 'pending',
  reminder_cancelled_at: null,
  reminder_sent_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.schedule.mockResolvedValue(undefined);
  dbMocks.followState.mockResolvedValue(undefined);
  dbMocks.due.mockResolvedValue([]);
  dbMocks.claim.mockResolvedValue(false);
  dbMocks.state.mockResolvedValue(pendingState);
  dbMocks.mark.mockResolvedValue(undefined);
  lineMocks.pushMessage.mockResolvedValue(undefined);
  lineMocks.LineClient.mockImplementation(() => ({
    pushMessage: lineMocks.pushMessage,
  }));
});

describe('SATOYAMA onboarding reminder', () => {
  it('schedules exactly 48 hours later only for the explicitly enabled account', async () => {
    const now = new Date('2026-07-26T03:00:00.000Z');
    await scheduleFriendOnboardingReminder(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      env: enabledEnv,
      now,
    });

    expect(dbMocks.followState).toHaveBeenCalledWith(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      isFollowing: true,
      now: '2026-07-26T12:00:00.000+09:00',
    });
    expect(dbMocks.schedule).toHaveBeenCalledWith(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      now: '2026-07-26T12:00:00.000+09:00',
      dueAt: '2026-07-28T12:00:00.000+09:00',
    });

    await scheduleFriendOnboardingReminder(db, {
      lineAccountId: 'account-other',
      friendId: 'friend-2',
      env: enabledEnv,
      now,
    });
    await scheduleFriendOnboardingReminder(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-3',
      env: { ...enabledEnv, SATOYAMA_ONBOARDING_REMINDER_ENABLED: 'false' },
      now,
    });
    expect(dbMocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('cancels only within the configured account boundary', async () => {
    const now = new Date('2026-07-27T03:00:00.000Z');
    await cancelFriendOnboardingReminder(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      env: enabledEnv,
      now,
    });
    expect(dbMocks.followState).toHaveBeenCalledWith(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      isFollowing: false,
      now: '2026-07-27T12:00:00.000+09:00',
    });

    await cancelFriendOnboardingReminder(db, {
      lineAccountId: 'account-other',
      friendId: 'friend-1',
      env: enabledEnv,
      now,
    });
    expect(
      dbMocks.followState.mock.calls.filter(([, input]) => input.isFollowing === false),
    ).toHaveLength(1);
  });

  it('claims once, rechecks state, then sends the optional LIFF reminder', async () => {
    dbMocks.due.mockResolvedValue([dueRow]);
    dbMocks.claim.mockResolvedValue(true);

    const result = await processSatoyamaOnboardingReminders(db, {
      env: enabledEnv,
      now: new Date('2026-07-28T03:00:00.000Z'),
    });

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(lineMocks.LineClient).toHaveBeenCalledWith('secret-channel-token');
    expect(lineMocks.pushMessage).toHaveBeenCalledWith(
      'U123456789',
      [
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(
            'https://liff.line.me/1234567890-AbCdEfGh/onboarding/satoyama?liffId=1234567890-AbCdEfGh',
          ),
        }),
      ],
    );
    expect(lineMocks.pushMessage.mock.calls[0][1][0].text).toContain('回答は任意');
    expect(dbMocks.mark).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        lineAccountId: 'account-satoyama',
        friendId: 'friend-1',
        sent: true,
      }),
    );
  });

  it('does not send after completion wins the race following the claim', async () => {
    dbMocks.due.mockResolvedValue([dueRow]);
    dbMocks.claim.mockResolvedValue(true);
    dbMocks.state.mockResolvedValue({
      ...pendingState,
      status: 'completed',
    });

    const result = await processSatoyamaOnboardingReminders(db, {
      env: enabledEnv,
      now: new Date('2026-07-28T03:00:00.000Z'),
    });

    expect(result).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(dbMocks.mark).not.toHaveBeenCalled();
  });

  it('records a redacted terminal failure and never retries an unclaimed row', async () => {
    dbMocks.due.mockResolvedValue([dueRow]);
    dbMocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    lineMocks.pushMessage.mockRejectedValue(
      new Error('provider error containing U123456789 and secret-channel-token'),
    );

    const failed = await processSatoyamaOnboardingReminders(db, {
      env: enabledEnv,
      now: new Date('2026-07-28T03:00:00.000Z'),
    });
    expect(failed).toEqual({ attempted: 1, sent: 0, failed: 1, skipped: 0 });
    expect(dbMocks.mark).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ sent: false }),
    );
    expect(JSON.stringify(dbMocks.mark.mock.calls)).not.toContain('U123456789');
    expect(JSON.stringify(dbMocks.mark.mock.calls)).not.toContain('secret-channel-token');

    lineMocks.pushMessage.mockClear();
    const notClaimed = await processSatoyamaOnboardingReminders(db, {
      env: enabledEnv,
      now: new Date('2026-07-28T03:01:00.000Z'),
    });
    expect(notClaimed).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 1 });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });

  it('encodes the LIFF ID as a path and query value', () => {
    expect(buildSatoyamaOnboardingLiffUrl('id/with?symbols')).toBe(
      'https://liff.line.me/id%2Fwith%3Fsymbols/onboarding/satoyama?liffId=id%2Fwith%3Fsymbols',
    );
  });
});
