export const SATOYAMA_ONBOARDING_PROGRAM_VERSION = 1;
export const SATOYAMA_ONBOARDING_SUBMISSION_LIMIT = 20;
export const SATOYAMA_ONBOARDING_SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SATOYAMA_ONBOARDING_EVENT_RETENTION_DAYS = 90;
export const SATOYAMA_ONBOARDING_UNFOLLOW_RETENTION_DAYS = 30;

export const SATOYAMA_ISSUE_CODES = [
  'key_person',
  'handoff',
  'unsure_start',
  'safe_rules',
  'automation',
] as const;

export const SATOYAMA_ROLE_CODES = [
  'owner',
  'internal_lead',
  'frontline',
  'supporter_solo',
] as const;

export const SATOYAMA_AREA_CODES = [
  'admin',
  'sales',
  'hiring_training',
  'content',
  'undecided',
] as const;

export type SatoyamaIssueCode = (typeof SATOYAMA_ISSUE_CODES)[number];
export type SatoyamaRoleCode = (typeof SATOYAMA_ROLE_CODES)[number];
export type SatoyamaAreaCode = (typeof SATOYAMA_AREA_CODES)[number];
export type SatoyamaOnboardingStatus = 'pending' | 'started' | 'completed' | 'skipped';

export interface SatoyamaOnboardingState {
  line_account_id: string;
  friend_id: string;
  program_version: number;
  status: SatoyamaOnboardingStatus;
  issue_code: SatoyamaIssueCode | null;
  role_code: SatoyamaRoleCode | null;
  area_code: SatoyamaAreaCode | null;
  common_bonus_opened_at: string | null;
  questions_started_at: string | null;
  issue_bonus_opened_at: string | null;
  cta_clicked_at: string | null;
  reminder_due_at: string | null;
  reminder_claimed_at: string | null;
  reminder_sent_at: string | null;
  reminder_cancelled_at: string | null;
  reminder_attempts: number;
  reminder_error_code: string | null;
  unfollowed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SatoyamaOnboardingTagDefinition {
  axis: 'role' | 'issue' | 'area';
  code: SatoyamaRoleCode | SatoyamaIssueCode | SatoyamaAreaCode;
  name: string;
  color: string;
}

export interface SatoyamaOnboardingAnswers {
  issue: SatoyamaIssueCode;
  role: SatoyamaRoleCode;
  area: SatoyamaAreaCode;
}

export class SatoyamaOnboardingIdempotencyConflict extends Error {
  constructor() {
    super('Idempotency key was already used with different answers');
    this.name = 'SatoyamaOnboardingIdempotencyConflict';
  }
}

export class SatoyamaOnboardingRateLimitExceeded extends Error {
  constructor() {
    super('Satoyama onboarding answer submission rate limit exceeded');
    this.name = 'SatoyamaOnboardingRateLimitExceeded';
  }
}

interface AnswerEvent {
  request_fingerprint: string;
}

interface AnswerEventCount {
  event_count: number;
}

function answerFingerprint(answers: SatoyamaOnboardingAnswers): string {
  return [
    SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    answers.issue,
    answers.role,
    answers.area,
  ].join('|');
}

function submissionWindowStart(now: string): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error('satoyama_onboarding_invalid_timestamp');
  }
  return new Date(nowMs - SATOYAMA_ONBOARDING_SUBMISSION_WINDOW_MS).toISOString();
}

