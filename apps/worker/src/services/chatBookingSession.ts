/**
 * チャット駆動の予約フロー（空き枠提示 → 日時選択 → 氏名/メール収集 → 確定）の
 * 会話状態を D1 (chat_booking_sessions) で管理する。
 *
 * 会話履歴そのもの（LLMに渡す文脈）は外部チャットバックエンド側の責務
 * （services/chatBackend.ts が呼び出す POST /line/chat が内部で保持する）。
 * ここで扱うのは「今どのステップか」だけの軽量な状態機械。
 */

export type ChatBookingState = 'awaiting_slot_selection' | 'awaiting_name' | 'awaiting_email';

export interface ChatBookingSession {
  friendId: string;
  state: ChatBookingState;
  selectedStart: string | null;
  selectedEnd: string | null;
  name: string | null;
  updatedAt: string;
}

// 途中離脱したユーザーが数日後に無関係なメッセージを送った時、フローに
// 引っかかったままにしないための有効期限。この時間を超えたセッションは
// 読み出し時に自動的に破棄する。
const SESSION_TTL_MS = 30 * 60 * 1000; // 30分

interface ChatBookingSessionRow {
  friend_id: string;
  state: ChatBookingState;
  selected_start: string | null;
  selected_end: string | null;
  name: string | null;
  updated_at: string;
}

function rowToSession(row: ChatBookingSessionRow): ChatBookingSession {
  return {
    friendId: row.friend_id,
    state: row.state,
    selectedStart: row.selected_start,
    selectedEnd: row.selected_end,
    name: row.name,
    updatedAt: row.updated_at,
  };
}

/**
 * 有効なセッションを取得する。TTL超過（放置されたセッション）は自動削除して
 * null を返す — 呼び出し元は「セッションなし」として通常のチャット/自動応答
 * フローに戻ればよい。
 */
export async function getChatBookingSession(
  db: D1Database,
  friendId: string,
): Promise<ChatBookingSession | null> {
  const row = await db
    .prepare(
      `SELECT friend_id, state, selected_start, selected_end, name, updated_at
       FROM chat_booking_sessions WHERE friend_id = ?`,
    )
    .bind(friendId)
    .first<ChatBookingSessionRow>();

  if (!row) return null;

  // updated_at はこのテーブルの DEFAULT (strftime '+9 hours') 由来で
  // オフセット接尾辞なしの JST naive 文字列。jstNow()/toJstString() が
  // 生成する "+09:00" 付き文字列とは別形式なので、比較時に明示的に付与する。
  const updatedAtMs = new Date(`${row.updated_at}+09:00`).getTime();
  if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > SESSION_TTL_MS) {
    await clearChatBookingSession(db, friendId);
    return null;
  }

  return rowToSession(row);
}

/**
 * セッションを新規作成 or 更新する（upsert）。渡さなかったフィールドは
 * 既存値を保持する（例: 日時再選択時に name を消さない）。
 */
export async function upsertChatBookingSession(
  db: D1Database,
  friendId: string,
  patch: {
    state: ChatBookingState;
    selectedStart?: string | null;
    selectedEnd?: string | null;
    name?: string | null;
  },
): Promise<void> {
  const existing = await getChatBookingSession(db, friendId);
  const selectedStart =
    patch.selectedStart !== undefined ? patch.selectedStart : (existing?.selectedStart ?? null);
  const selectedEnd =
    patch.selectedEnd !== undefined ? patch.selectedEnd : (existing?.selectedEnd ?? null);
  const name = patch.name !== undefined ? patch.name : (existing?.name ?? null);

  await db
    .prepare(
      `INSERT INTO chat_booking_sessions (friend_id, state, selected_start, selected_end, name, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
       ON CONFLICT(friend_id) DO UPDATE SET
         state = excluded.state,
         selected_start = excluded.selected_start,
         selected_end = excluded.selected_end,
         name = excluded.name,
         updated_at = excluded.updated_at`,
    )
    .bind(friendId, patch.state, selectedStart, selectedEnd, name)
    .run();
}

export async function clearChatBookingSession(db: D1Database, friendId: string): Promise<void> {
  await db.prepare('DELETE FROM chat_booking_sessions WHERE friend_id = ?').bind(friendId).run();
}
