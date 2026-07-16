/**
 * 外部チャットバックエンド連携（LINE相談窓口のAI一次応答をWebチャットと同一人格に
 * するための汎用クライアント）。
 *
 * 特定サービス固有のプロンプト・トーンはこのリポジトリに置かない設計（公開forkに
 * 事業固有の文面を漏らさない方針）。ここは「外部バックエンドを叩いて
 * reply/book/escalate を受け取る」「空き枠を取得する」「予約を確定する」という
 * 3つの汎用APIクライアントのみを持つ。バックエンドのURL/シークレットは
 * wrangler secret（CHAT_BACKEND_URL / CHAT_BACKEND_SECRET）経由で渡す。
 *
 * 呼び出し元 (webhook.ts) は失敗/タイムアウトを catch し、既存の相談窓口フォール
 * バック（services/llm.ts の単発Gemini応答）に倒すこと。
 */

const CHAT_BACKEND_TIMEOUT_MS = 8_000;
const BOOKING_TIMEOUT_MS = 8_000;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

// ─── ゲート判定（Ryo限定テスト） ──────────────────────────────────────────

export interface ChatParityGateEnv {
  testUserIds?: string;
  parityEnabled?: string;
}

/**
 * 新フロー（外部チャットバックエンド連携＋LINEトーク内予約）を有効にするか。
 * - parityEnabled === 'all' → 全員に有効
 * - testUserIds にカンマ区切りで含まれる line_user_id のみ有効
 * - どちらも未設定/不一致 → 無効（=デプロイしただけでは何も変わらないフェイルセーフ）
 */
export function isChatParityEnabled(lineUserId: string, env: ChatParityGateEnv): boolean {
  if (env.parityEnabled === 'all') return true;
  if (!env.testUserIds) return false;
  const ids = env.testUserIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.includes(lineUserId);
}

// ─── AI一次応答（POST /api/line/chat） ────────────────────────────────────

export interface ChatBackendReply {
  reply: string;
  book: boolean;
  escalate: boolean;
}

export interface InvokeChatBackendOptions {
  backendUrl: string;
  backendSecret: string;
  lineUserId: string;
  message: string;
  timeoutMs?: number;
}

