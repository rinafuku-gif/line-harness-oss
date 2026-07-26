import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SATOYAMA_ONBOARDING_SUBMISSION_LIMIT,
  SatoyamaOnboardingIdempotencyConflict,
  SatoyamaOnboardingRateLimitExceeded,
  applySatoyamaOnboardingRetention,
  cancelSatoyamaOnboardingReminder,
  claimSatoyamaOnboardingReminder,
  getSatoyamaOnboardingState,
  markSatoyamaOnboardingBonusOpened,
  markSatoyamaOnboardingCtaClicked,
  markSatoyamaOnboardingFollowState,
  markSatoyamaOnboardingQuestionsStarted,
  markSatoyamaOnboardingReminderResult,
  saveSatoyamaOnboardingAnswers,
  scheduleSatoyamaOnboardingReminder,
  skipSatoyamaOnboarding,
  type SatoyamaOnboardingTagDefinition,
} from '../src/satoyama-onboarding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(__dirname, '../migrations/047_satoyama_onboarding.sql'),
  'utf8',
);

interface ExecutableStatement {
  execute(): {
    success: boolean;
    meta: { changes: number };
    results?: unknown[];
  };
}

function createD1(sqlite: Database.Database): D1Database {
  function statement(sql: string, values: unknown[] = []): D1PreparedStatement {
    const executable: ExecutableStatement & Record<string, unknown> = {
      execute() {
        const info = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: info.changes } };
      },
      bind(...next: unknown[]) {
        return statement(sql, next);
      },
      async first<T>() {
        return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
      },
      async all<T>() {
        return {
          success: true,
          meta: {},
          results: sqlite.prepare(sql).all(...values) as T[],
        };
      },
      async raw<T>() {
        return sqlite.prepare(sql).raw().all(...values) as T[];
      },
      async run() {
        return executable.execute();
      },
    };
    return executable as unknown as D1PreparedStatement;
  }

  return {
    prepare: statement,
    async batch(statements: D1PreparedStatement[]) {
      return sqlite.transaction((items: D1PreparedStatement[]) =>
        items.map((item) => (item as unknown as ExecutableStatement).execute()),
      )(statements) as never;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    withSession() {
      throw new Error('not implemented');
    },
    dump() {
      throw new Error('not implemented');
    },
  } as unknown as D1Database;
}

const tags: readonly SatoyamaOnboardingTagDefinition[] = [
  { axis: 'role', code: 'owner', name: '[SB][立場] 経営者・代表', color: '#2F6B4F' },
  { axis: 'role', code: 'internal_lead', name: '[SB][立場] 社内推進担当', color: '#2F6B4F' },
  { axis: 'role', code: 'frontline', name: '[SB][立場] 現場担当者', color: '#2F6B4F' },
  { axis: 'role', code: 'supporter_solo', name: '[SB][立場] 支援者・個人事業主', color: '#2F6B4F' },
  { axis: 'issue', code: 'key_person', name: '[SB][課題] 特定の人に集中', color: '#B85C38' },
  { axis: 'issue', code: 'handoff', name: '[SB][課題] 引き継ぎ・標準化', color: '#B85C38' },
  { axis: 'issue', code: 'unsure_start', name: '[SB][課題] 何から始めるか未定', color: '#B85C38' },
  { axis: 'issue', code: 'safe_rules', name: '[SB][課題] 利用ルール・推進体制', color: '#B85C38' },
  { axis: 'issue', code: 'automation', name: '[SB][課題] 自動化・仕組み化', color: '#B85C38' },
  { axis: 'area', code: 'admin', name: '[SB][領域] 事務・管理', color: '#356E9A' },
  { axis: 'area', code: 'sales', name: '[SB][領域] 営業・顧客対応', color: '#356E9A' },
  { axis: 'area', code: 'hiring_training', name: '[SB][領域] 採用・教育', color: '#356E9A' },
  { axis: 'area', code: 'content', name: '[SB][領域] 情報発信', color: '#356E9A' },
  { axis: 'area', code: 'undecided', name: '[SB][領域] 未定', color: '#356E9A' },
];

async function fillSubmissionWindow(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    count: number;
    now: string;
  },
): Promise<void> {
  for (let index = 0; index < input.count; index += 1) {
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: input.lineAccountId,
      friendId: input.friendId,
      answers: { issue: 'key_person', role: 'owner', area: 'admin' },
      idempotencyKey: `rate-${input.lineAccountId}-${input.friendId}-${index}`,
      tags,
      now: input.now,
    });
  }
}

