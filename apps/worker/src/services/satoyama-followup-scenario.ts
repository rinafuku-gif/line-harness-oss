import { enrollFriendInScenario, jstNow, type SatoyamaIssueCode } from '@line-crm/db';
import {
  SATOYAMA_FOLLOWUP_SCENARIOS,
  SATOYAMA_FOLLOWUP_SCENARIO_IDS,
} from '../features/satoyama-onboarding/followup-content.js';
import { SATOYAMA_ONBOARDING_TAGS } from '../features/satoyama-onboarding/content.js';

export type SatoyamaFollowupSyncStatus =
  | 'enrolled'
  | 'already_enrolled'
  | 'already_completed'
  | 'previously_paused'
  | 'not_configured';

export interface SatoyamaFollowupSyncResult {
  status: SatoyamaFollowupSyncStatus;
  scenarioId: string;
}

interface ExistingEnrollment {
  id: string;
  status: 'active' | 'paused' | 'completed' | 'delivering';
}

function issueTagName(issue: SatoyamaIssueCode): string {
  const tag = SATOYAMA_ONBOARDING_TAGS.find(
    (candidate) => candidate.axis === 'issue' && candidate.code === issue,
  );
  if (!tag) throw new Error(`satoyama_followup_issue_tag_missing:${issue}`);
  return tag.name;
}

/**
 * Synchronize one friend to the issue-specific SATOYAMA follow-up scenario.
 *
 * The answer save is authoritative. This function only enrolls when all of the
 * following still match in the database: exact account, exact stable scenario
 * id, active scenario, expected issue tag, and the tag is currently attached
 * to the same friend. That keeps a stale or cross-account scenario fail-closed.
 *
 * A friend receives each issue stream at most once. Re-answering the same
 * issue is idempotent. Changing the issue pauses the previous active stream and
 * enrolls the new one. Switching back to an already completed/paused stream
 * does not restart messages automatically.
 */
export async function syncSatoyamaFollowupScenario(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    issue: SatoyamaIssueCode;
  },
): Promise<SatoyamaFollowupSyncResult> {
  const definition = SATOYAMA_FOLLOWUP_SCENARIOS[input.issue];
  const tagName = issueTagName(input.issue);

  const configured = await db
    .prepare(
      `SELECT s.id
         FROM scenarios s
         INNER JOIN tags t ON t.id = s.trigger_tag_id
         INNER JOIN friend_tags ft
                 ON ft.tag_id = t.id
                AND ft.friend_id = ?
        WHERE s.id = ?
          AND s.line_account_id = ?
          AND s.trigger_type = 'tag_added'
          AND s.is_active = 1
          AND t.name = ?
        LIMIT 1`,
    )
    .bind(input.friendId, definition.id, input.lineAccountId, tagName)
    .first<{ id: string }>();

  if (!configured) {
    return { status: 'not_configured', scenarioId: definition.id };
  }

  const placeholders = SATOYAMA_FOLLOWUP_SCENARIO_IDS.map(() => '?').join(', ');
  await db
    .prepare(
      `UPDATE friend_scenarios
          SET status = 'paused',
              next_delivery_at = NULL,
              updated_at = ?
        WHERE friend_id = ?
          AND scenario_id IN (${placeholders})
          AND scenario_id != ?
          AND status = 'active'`,
    )
    .bind(
      jstNow(),
      input.friendId,
      ...SATOYAMA_FOLLOWUP_SCENARIO_IDS,
      definition.id,
    )
    .run();

  const existing = await db
    .prepare(
      `SELECT id, status
         FROM friend_scenarios
        WHERE friend_id = ?
          AND scenario_id = ?
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'delivering' THEN 1
            WHEN 'paused' THEN 2
            ELSE 3
          END,
          started_at DESC
        LIMIT 1`,
    )
    .bind(input.friendId, definition.id)
    .first<ExistingEnrollment>();

  if (existing) {
    if (existing.status === 'completed') {
      return { status: 'already_completed', scenarioId: definition.id };
    }
    if (existing.status === 'paused') {
      return { status: 'previously_paused', scenarioId: definition.id };
    }
    return { status: 'already_enrolled', scenarioId: definition.id };
  }

  const enrollment = await enrollFriendInScenario(db, input.friendId, definition.id);
  return {
    status: enrollment ? 'enrolled' : 'already_enrolled',
    scenarioId: definition.id,
  };
}
