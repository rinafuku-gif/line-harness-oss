import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  getChatBookingSession,
  upsertChatBookingSession,
  clearChatBookingSession,
} from './chatBookingSession.js';

/**
 * D1Database の最小フェイク。chat_booking_sessions テーブル1つだけを Map で模倣し、
 * このサービスが投げる prepare/bind/first/run の呼び方に対応する。
 */
function createFakeD1() {
  const rows = new Map<string, { friend_id: string; state: string; selected_start: string | null; selected_end: string | null; name: string | null; updated_at: string }>();

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.startsWith('SELECT')) {
                const friendId = args[0] as string;
                return (rows.get(friendId) as unknown as T) ?? null;
              }
              throw new Error(`unexpected first() for sql: ${sql}`);
            },
            async run() {
              if (sql.startsWith('INSERT')) {
                const [friendId, state, selectedStart, selectedEnd, name] = args as [
                  string,
                  string,
                  string | null,
                  string | null,
                  string | null,
                ];
                // 本番の DEFAULT (strftime '+9 hours') と同じ「オフセットなし
                // JST壁時計文字列」で保存する（getChatBookingSession が "+09:00" を
                // 補って解釈するのに合わせる）。
                rows.set(friendId, {
                  friend_id: friendId,
                  state,
                  selected_start: selectedStart,
                  selected_end: selectedEnd,
                  name,
                  updated_at: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', ''),
                });
                return { success: true } as unknown;
              }
              if (sql.startsWith('DELETE')) {
                const friendId = args[0] as string;
                rows.delete(friendId);
                return { success: true } as unknown;
              }
              throw new Error(`unexpected run() for sql: ${sql}`);
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, rows };
}

describe('chatBookingSession', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('getChatBookingSession returns null when no session exists', async () => {
    const { db } = createFakeD1();
    const session = await getChatBookingSession(db, 'friend-1');
    expect(session).toBeNull();
  });

  test('upsertChatBookingSession creates a new session, then getChatBookingSession reads it back', async () => {
    const { db } = createFakeD1();

    await upsertChatBookingSession(db, 'friend-1', {
      state: 'awaiting_slot_selection',
    });

    const session = await getChatBookingSession(db, 'friend-1');
    expect(session).toMatchObject({
      friendId: 'friend-1',
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
      name: null,
    });
  });

  test('upsertChatBookingSession preserves fields not included in the patch (e.g. name survives a slot re-selection)', async () => {
    const { db } = createFakeD1();

    await upsertChatBookingSession(db, 'friend-1', {
      state: 'awaiting_email',
      selectedStart: '2026-08-01T01:00:00.000Z',
      selectedEnd: '2026-08-01T01:30:00.000Z',
      name: '山田太郎',
    });

    // 409 slot_taken 再選択のシナリオ: state だけ戻すが name は既存値を保持したい
    await upsertChatBookingSession(db, 'friend-1', {
      state: 'awaiting_slot_selection',
      selectedStart: null,
      selectedEnd: null,
    });

    const session = await getChatBookingSession(db, 'friend-1');
    expect(session?.name).toBe('山田太郎');
    expect(session?.state).toBe('awaiting_slot_selection');
    expect(session?.selectedStart).toBeNull();
  });

  test('clearChatBookingSession removes the session', async () => {
    const { db } = createFakeD1();
    await upsertChatBookingSession(db, 'friend-1', { state: 'awaiting_name' });
    await clearChatBookingSession(db, 'friend-1');

    const session = await getChatBookingSession(db, 'friend-1');
    expect(session).toBeNull();
  });

  // updated_at はサービスの DEFAULT (strftime '+9 hours') と同じ「オフセットなし
  // JST壁時計文字列」で保存されている（getChatBookingSession が読み取り時に "+09:00"
  // を補って解釈する）。テストでも同じ変換で「Xミリ秒前」を模倣する。
  function jstNaiveStringFor(instantMs: number): string {
    return new Date(instantMs + 9 * 60 * 60 * 1000).toISOString().replace('Z', '');
  }

  test('a session older than the TTL is treated as expired and auto-deleted', async () => {
    const { db, rows } = createFakeD1();

    await upsertChatBookingSession(db, 'friend-1', { state: 'awaiting_name' });
    // 手動でタイムスタンプを35分前に巻き戻す（TTL=30分超過）
    const staleRow = rows.get('friend-1')!;
    staleRow.updated_at = jstNaiveStringFor(Date.now() - 35 * 60 * 1000);

    const session = await getChatBookingSession(db, 'friend-1');
    expect(session).toBeNull();
    expect(rows.has('friend-1')).toBe(false);
  });

  test('a session within the TTL is still returned', async () => {
    const { db, rows } = createFakeD1();

    await upsertChatBookingSession(db, 'friend-1', { state: 'awaiting_name' });
    const freshRow = rows.get('friend-1')!;
    freshRow.updated_at = jstNaiveStringFor(Date.now() - 5 * 60 * 1000);

    const session = await getChatBookingSession(db, 'friend-1');
    expect(session).not.toBeNull();
    expect(session?.state).toBe('awaiting_name');
  });
});