async function getRecentAnswerEventCount(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  windowStart: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS event_count
         FROM satoyama_onboarding_answer_events
        WHERE line_account_id = ?
          AND friend_id = ?
          AND program_version = ?
          AND julianday(created_at) >= julianday(?)`,
    )
    .bind(
      lineAccountId,
      friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      windowStart,
    )
    .first<AnswerEventCount>();
  return Number(row?.event_count ?? 0);
}

function eventMatchSql(): string {
  return `EXISTS (
    SELECT 1
      FROM satoyama_onboarding_answer_events e
     WHERE e.line_account_id = ?
       AND e.friend_id = ?
       AND e.program_version = ?
       AND e.idempotency_key = ?
       AND e.request_fingerprint = ?
  )`;
}

export async function getSatoyamaOnboardingState(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
): Promise<SatoyamaOnboardingState | null> {
  return db
    .prepare(
      `SELECT *
         FROM satoyama_onboarding_states
        WHERE line_account_id = ?
          AND friend_id = ?
          AND program_version = ?`,
    )
    .bind(lineAccountId, friendId, SATOYAMA_ONBOARDING_PROGRAM_VERSION)
    .first<SatoyamaOnboardingState>();
}

async function getAnswerEvent(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  idempotencyKey: string,
): Promise<AnswerEvent | null> {
  return db
    .prepare(
      `SELECT request_fingerprint
         FROM satoyama_onboarding_answer_events
        WHERE line_account_id = ?
          AND friend_id = ?
          AND program_version = ?
          AND idempotency_key = ?`,
    )
    .bind(
      lineAccountId,
      friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      idempotencyKey,
    )
    .first<AnswerEvent>();
}

async function ensureTags(
  db: D1Database,
  definitions: readonly SatoyamaOnboardingTagDefinition[],
  now: string,
): Promise<Map<string, string>> {
  const inserts = definitions.map((tag) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO tags (id, name, color, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), tag.name, tag.color, now),
  );
  await db.batch(inserts);

  const placeholders = definitions.map(() => '?').join(', ');
  const rows = await db
    .prepare(`SELECT id, name FROM tags WHERE name IN (${placeholders})`)
    .bind(...definitions.map((tag) => tag.name))
    .all<{ id: string; name: string }>();

  const ids = new Map((rows.results ?? []).map((row) => [row.name, row.id]));
  if (ids.size !== definitions.length) {
    throw new Error('satoyama_onboarding_tag_provision_failed');
  }
  return ids;
}

function selectedTagIds(
  definitions: readonly SatoyamaOnboardingTagDefinition[],
  idsByName: ReadonlyMap<string, string>,
  answers: SatoyamaOnboardingAnswers,
): { all: string[]; selected: string[] } {
  const selectedCodes = new Set<string>([answers.issue, answers.role, answers.area]);
  const all = definitions.map((tag) => idsByName.get(tag.name)).filter((id): id is string => Boolean(id));
  const selected = definitions
    .filter((tag) => selectedCodes.has(tag.code))
    .map((tag) => idsByName.get(tag.name))
    .filter((id): id is string => Boolean(id));

  if (all.length !== definitions.length || selected.length !== 3) {
    throw new Error('satoyama_onboarding_tag_selection_failed');
  }
  return { all, selected };
}

export interface SaveSatoyamaOnboardingAnswersInput {
  lineAccountId: string;
  friendId: string;
  answers: SatoyamaOnboardingAnswers;
  idempotencyKey: string;
  tags: readonly SatoyamaOnboardingTagDefinition[];
  now: string;
}

export interface SaveSatoyamaOnboardingAnswersResult {
  state: SatoyamaOnboardingState;
  idempotentReplay: boolean;
}

export async function saveSatoyamaOnboardingAnswers(
  db: D1Database,
  input: SaveSatoyamaOnboardingAnswersInput,
): Promise<SaveSatoyamaOnboardingAnswersResult> {
  const fingerprint = answerFingerprint(input.answers);
  const windowStart = submissionWindowStart(input.now);
  const existingEvent = await getAnswerEvent(
    db,
    input.lineAccountId,
    input.friendId,
    input.idempotencyKey,
  );
  if (existingEvent) {
    if (existingEvent.request_fingerprint !== fingerprint) {
      throw new SatoyamaOnboardingIdempotencyConflict();
    }
    const state = await getSatoyamaOnboardingState(db, input.lineAccountId, input.friendId);
    if (!state) throw new Error('satoyama_onboarding_state_missing');
    return { state, idempotentReplay: true };
  }

  const recentEventCount = await getRecentAnswerEventCount(
    db,
    input.lineAccountId,
    input.friendId,
    windowStart,
  );
  if (recentEventCount >= SATOYAMA_ONBOARDING_SUBMISSION_LIMIT) {
    throw new SatoyamaOnboardingRateLimitExceeded();
  }

  const idsByName = await ensureTags(db, input.tags, input.now);
  const tagIds = selectedTagIds(input.tags, idsByName, input.answers);
  const allTagPlaceholders = tagIds.all.map(() => '?').join(', ');
  const matchSql = eventMatchSql();
  const eventMatchBinds = [
    input.lineAccountId,
    input.friendId,
    SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    input.idempotencyKey,
    fingerprint,
  ] as const;

  // The pre-check gives a fast 429. This conditional INSERT is the authority:
  // a competing request that reaches the limit first prevents this event and
  // every later statement guarded by eventMatchSql() from changing state.
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO satoyama_onboarding_answer_events (
           id, line_account_id, friend_id, program_version,
           idempotency_key, request_fingerprint,
           issue_code, role_code, area_code, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (
            SELECT COUNT(*)
              FROM satoyama_onboarding_answer_events e
             WHERE e.line_account_id = ?
               AND e.friend_id = ?
               AND e.program_version = ?
               AND julianday(e.created_at) >= julianday(?)
          ) < ?`,
      )
      .bind(
        crypto.randomUUID(),
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.idempotencyKey,
        fingerprint,
        input.answers.issue,
        input.answers.role,
        input.answers.area,
        input.now,
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        windowStart,
        SATOYAMA_ONBOARDING_SUBMISSION_LIMIT,
      ),
    db
      .prepare(
        `INSERT INTO satoyama_onboarding_states (
           line_account_id, friend_id, program_version, status,
           issue_code, role_code, area_code,
           reminder_due_at, reminder_cancelled_at,
           completed_at, created_at, updated_at
         )
         SELECT ?, ?, ?, 'completed', ?, ?, ?, NULL, ?, ?, ?, ?
          WHERE ${matchSql}
         ON CONFLICT (line_account_id, friend_id, program_version)
         DO UPDATE SET
           status = 'completed',
           issue_code = excluded.issue_code,
           role_code = excluded.role_code,
           area_code = excluded.area_code,
           reminder_due_at = NULL,
           reminder_cancelled_at = excluded.reminder_cancelled_at,
           completed_at = excluded.completed_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.answers.issue,
        input.answers.role,
        input.answers.area,
        input.now,
        input.now,
        input.now,
        input.now,
        ...eventMatchBinds,
      ),
    db
      .prepare(
        `UPDATE friends
            SET metadata = json_set(
                  CASE
                    WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}')
                    ELSE '{}'
                  END,
                  '$.sb_onboarding_version', ?,
                  '$.sb_onboarding_status', 'complete',
                  '$.sb_issue', ?,
                  '$.sb_role', ?,
                  '$.sb_area', ?,
                  '$.sb_onboarding_completed_at', ?,
                  '$.sb_onboarding_updated_at', ?
                ),
                updated_at = ?
          WHERE id = ?
            AND line_account_id = ?
            AND ${matchSql}`,
      )
      .bind(
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.answers.issue,
        input.answers.role,
        input.answers.area,
        input.now,
        input.now,
        input.now,
        input.friendId,
        input.lineAccountId,
        ...eventMatchBinds,
      ),
    db
      .prepare(
        `DELETE FROM friend_tags
          WHERE friend_id = ?
            AND tag_id IN (${allTagPlaceholders})
            AND ${matchSql}`,
      )
      .bind(input.friendId, ...tagIds.all, ...eventMatchBinds),
    ...tagIds.selected.map((tagId) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at)
           SELECT ?, ?, ?
            WHERE ${matchSql}`,
        )
        .bind(input.friendId, tagId, input.now, ...eventMatchBinds),
    ),
  ];

  await db.batch(statements);

  const persistedEvent = await getAnswerEvent(
    db,
    input.lineAccountId,
    input.friendId,
    input.idempotencyKey,
  );
  if (!persistedEvent) {
    const finalEventCount = await getRecentAnswerEventCount(
      db,
      input.lineAccountId,
      input.friendId,
      windowStart,
    );
    if (finalEventCount >= SATOYAMA_ONBOARDING_SUBMISSION_LIMIT) {
      throw new SatoyamaOnboardingRateLimitExceeded();
    }
    throw new Error('satoyama_onboarding_event_missing');
  }
  if (persistedEvent.request_fingerprint !== fingerprint) {
    throw new SatoyamaOnboardingIdempotencyConflict();
  }

  const state = await getSatoyamaOnboardingState(db, input.lineAccountId, input.friendId);
  if (!state) throw new Error('satoyama_onboarding_state_missing');
  return { state, idempotentReplay: false };
}