export async function invokeChatBackend(opts: InvokeChatBackendOptions): Promise<ChatBackendReply> {
  const res = await fetch(joinUrl(opts.backendUrl, '/api/line/chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.backendSecret}`,
    },
    body: JSON.stringify({ lineUserId: opts.lineUserId, message: opts.message }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? CHAT_BACKEND_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`chat backend error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json().catch(() => null)) as Partial<ChatBackendReply> | null;
  if (!json || typeof json.reply !== 'string' || !json.reply.trim()) {
    throw new Error('chat backend returned no reply text');
  }

  return { reply: json.reply, book: Boolean(json.book), escalate: Boolean(json.escalate) };
}

// ─── 空き枠取得（GET /api/line/booking/slots） ────────────────────────────

export interface BookingSlot {
  start: string;
  end: string;
}

export type SlotsResult =
  | { ok: true; slots: BookingSlot[] }
  | { ok: false; reason: 'not_configured' | 'fetch_failed'; message?: string };

export interface FetchBookingSlotsOptions {
  backendUrl: string;
  backendSecret: string;
  timeoutMs?: number;
}

export async function fetchBookingSlots(opts: FetchBookingSlotsOptions): Promise<SlotsResult> {
  try {
    const res = await fetch(joinUrl(opts.backendUrl, '/api/line/booking/slots'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.backendSecret}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? BOOKING_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { ok: false, reason: 'fetch_failed' };
    }

    const json = (await res.json().catch(() => null)) as
      | { ok: true; slots?: BookingSlot[] }
      | { ok: false; reason?: 'not_configured' | 'fetch_failed'; message?: string }
      | null;

    if (!json) return { ok: false, reason: 'fetch_failed' };
    if (json.ok) return { ok: true, slots: json.slots ?? [] };
    return { ok: false, reason: json.reason ?? 'fetch_failed', message: json.message };
  } catch (err) {
    console.error('[chatBackend] fetchBookingSlots failed', err);
    return { ok: false, reason: 'fetch_failed' };
  }
}

// ─── 予約確定（POST /api/line/booking） ───────────────────────────────────

export type BookingErrorCode =
  | 'invalid_input'
  | 'invalid_slot'
  | 'unauthorized'
  | 'slot_taken'
  | 'not_configured'
  | 'internal_error';

export type BookingSubmitResult =
  | { success: true; reservationId: number; start: string; end: string; meetLink?: string }
  | { success: false; code: BookingErrorCode };

export interface SubmitBookingOptions {
  backendUrl: string;
  backendSecret: string;
  start: string;
  name: string;
  email?: string;
  lineUserId: string;
  timeoutMs?: number;
}

export async function submitBooking(opts: SubmitBookingOptions): Promise<BookingSubmitResult> {
  try {
    const res = await fetch(joinUrl(opts.backendUrl, '/api/line/booking'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.backendSecret}`,
      },
      body: JSON.stringify({
        start: opts.start,
        name: opts.name,
        email: opts.email || undefined,
        lineUserId: opts.lineUserId,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? BOOKING_TIMEOUT_MS),
    });

    if (res.status === 401) {
      return { success: false, code: 'unauthorized' };
    }

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (res.status === 201 && json?.success === true) {
      return {
        success: true,
        reservationId: json.reservationId as number,
        start: json.start as string,
        end: json.end as string,
        meetLink: typeof json.meetLink === 'string' ? json.meetLink : undefined,
      };
    }

    const code = typeof json?.code === 'string' ? (json.code as BookingErrorCode) : 'internal_error';
    return { success: false, code };
  } catch (err) {
    console.error('[chatBackend] submitBooking failed', err);
    return { success: false, code: 'internal_error' };
  }
}

// ─── 表示用フォーマット ────────────────────────────────────────────────────

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** UTC ISO8601 文字列を「8/1(金) 10:00」形式の JST 表示に変換する。 */
export function formatSlotLabel(isoUtc: string): string {
  const date = new Date(isoUtc);
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const weekday = WEEKDAYS_JA[jst.getUTCDay()];
  const hours = String(jst.getUTCHours()).padStart(2, '0');
  const minutes = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${month}/${day}(${weekday}) ${hours}:${minutes}`;
}

/** 空き枠選択用の postback data のプレフィックス（webhook.ts のハンドラと共有）。 */
export const CHATBOOK_SLOT_PREFIX = 'CHATBOOK_SLOT:';

export function buildSlotPostbackData(slot: BookingSlot): string {
  return `${CHATBOOK_SLOT_PREFIX}${slot.start}|${slot.end}`;
}

export function parseSlotPostbackData(data: string): BookingSlot | null {
  if (!data.startsWith(CHATBOOK_SLOT_PREFIX)) return null;
  const [start, end] = data.slice(CHATBOOK_SLOT_PREFIX.length).split('|');
  if (!start || !end) return null;
  return { start, end };
}

/** 空き枠一覧（最大5件）を選択ボタン付き Flex bubble の JSON として組み立てる。 */
export function buildSlotPickerFlexContents(slots: BookingSlot[]): object {
  const limited = slots.slice(0, 5);
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      backgroundColor: '#f5f2eb',
      contents: [{ type: 'text', text: '空いている日時', size: 'md', weight: 'bold', color: '#1a1a1a' }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: limited.map((slot) => ({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: formatSlotLabel(slot.start),
          data: buildSlotPostbackData(slot),
          displayText: `${formatSlotLabel(slot.start)} を選びました`,
        },
      })),
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'text', text: 'ご希望の日時をタップしてください', size: 'xs', color: '#64748b', wrap: true },
      ],
    },
  };
}