describe('SATOYAMA onboarding DB boundary', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE line_accounts (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        channel_access_token TEXT NOT NULL,
        channel_secret TEXT NOT NULL,
        liff_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_user_id TEXT UNIQUE NOT NULL,
        line_account_id TEXT REFERENCES line_accounts(id),
        is_following INTEGER NOT NULL DEFAULT 1,
        metadata TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE friend_tags (
        friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (friend_id, tag_id)
      );
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, liff_id)
      VALUES
        ('account-1', 'channel-1', 'SATOYAMA', 'token-1', 'secret-1', 'liff-1'),
        ('account-2', 'channel-2', 'Other', 'token-2', 'secret-2', 'liff-2');
      INSERT INTO friends
        (id, line_user_id, line_account_id, is_following, metadata, updated_at)
      VALUES
        ('friend-1', 'U1', 'account-1', 1, '{"keep":"yes"}', 'before'),
        ('friend-2', 'U2', 'account-2', 1, '{}', 'before'),
        ('friend-3', 'U3', 'account-1', 1, '{}', 'before');
    `);
    sqlite.exec(migration);
    db = createD1(sqlite);
  });

  it('records funnel milestones once without changing completed answers', async () => {
    await markSatoyamaOnboardingQuestionsStarted(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      now: '2026-07-26T11:58:00.000+09:00',
    });
    await markSatoyamaOnboardingBonusOpened(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      kind: 'common',
      now: '2026-07-26T11:59:00.000+09:00',
    });
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'key_person', role: 'owner', area: 'admin' },
      idempotencyKey: 'engagement-event-key-0001',
      tags,
      now: '2026-07-26T12:00:00.000+09:00',
    });
    await markSatoyamaOnboardingCtaClicked(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      now: '2026-07-26T12:01:00.000+09:00',
    });
    await markSatoyamaOnboardingBonusOpened(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      kind: 'issue',
      now: '2026-07-26T12:02:00.000+09:00',
    });

    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toMatchObject({
      status: 'completed',
      issue_code: 'key_person',
      role_code: 'owner',
      area_code: 'admin',
      questions_started_at: '2026-07-26T11:58:00.000+09:00',
      common_bonus_opened_at: '2026-07-26T11:59:00.000+09:00',
      cta_clicked_at: '2026-07-26T12:01:00.000+09:00',
      issue_bonus_opened_at: '2026-07-26T12:02:00.000+09:00',
    });
  });

  it('atomically stores 3 axes, preserves unrelated metadata, and attaches exactly 3 of 14 tags', async () => {
    const result = await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'handoff', role: 'internal_lead', area: 'admin' },
      idempotencyKey: 'idem-000000000001',
      tags,
      now: '2026-07-26T12:00:00.000+09:00',
    });

    expect(result.idempotentReplay).toBe(false);
    expect(result.state).toMatchObject({
      status: 'completed',
      issue_code: 'handoff',
      role_code: 'internal_lead',
      area_code: 'admin',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM tags').get()).toEqual({ c: 14 });
    expect(
      sqlite
        .prepare(
          `SELECT t.name
             FROM friend_tags ft
             JOIN tags t ON t.id = ft.tag_id
            WHERE ft.friend_id = ?
            ORDER BY t.name`,
        )
        .all('friend-1'),
    ).toEqual([
      { name: '[SB][立場] 社内推進担当' },
      { name: '[SB][課題] 引き継ぎ・標準化' },
      { name: '[SB][領域] 事務・管理' },
    ]);
    const friend = sqlite
      .prepare('SELECT metadata FROM friends WHERE id = ?')
      .get('friend-1') as { metadata: string };
    expect(JSON.parse(friend.metadata)).toMatchObject({
      keep: 'yes',
      sb_onboarding_status: 'complete',
      sb_issue: 'handoff',
      sb_role: 'internal_lead',
      sb_area: 'admin',
    });
  });

  it('replays the same request once and rejects key reuse with different answers', async () => {
    const first = {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'key_person', role: 'owner', area: 'sales' } as const,
      idempotencyKey: 'idem-000000000002',
      tags,
      now: '2026-07-26T12:00:00.000+09:00',
    };
    await saveSatoyamaOnboardingAnswers(db, first);
    const replay = await saveSatoyamaOnboardingAnswers(db, first);
    expect(replay.idempotentReplay).toBe(true);
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS c FROM satoyama_onboarding_answer_events')
        .get(),
    ).toEqual({ c: 1 });

    await expect(
      saveSatoyamaOnboardingAnswers(db, {
        ...first,
        answers: { issue: 'automation', role: 'owner', area: 'sales' },
      }),
    ).rejects.toBeInstanceOf(SatoyamaOnboardingIdempotencyConflict);
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toMatchObject({
      issue_code: 'key_person',
    });
  });

  it('re-answer replaces only the 3 onboarding axes and keeps an append-only history', async () => {
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'key_person', role: 'owner', area: 'sales' },
      idempotencyKey: 'idem-000000000003',
      tags,
      now: '2026-07-26T12:00:00.000+09:00',
    });
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'safe_rules', role: 'frontline', area: 'content' },
      idempotencyKey: 'idem-000000000004',
      tags,
      now: '2026-07-26T12:05:00.000+09:00',
    });

    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toMatchObject({
      issue_code: 'safe_rules',
      role_code: 'frontline',
      area_code: 'content',
    });
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS c FROM satoyama_onboarding_answer_events')
        .get(),
    ).toEqual({ c: 2 });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS c FROM friend_tags WHERE friend_id = ?').get('friend-1'),
    ).toEqual({ c: 3 });
  });

  it('limits one account/friend/program to 20 accepted submissions per rolling 24 hours', async () => {
    const now = '2026-07-26T12:00:00.000+09:00';
    await fillSubmissionWindow(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      count: SATOYAMA_ONBOARDING_SUBMISSION_LIMIT,
      now,
    });

    const replay = await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'key_person', role: 'owner', area: 'admin' },
      idempotencyKey: 'rate-account-1-friend-1-0',
      tags,
      now,
    });
    expect(replay.idempotentReplay).toBe(true);

    await expect(
      saveSatoyamaOnboardingAnswers(db, {
        lineAccountId: 'account-1',
        friendId: 'friend-1',
        answers: { issue: 'automation', role: 'frontline', area: 'content' },
        idempotencyKey: 'rate-account-1-friend-1-over-limit',
        tags,
        now,
      }),
    ).rejects.toBeInstanceOf(SatoyamaOnboardingRateLimitExceeded);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c
             FROM satoyama_onboarding_answer_events
            WHERE line_account_id = ?
              AND friend_id = ?
              AND program_version = 1`,
        )
        .get('account-1', 'friend-1'),
    ).toEqual({ c: SATOYAMA_ONBOARDING_SUBMISSION_LIMIT });
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toMatchObject({
      issue_code: 'key_person',
      role_code: 'owner',
      area_code: 'admin',
    });
    const friendAfterLimit = sqlite
      .prepare('SELECT metadata FROM friends WHERE id = ?')
      .get('friend-1') as { metadata: string };
    expect(JSON.parse(friendAfterLimit.metadata)).toMatchObject({
      sb_issue: 'key_person',
      sb_role: 'owner',
      sb_area: 'admin',
    });

    await expect(
      saveSatoyamaOnboardingAnswers(db, {
        lineAccountId: 'account-1',
        friendId: 'friend-3',
        answers: { issue: 'handoff', role: 'internal_lead', area: 'sales' },
        idempotencyKey: 'rate-separate-friend-allowed',
        tags,
        now,
      }),
    ).resolves.toMatchObject({ idempotentReplay: false });
    await expect(
      saveSatoyamaOnboardingAnswers(db, {
        lineAccountId: 'account-2',
        friendId: 'friend-2',
        answers: { issue: 'safe_rules', role: 'supporter_solo', area: 'undecided' },
        idempotencyKey: 'rate-separate-account-allowed',
        tags,
        now,
      }),
    ).resolves.toMatchObject({ idempotentReplay: false });

    await expect(
      saveSatoyamaOnboardingAnswers(db, {
        lineAccountId: 'account-1',
        friendId: 'friend-1',
        answers: { issue: 'automation', role: 'frontline', area: 'content' },
        idempotencyKey: 'rate-window-expired-allowed',
        tags,
        now: '2026-07-27T12:00:00.001+09:00',
      }),
    ).resolves.toMatchObject({ idempotentReplay: false });
  });

  it('re-checks the persistent limit inside the insert when another request wins the race', async () => {
    await fillSubmissionWindow(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      count: SATOYAMA_ONBOARDING_SUBMISSION_LIMIT - 1,
      now: '2026-07-26T12:00:00.000+09:00',
    });

    let competingEventInserted = false;
    const racingDb = {
      prepare(sql: string) {
        if (
          !competingEventInserted &&
          sql.includes('INSERT OR IGNORE INTO satoyama_onboarding_answer_events') &&
          sql.includes('SELECT COUNT(*)')
        ) {
          sqlite
            .prepare(
              `INSERT INTO satoyama_onboarding_answer_events (
                 id, line_account_id, friend_id, program_version,
                 idempotency_key, request_fingerprint,
                 issue_code, role_code, area_code, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              'competing-event-id',
              'account-1',
              'friend-1',
              1,
              'competing-idempotency-key',
              '1|automation|owner|admin',
              'automation',
              'owner',
              'admin',
              '2026-07-26T12:29:00.000+09:00',
            );
          competingEventInserted = true;
        }
        return db.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        return db.batch(statements);
      },
    } as unknown as D1Database;

    await expect(
      saveSatoyamaOnboardingAnswers(racingDb, {
        lineAccountId: 'account-1',
        friendId: 'friend-1',
        answers: { issue: 'safe_rules', role: 'frontline', area: 'content' },
        idempotencyKey: 'candidate-after-race-limit',
        tags,
        now: '2026-07-26T12:30:00.000+09:00',
      }),
    ).rejects.toBeInstanceOf(SatoyamaOnboardingRateLimitExceeded);
    expect(competingEventInserted).toBe(true);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c
             FROM satoyama_onboarding_answer_events
            WHERE line_account_id = 'account-1'
              AND friend_id = 'friend-1'`,
        )
        .get(),
    ).toEqual({ c: SATOYAMA_ONBOARDING_SUBMISSION_LIMIT });
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toMatchObject({
      issue_code: 'key_person',
      role_code: 'owner',
      area_code: 'admin',
    });
    expect(
      sqlite
        .prepare(
          `SELECT t.name
             FROM friend_tags ft
             JOIN tags t ON t.id = ft.tag_id
            WHERE ft.friend_id = ?
            ORDER BY t.name`,
        )
        .all('friend-1'),
    ).toEqual([
      { name: '[SB][立場] 経営者・代表' },
      { name: '[SB][課題] 特定の人に集中' },
      { name: '[SB][領域] 事務・管理' },
    ]);
  });

  it('rejects a friend/account mismatch without changing profile, answer history, or friend tags', async () => {
    await expect(
      saveSatoyamaOnboardingAnswers(db, {
        lineAccountId: 'account-2',
        friendId: 'friend-1',
        answers: { issue: 'automation', role: 'owner', area: 'admin' },
        idempotencyKey: 'idem-000000000005',
        tags,
        now: '2026-07-26T12:00:00.000+09:00',
      }),
    ).rejects.toThrow();

    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS c FROM satoyama_onboarding_answer_events')
        .get(),
    ).toEqual({ c: 0 });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS c FROM friend_tags WHERE friend_id = ?').get('friend-1'),
    ).toEqual({ c: 0 });
    expect(
      sqlite.prepare('SELECT metadata FROM friends WHERE id = ?').get('friend-1'),
    ).toEqual({ metadata: '{"keep":"yes"}' });
  });

  it('never downgrades a completed answer to skipped', async () => {
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'automation', role: 'owner', area: 'admin' },
      idempotencyKey: 'idem-000000000006',
      tags,
      now: '2026-07-26T12:00:00.000+09:00',
    });
    const state = await skipSatoyamaOnboarding(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      now: '2026-07-26T12:10:00.000+09:00',
    });
    expect(state.status).toBe('completed');
    const friend = sqlite
      .prepare('SELECT metadata FROM friends WHERE id = ?')
      .get('friend-1') as { metadata: string };
    expect(JSON.parse(friend.metadata).sb_onboarding_status).toBe('complete');
  });

  it('schedules and claims the 48-hour reminder at most once, and supports unfollow cancellation', async () => {
    await scheduleSatoyamaOnboardingReminder(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      now: '2026-07-26T12:00:00.000+09:00',
      dueAt: '2026-07-28T12:00:00.000+09:00',
    });
    await scheduleSatoyamaOnboardingReminder(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      now: '2026-07-26T13:00:00.000+09:00',
      dueAt: '2026-07-28T13:00:00.000+09:00',
    });
    expect(
      await claimSatoyamaOnboardingReminder(db, {
        lineAccountId: 'account-1',
        friendId: 'friend-3',
        now: '2026-07-28T12:00:00.000+09:00',
      }),
    ).toBe(true);
    expect(
      await claimSatoyamaOnboardingReminder(db, {
        lineAccountId: 'account-1',
        friendId: 'friend-3',
        now: '2026-07-28T12:00:01.000+09:00',
      }),
    ).toBe(false);
    await markSatoyamaOnboardingReminderResult(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      now: '2026-07-28T12:00:02.000+09:00',
      sent: false,
    });
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-3')).toMatchObject({
      reminder_attempts: 1,
      reminder_due_at: null,
      reminder_error_code: 'send_failed',
    });

    await scheduleSatoyamaOnboardingReminder(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      now: '2026-07-26T12:00:00.000+09:00',
      dueAt: '2026-07-28T12:00:00.000+09:00',
    });
    await cancelSatoyamaOnboardingReminder(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      now: '2026-07-27T12:00:00.000+09:00',
    });
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toMatchObject({
      reminder_due_at: null,
      reminder_cancelled_at: '2026-07-27T12:00:00.000+09:00',
    });
  });

  it('applies retention only to SATOYAMA data and preserves unrelated friend data', async () => {
    const old = '2026-03-01T12:00:00.000+09:00';
    const recent = '2026-07-01T12:00:00.000+09:00';
    const now = '2026-07-27T12:00:00.000+09:00';

    await markSatoyamaOnboardingQuestionsStarted(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      now: old,
    });
    await markSatoyamaOnboardingBonusOpened(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      kind: 'common',
      now: old,
    });
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      answers: { issue: 'key_person', role: 'owner', area: 'admin' },
      idempotencyKey: 'retention-old-answer',
      tags,
      now: old,
    });
    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      answers: { issue: 'automation', role: 'frontline', area: 'content' },
      idempotencyKey: 'retention-recent-answer',
      tags,
      now: recent,
    });
    await markSatoyamaOnboardingBonusOpened(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      kind: 'issue',
      now: recent,
    });
    await markSatoyamaOnboardingCtaClicked(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-3',
      now: recent,
    });

    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      answers: { issue: 'handoff', role: 'internal_lead', area: 'sales' },
      idempotencyKey: 'retention-unfollowed-answer',
      tags,
      now: recent,
    });
    sqlite.exec(`
      INSERT INTO tags (id, name, color, created_at)
      VALUES ('tag-keep', '既存の手動タグ', '#000000', '${recent}');
      INSERT INTO friend_tags (friend_id, tag_id, assigned_at)
      VALUES ('friend-1', 'tag-keep', '${recent}');
      UPDATE friends
         SET is_following = 0,
             updated_at = '2026-07-26T12:00:00.000+09:00'
       WHERE id = 'friend-1';
    `);
    await markSatoyamaOnboardingFollowState(db, {
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      isFollowing: false,
      now: '2026-05-01T12:00:00.000+09:00',
    });

    await saveSatoyamaOnboardingAnswers(db, {
      lineAccountId: 'account-2',
      friendId: 'friend-2',
      answers: { issue: 'safe_rules', role: 'owner', area: 'admin' },
      idempotencyKey: 'retention-other-account',
      tags,
      now: old,
    });

    const result = await applySatoyamaOnboardingRetention(db, {
      lineAccountId: 'account-1',
      now,
    });

    expect(result).toEqual({
      answerEventsDeleted: 1,
      statesWithOldTimestampsCleared: 1,
      unfollowedTagAssignmentsDeleted: 3,
      unfollowedStatesDeleted: 1,
      unfollowedAnswerEventsDeleted: 1,
      unfollowedFriendMetadataCleared: 1,
    });
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-3')).toMatchObject({
      issue_code: 'automation',
      role_code: 'frontline',
      area_code: 'content',
      questions_started_at: null,
      common_bonus_opened_at: null,
      issue_bonus_opened_at: recent,
      cta_clicked_at: recent,
    });
    expect(await getSatoyamaOnboardingState(db, 'account-1', 'friend-1')).toBeNull();
    expect(
      sqlite
        .prepare(
          `SELECT idempotency_key
             FROM satoyama_onboarding_answer_events
            WHERE line_account_id = 'account-1'
            ORDER BY idempotency_key`,
        )
        .all(),
    ).toEqual([{ idempotency_key: 'retention-recent-answer' }]);
    expect(
      sqlite
        .prepare(
          `SELECT t.name
             FROM friend_tags ft
             JOIN tags t ON t.id = ft.tag_id
            WHERE ft.friend_id = 'friend-1'`,
        )
        .all(),
    ).toEqual([{ name: '既存の手動タグ' }]);
    const unfollowedFriend = sqlite
      .prepare('SELECT metadata, updated_at FROM friends WHERE id = ?')
      .get('friend-1') as { metadata: string; updated_at: string };
    expect(JSON.parse(unfollowedFriend.metadata)).toEqual({ keep: 'yes' });
    expect(unfollowedFriend.updated_at).toBe('2026-07-26T12:00:00.000+09:00');
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c
             FROM satoyama_onboarding_answer_events
            WHERE line_account_id = 'account-2'`,
        )
        .get(),
    ).toEqual({ c: 1 });
  });
});