export async function scheduleSatoyamaOnboardingReminder(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    now: string;
    dueAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO satoyama_onboarding_states (
         line_account_id, friend_id, program_version, status,
         reminder_due_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(
      input.lineAccountId,
      input.friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      input.dueAt,
      input.now,
      input.now,
    )
    .run();
}

export async function markSatoyamaOnboardingBonusOpened(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    kind: 'common' | 'issue';
    now: string;
  },
): Promise<SatoyamaOnboardingState | null> {
  if (input.kind === 'common') {
    await db
      .prepare(
        `INSERT INTO satoyama_onboarding_states (
           line_account_id, friend_id, program_version, status,
           common_bonus_opened_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'started', ?, ?, ?)
         ON CONFLICT (line_account_id, friend_id, program_version)
         DO UPDATE SET
           status = CASE
             WHEN satoyama_onboarding_states.status IN ('completed', 'skipped')
               THEN satoyama_onboarding_states.status
             ELSE 'started'
           END,
           common_bonus_opened_at = COALESCE(
             satoyama_onboarding_states.common_bonus_opened_at,
             excluded.common_bonus_opened_at
           ),
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.now,
        input.now,
        input.now,
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE satoyama_onboarding_states
            SET issue_bonus_opened_at = COALESCE(issue_bonus_opened_at, ?),
                updated_at = ?
          WHERE line_account_id = ?
            AND friend_id = ?
            AND program_version = ?
            AND status = 'completed'`,
      )
      .bind(
        input.now,
        input.now,
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      )
      .run();
  }
  return getSatoyamaOnboardingState(db, input.lineAccountId, input.friendId);
}

