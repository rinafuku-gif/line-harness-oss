import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return {
    ...actual,
    enrollFriendInScenario: vi.fn(),
    jstNow: vi.fn(() => '2026-07-27T20:00:00.000+09:00'),
  };
});

import { enrollFriendInScenario } from '@line-crm/db';
import { syncSatoyamaFollowupScenario } from './satoyama-followup-scenario.js';

interface DbOptions {
  configured?: boolean;
  existing?: { id: string; status: 'active' | 'paused' | 'completed' | 'delivering' } | null;
}

function fakeDb(options: DbOptions = {}): {
  db: D1Database;
  preparedSql: string[];
  binds: unknown[][];
  run: ReturnType<typeof vi.fn>;
} {
  const preparedSql: string[] = [];
  const binds: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });

  const prepare = vi.fn((sql: string) => {
    preparedSql.push(sql);
    const statement = {
      bind: vi.fn((...values: unknown[]) => {
        binds.push(values);
        return statement;
      }),
      first: vi.fn(async () => {
        if (sql.includes('FROM scenarios s')) {
          return options.configured === false
            ? null
            : { id: 'satoyama-onboarding-v1-handoff' };
        }
        if (sql.includes('FROM friend_scenarios')) {
          return options.existing ?? null;
        }
        return null;
      }),
      run,
    };
    return statement;
  });

  return {
    db: { prepare } as unknown as D1Database,
    preparedSql,
    binds,
    run,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enrollFriendInScenario).mockResolvedValue({
    id: 'enrollment-1',
    friend_id: 'friend-1',
    scenario_id: 'satoyama-onboarding-v1-handoff',
    current_step_order: -1,
    status: 'active',
    started_at: '2026-07-27T20:00:00.000+09:00',
    next_delivery_at: '2026-07-28T10:00:00.000+09:00',
    updated_at: '2026-07-27T20:00:00.000+09:00',
  });
});

describe('syncSatoyamaFollowupScenario', () => {
  it('fails closed when the exact account, scenario and attached issue tag do not match', async () => {
    const { db, run } = fakeDb({ configured: false });
    const result = await syncSatoyamaFollowupScenario(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      issue: 'handoff',
    });

    expect(result.status).toBe('not_configured');
    expect(run).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('pauses another active SATOYAMA stream and enrolls the selected issue once', async () => {
    const { db, preparedSql, binds } = fakeDb();
    const result = await syncSatoyamaFollowupScenario(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      issue: 'handoff',
    });

    expect(result).toEqual({
      status: 'enrolled',
      scenarioId: 'satoyama-onboarding-v1-handoff',
    });
    expect(preparedSql.some((sql) => sql.includes("SET status = 'paused'"))).toBe(true);
    expect(binds[0]).toEqual([
      'friend-1',
      'satoyama-onboarding-v1-handoff',
      'account-satoyama',
      '[SB][課題] 引き継ぎ・標準化',
    ]);
    expect(enrollFriendInScenario).toHaveBeenCalledWith(
      db,
      'friend-1',
      'satoyama-onboarding-v1-handoff',
    );
  });

  it('does not duplicate an active enrollment when the same answer is retried', async () => {
    const { db } = fakeDb({
      existing: { id: 'existing-1', status: 'active' },
    });
    const result = await syncSatoyamaFollowupScenario(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      issue: 'handoff',
    });

    expect(result.status).toBe('already_enrolled');
    expect(enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('does not restart a stream that the friend already completed', async () => {
    const { db } = fakeDb({
      existing: { id: 'existing-1', status: 'completed' },
    });
    const result = await syncSatoyamaFollowupScenario(db, {
      lineAccountId: 'account-satoyama',
      friendId: 'friend-1',
      issue: 'handoff',
    });

    expect(result.status).toBe('already_completed');
    expect(enrollFriendInScenario).not.toHaveBeenCalled();
  });
});
