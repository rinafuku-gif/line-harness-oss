import {
  applySatoyamaOnboardingRetention,
  toJstString,
  type SatoyamaOnboardingRetentionResult,
} from '@line-crm/db';
import {
  configuredSatoyamaAccountId,
  type SatoyamaOnboardingRuntimeConfig,
} from './satoyama-onboarding-reminder.js';

export interface SatoyamaOnboardingRetentionConfig
  extends SatoyamaOnboardingRuntimeConfig {
  SATOYAMA_ONBOARDING_RETENTION_ENABLED?: string;
}

const EMPTY_RESULT: SatoyamaOnboardingRetentionResult = {
  answerEventsDeleted: 0,
  statesWithOldTimestampsCleared: 0,
  unfollowedTagAssignmentsDeleted: 0,
  unfollowedStatesDeleted: 0,
  unfollowedAnswerEventsDeleted: 0,
  unfollowedFriendMetadataCleared: 0,
};

export async function runSatoyamaOnboardingRetention(
  db: D1Database,
  input: {
    env: SatoyamaOnboardingRetentionConfig;
    now?: Date;
  },
): Promise<SatoyamaOnboardingRetentionResult> {
  const lineAccountId = configuredSatoyamaAccountId(input.env);
  if (
    !lineAccountId ||
    input.env.SATOYAMA_ONBOARDING_RETENTION_ENABLED !== 'true'
  ) {
    return { ...EMPTY_RESULT };
  }

  return applySatoyamaOnboardingRetention(db, {
    lineAccountId,
    now: toJstString(input.now ?? new Date()),
  });
}