export async function markSatoyamaOnboardingQuestionsStarted(
  db: D1Database,
  input: { lineAccountId: string; friendId: string; now: string },
): Promise<SatoyamaOnboardingState | null> {
  await db
    .prepare(
      `INSERT INTO satoyama_onboarding_states (
         line_account_id, friend_id, program_version, status,
         questions_started_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'started', ?, ?, ?)
       ON CONFLICT (line_account_id, friend_id, program_version)
       DO UPDATE SET
         status = CASE
           WHEN satoyama_onboarding_states.status IN ('completed', 'skipped')
             THEN satoyama_onboarding_states.status
           ELSE 'started'
         END,
         questions_started_at = COALESCE(
           satoyama_onboarding_states.questions_started_at,
           excluded.questions_started_at
         ),
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.lineAccountId,
      input.friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      input.now,
      input.now,
      input.now,
    )
    .run();
  return getSatoyamaOnboardingState(db, input.lineAccountId, input.friendId);
}

export async function markSatoyamaOnboardingCtaClicked(
  db: D1Database,
  input: { lineAccountId: string; friendId: string; now: string },
): Promise<SatoyamaOnboardingState | null> {
  await db
    .prepare(
      `UPDATE satoyama_onboarding_states
          SET cta_clicked_at = COALESCE(cta_clicked_at, ?),
              updated_at = ?
        WHERE line_account_id = ?
          AND friend_id = ?
          AND program_version = ?
          AND status = 'completed'`,
    )
    .bind(
      input.now,
      input.now,
      input.lineAccountId,
      input.friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    )
    .run();
  return getSatoyamaOnboardingState(db, input.lineAccountId, input.friendId);
}

export async function skipSatoyamaOnboarding(
  db: D1Database,
  input: { lineAccountId: string; friendId: string; now: string },
): Promise<SatoyamaOnboardingState> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO satoyama_onboarding_states (
           line_account_id, friend_id, program_version, status,
           reminder_due_at, reminder_cancelled_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'skipped', NULL, ?, ?, ?)
         ON CONFLICT (line_account_id, friend_id, program_version)
         DO UPDATE SET
           status = CASE
             WHEN satoyama_onboarding_states.status = 'completed'
               THEN 'completed'
             ELSE 'skipped'
           END,
           reminder_due_at = NULL,
           reminder_cancelled_at = COALESCE(
             satoyama_onboarding_states.reminder_cancelled_at,
             excluded.reminder_cancelled_at
           ),
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.now,
        input.now,
        input.now,
      ),
    db
      .prepare(
        `UPDATE friends
            SET metadata = json_set(
                  CASE
                    WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}')
                    ELSE '{}'
                  END,
                  '$.sb_onboarding_version', ?,
                  '$.sb_onboarding_status',
                    CASE
                      WHEN EXISTS (
                        SELECT 1
                          FROM satoyama_onboarding_states
                         WHERE line_account_id = ?
                           AND friend_id = ?
                           AND program_version = ?
                           AND status = 'completed'
                      )
                        THEN 'complete'
                      ELSE 'skipped'
                    END,
                  '$.sb_onboarding_updated_at', ?
                ),
                updated_at = ?
          WHERE id = ?
            AND line_account_id = ?`,
      )
      .bind(
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.lineAccountId,
        input.friendId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        input.now,
        input.now,
        input.friendId,
        input.lineAccountId,
      ),
  ]);

  const state = await getSatoyamaOnboardingState(db, input.lineAccountId, input.friendId);
  if (!state) throw new Error('satoyama_onboarding_state_missing');
  return state;
}

export async function cancelSatoyamaOnboardingReminder(
  db: D1Database,
  input: { lineAccountId: string; friendId: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE satoyama_onboarding_states
          SET reminder_due_at = NULL,
              reminder_cancelled_at = COALESCE(reminder_cancelled_at, ?),
              updated_at = ?
        WHERE friend_id = ?
          AND line_account_id = ?
          AND program_version = ?
          AND status IN ('pending', 'started')
          AND reminder_sent_at IS NULL`,
    )
    .bind(
      input.now,
      input.now,
      input.friendId,
      input.lineAccountId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    )
    .run();
}

