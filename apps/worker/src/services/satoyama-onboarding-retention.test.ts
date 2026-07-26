import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({
  applySatoyamaOnboardingRetention: vi.fn(async () => ({
    answerEventsDeleted: 2,
    statesWithOldTimestampsCleared: 1,
    unfollowedTagAssignmentsDeleted: 3,
    unfollowedStatesDeleted: 1,
    unfollowedAnswerEventsDeleted: 1,
    unfollowedFriendMetadataCleared: 1,
  })),
  toJstString: vi.fn(() => '2026-07-27T12:00:00.000+09:00'),
}));

import { applySatoyamaOnboardingRetention } from '@line-crm/db';
import { runSatoyamaOnboardingRetention } from './satoyama-onboarding-retention.js';

const db = {} as D1Database;

describe('SATOYAMA onboarding retention runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed unless feature, account and retention flags are explicit', async () => {
    const result = await runSatoyamaOnboardingRetention(db, {
      env: {
        SATOYAMA_ONBOARDING_ENABLED: 'true',
        SATOYAMA_ONBOARDING_ACCOUNT_ID: 'account-satoyama',
      },
    });

    expect(result).toEqual({
      answerEventsDeleted: 0,
      statesWithOldTimestampsCleared: 0,
      unfollowedTagAssignmentsDeleted: 0,
      unfollowedStatesDeleted: 0,
      unfollowedAnswerEventsDeleted: 0,
      unfollowedFriendMetadataCleared: 0,
    });
    expect(applySatoyamaOnboardingRetention).not.toHaveBeenCalled();
  });

  it('runs only for the configured account when retention is enabled', async () => {
    const result = await runSatoyamaOnboardingRetention(db, {
      env: {
        SATOYAMA_ONBOARDING_ENABLED: 'true',
        SATOYAMA_ONBOARDING_ACCOUNT_ID: 'account-satoyama',
        SATOYAMA_ONBOARDING_RETENTION_ENABLED: 'true',
      },
      now: new Date('2026-07-27T03:00:00.000Z'),
    });

    expect(result.answerEventsDeleted).toBe(2);
    expect(applySatoyamaOnboardingRetention).toHaveBeenCalledWith(db, {
      lineAccountId: 'account-satoyama',
      now: '2026-07-27T12:00:00.000+09:00',
    });
  });
});