export async function markSatoyamaOnboardingFollowState(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    isFollowing: boolean;
    now: string;
  },
): Promise<void> {
  if (input.isFollowing) {
    await db
      .prepare(
        `UPDATE satoyama_onboarding_states
            SET unfollowed_at = NULL,
                updated_at = ?
          WHERE friend_id = ?
            AND line_account_id = ?
            AND program_version = ?`,
      )
      .bind(
        input.now,
        input.friendId,
        input.lineAccountId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE satoyama_onboarding_states
          SET unfollowed_at = COALESCE(unfollowed_at, ?),
              reminder_due_at = NULL,
              reminder_cancelled_at = COALESCE(reminder_cancelled_at, ?),
              updated_at = ?
        WHERE friend_id = ?
          AND line_account_id = ?
          AND program_version = ?`,
    )
    .bind(
      input.now,
      input.now,
      input.now,
      input.friendId,
      input.lineAccountId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    )
    .run();
}

export interface DueSatoyamaOnboardingReminder {
  line_account_id: string;
  friend_id: string;
  channel_access_token: string;
  liff_id: string;
  line_user_id: string;
}

export async function getDueSatoyamaOnboardingReminders(
  db: D1Database,
  input: { lineAccountId: string; now: string; limit?: number },
): Promise<DueSatoyamaOnboardingReminder[]> {
  const rows = await db
    .prepare(
      `SELECT s.line_account_id,
              s.friend_id,
              la.channel_access_token,
              la.liff_id,
              f.line_user_id
         FROM satoyama_onboarding_states s
         INNER JOIN line_accounts la ON la.id = s.line_account_id
         INNER JOIN friends f ON f.id = s.friend_id
        WHERE s.line_account_id = ?
          AND s.program_version = ?
          AND s.status IN ('pending', 'started')
          AND s.reminder_due_at IS NOT NULL
          AND s.reminder_due_at <= ?
          AND s.reminder_attempts = 0
          AND s.reminder_sent_at IS NULL
          AND s.reminder_cancelled_at IS NULL
          AND la.is_active = 1
          AND la.liff_id IS NOT NULL
          AND f.is_following = 1
          AND f.line_account_id = s.line_account_id
        ORDER BY s.reminder_due_at ASC
        LIMIT ?`,
    )
    .bind(
      input.lineAccountId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
      input.now,
      input.limit ?? 50,
    )
    .all<DueSatoyamaOnboardingReminder>();
  return rows.results ?? [];
}

export async function claimSatoyamaOnboardingReminder(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    now: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE satoyama_onboarding_states
          SET reminder_attempts = 1,
              reminder_claimed_at = ?,
              updated_at = ?
        WHERE line_account_id = ?
          AND friend_id = ?
          AND program_version = ?
          AND status IN ('pending', 'started')
          AND reminder_attempts = 0
          AND reminder_sent_at IS NULL
          AND reminder_cancelled_at IS NULL`,
    )
    .bind(
      input.now,
      input.now,
      input.lineAccountId,
      input.friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    )
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function markSatoyamaOnboardingReminderResult(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    now: string;
    sent: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE satoyama_onboarding_states
          SET reminder_sent_at = CASE WHEN ? = 1 THEN ? ELSE reminder_sent_at END,
              reminder_error_code = CASE WHEN ? = 1 THEN NULL ELSE 'send_failed' END,
              reminder_due_at = NULL,
              updated_at = ?
        WHERE line_account_id = ?
          AND friend_id = ?
          AND program_version = ?
          AND reminder_attempts = 1`,
    )
    .bind(
      input.sent ? 1 : 0,
      input.now,
      input.sent ? 1 : 0,
      input.now,
      input.lineAccountId,
      input.friendId,
      SATOYAMA_ONBOARDING_PROGRAM_VERSION,
    )
    .run();
}

export interface SatoyamaOnboardingRetentionResult {
  answerEventsDeleted: number;
  statesWithOldTimestampsCleared: number;
  unfollowedTagAssignmentsDeleted: number;
  unfollowedStatesDeleted: number;
  unfollowedAnswerEventsDeleted: number;
  unfollowedFriendMetadataCleared: number;
}

function retentionCutoff(now: string, days: number): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error('satoyama_onboarding_invalid_retention_timestamp');
  }
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

function d1Changes(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

/**
 * Applies the SATOYAMA-only data-minimisation policy.
 *
 * - Raw answer history and funnel/reminder timestamps are retained for 90 days.
 * - Latest answers and [SB] tags remain while the account is followed.
 * - 30 days after unfollow, onboarding state, history, [SB] tag assignments,
 *   and onboarding-only friend metadata are removed.
 *
 * The generic friend row and non-[SB] data are intentionally outside this
 * feature boundary. Every statement rechecks account, follow state and cutoff,
 * and D1 batch keeps the cleanup changes in one transaction.
 */
export async function applySatoyamaOnboardingRetention(
  db: D1Database,
  input: {
    lineAccountId: string;
    now: string;
  },
): Promise<SatoyamaOnboardingRetentionResult> {
  const eventCutoff = retentionCutoff(
    input.now,
    SATOYAMA_ONBOARDING_EVENT_RETENTION_DAYS,
  );
  const unfollowCutoff = retentionCutoff(
    input.now,
    SATOYAMA_ONBOARDING_UNFOLLOW_RETENTION_DAYS,
  );

  const unfollowedFriendFilter = `SELECT s.friend_id
    FROM satoyama_onboarding_states s
    INNER JOIN friends f
      ON f.id = s.friend_id
     AND f.line_account_id = s.line_account_id
   WHERE s.line_account_id = ?
     AND s.program_version = ?
     AND s.unfollowed_at IS NOT NULL
     AND julianday(s.unfollowed_at) < julianday(?)
     AND f.is_following = 0`;

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM satoyama_onboarding_answer_events
          WHERE line_account_id = ?
            AND julianday(created_at) < julianday(?)`,
      )
      .bind(input.lineAccountId, eventCutoff),
    db
      .prepare(
        `WITH retention(cutoff) AS (SELECT julianday(?))
         UPDATE satoyama_onboarding_states
            SET common_bonus_opened_at = CASE
                  WHEN julianday(common_bonus_opened_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE common_bonus_opened_at END,
                questions_started_at = CASE
                  WHEN julianday(questions_started_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE questions_started_at END,
                issue_bonus_opened_at = CASE
                  WHEN julianday(issue_bonus_opened_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE issue_bonus_opened_at END,
                cta_clicked_at = CASE
                  WHEN julianday(cta_clicked_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE cta_clicked_at END,
                reminder_due_at = CASE
                  WHEN julianday(reminder_due_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE reminder_due_at END,
                reminder_claimed_at = CASE
                  WHEN julianday(reminder_claimed_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE reminder_claimed_at END,
                reminder_sent_at = CASE
                  WHEN julianday(reminder_sent_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE reminder_sent_at END,
                reminder_cancelled_at = CASE
                  WHEN julianday(reminder_cancelled_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE reminder_cancelled_at END,
                reminder_error_code = CASE
                  WHEN julianday(reminder_claimed_at) < (SELECT cutoff FROM retention)
                    OR julianday(reminder_sent_at) < (SELECT cutoff FROM retention)
                    OR julianday(reminder_cancelled_at) < (SELECT cutoff FROM retention)
                    THEN NULL ELSE reminder_error_code END
          WHERE line_account_id = ?
            AND (
              julianday(common_bonus_opened_at) < (SELECT cutoff FROM retention)
              OR julianday(questions_started_at) < (SELECT cutoff FROM retention)
              OR julianday(issue_bonus_opened_at) < (SELECT cutoff FROM retention)
              OR julianday(cta_clicked_at) < (SELECT cutoff FROM retention)
              OR julianday(reminder_due_at) < (SELECT cutoff FROM retention)
              OR julianday(reminder_claimed_at) < (SELECT cutoff FROM retention)
              OR julianday(reminder_sent_at) < (SELECT cutoff FROM retention)
              OR julianday(reminder_cancelled_at) < (SELECT cutoff FROM retention)
            )`,
      )
      .bind(eventCutoff, input.lineAccountId),
    db
      .prepare(
        `DELETE FROM friend_tags
          WHERE friend_id IN (${unfollowedFriendFilter})
            AND tag_id IN (
              SELECT id FROM tags WHERE substr(name, 1, 4) = '[SB]'
            )`,
      )
      .bind(
        input.lineAccountId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        unfollowCutoff,
      ),
    db
      .prepare(
        `UPDATE friends
            SET metadata = json_remove(
                  metadata,
                  '$.sb_onboarding_version',
                  '$.sb_onboarding_status',
                  '$.sb_issue',
                  '$.sb_role',
                  '$.sb_area',
                  '$.sb_onboarding_completed_at',
                  '$.sb_onboarding_updated_at'
                )
          WHERE id IN (${unfollowedFriendFilter})
            AND json_valid(COALESCE(metadata, '{}'))
            AND instr(COALESCE(metadata, ''), '"sb_') > 0`,
      )
      .bind(
        input.lineAccountId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        unfollowCutoff,
      ),
    db
      .prepare(
        `DELETE FROM satoyama_onboarding_answer_events
          WHERE line_account_id = ?
            AND friend_id IN (${unfollowedFriendFilter})`,
      )
      .bind(
        input.lineAccountId,
        input.lineAccountId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        unfollowCutoff,
      ),
    db
      .prepare(
        `DELETE FROM satoyama_onboarding_states
          WHERE line_account_id = ?
            AND friend_id IN (${unfollowedFriendFilter})`,
      )
      .bind(
        input.lineAccountId,
        input.lineAccountId,
        SATOYAMA_ONBOARDING_PROGRAM_VERSION,
        unfollowCutoff,
      ),
  ]);

  return {
    answerEventsDeleted: d1Changes(results[0]),
    statesWithOldTimestampsCleared: d1Changes(results[1]),
    unfollowedTagAssignmentsDeleted: d1Changes(results[2]),
    unfollowedStatesDeleted: d1Changes(results[5]),
    unfollowedAnswerEventsDeleted: d1Changes(results[4]),
    unfollowedFriendMetadataCleared: d1Changes(results[3]),
  };
}
