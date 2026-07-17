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

// 2026-07-17 21:42 JST 実機事故を受けて 8_000 → 15_000 に引き上げ。satoyama-ai-base
// (Vercel) 側は LLM生成＋DB書き込みを含み、コールドスタート時は 8秒を超えることがある。
// 8秒で打ち切ると、satoyama側は裏でそのまま生成・DB保存を完了させる一方
// （lineChatRoute.ts はレスポンス送信前にconversations書き込みをawaitする設計）、
// Harness側だけが「バックエンド失敗」と誤判定してエスカレーション文言に落ちる
// タイミング競合が発生した（DB上には正常な応答が残るのにユーザーには別の
// フォールバック文が届く）。LINEのreplyTokenの実用上の猶予（数十秒）内に収まる
// 範囲で余裕を持たせる。
const CHAT_BACKEND_TIMEOUT_MS = 15_000;
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
  /**
   * 2026-07-17追加。バックエンド（satoyama-ai-base server/_core/lineChatRoute.ts）が
   * AIの選択肢提示を機械可読で返す場合のみ入る（契約: docs/line-booking-integration.md
   * §3.3）。存在する場合、Harness側は {@link buildQuickReplyItems} でLINEのクイック
   * リプライ（タップ選択ボタン）に変換して返信に添付する。無ければ従来通り
   * クイックリプライ無しで返信する。
   */
  quickReplies?: string[];
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

  const quickReplies =
    Array.isArray(json.quickReplies) && json.quickReplies.length > 0
      ? json.quickReplies.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;

  return {
    reply: json.reply,
    book: Boolean(json.book),
    escalate: Boolean(json.escalate),
    quickReplies: quickReplies && quickReplies.length > 0 ? quickReplies : undefined,
  };
}

// ─── 予約導線のユーザー起点ゲート（STEP1・2026-07-17追加） ────────────────
//
// 背景: AIが[BOOK_CONSULTATION]（backendReply.book）を出した瞬間に日付ピッカーFlex
// を出す旧仕様は、「1問答えただけで予約枠を押し付ける」体験になっていた
// （プロンプト側の文言調整だけでは是正できず、gemini-2.5-flashが指示を無視する
// 実例が2回発生・docs/line-booking-integration.md参照）。この事故はプロンプトの
// 出力（book true/false）そのものに依存する限り再発しうるため、Flexを実際に出す
// かどうかの最終判定はAI出力に一切依存させず、この2関数（決定論的な文字列一致）
// だけで行う構造に変更した。book=trueの役割は「予約ボタンを返信に添えてよい」
// だけに縮小し、Flexが実際に出るのは下記のいずれかのみ:
//   (a) ユーザーが BOOKING_QUICK_REPLY_LABEL のボタンをタップした（＝そのラベル
//       文字列がそのままテキストとして送られてくる）
//   (b) ユーザー自身が「予約したい」等、人と話す/予約すること自体を明確に求める
//       自由文を送った（webhook.ts側の予約フロー再開メッセージ「改めて『無料相談を
//       予約したい』とお送りください」とも一致させている）

/** LINEクイックリプライに添える「予約する」ボタンのラベル兼、タップ時に送信される文言。 */
export const BOOKING_QUICK_REPLY_LABEL = '無料相談を予約する';

/**
 * 明示的な予約意図のキーワード集合。
 *
 * 2026-07-17 修正（実機バグ: 「AIの導入について相談したいです」のような、ただの
 * 最初の相談発話で日付ピッカーFlexが即出てしまう事故）。
 * 旧版は chatSystemPrompt.ts（satoyama側）の「1回目の発言から人と話すことを明確に
 * 求めている場合の例外」語彙（話したい/相談したい/予約したい/電話したい）をそのまま
 * ここにも転記していたが、それは誤り: あちらはAIが自分の返信に${BOOK_MARKER}を
 * 付けてよいかどうかの“ソフトな”判断材料（book=trueは「予約するボタンを添える」
 * だけに縮小済み・上のコメント参照）に過ぎない。一方この関数はAIを一切介さず
 * Flexを強制的に出す“ハードな”構造ゲートのため、「相談したい」「話したい」
 * 「電話したい」のような一般的な相談の切り出し文言まで拾ってしまうと、AIによる
 * ヒアリング・選択肢提示を一切経ずに予約枠を押し付ける結果になる。
 * → このゲートは「予約」という単語を明確に含む、行動として確定した予約意図の
 * 文言のみに限定する（"相談"単体は予約意図に含めない）。
 */
const EXPLICIT_BOOKING_INTENT_KEYWORDS = [
  '予約したい',
  '予約します',
  '予約する',
  '予約希望',
  '予約お願い',
  '予約をお願い',
];

/**
 * incomingTextが「ユーザー自身が起点となった、明確な予約/相談の意思表示」かどうかを
 * 判定する純関数。AIの応答（book/quickReplies）は一切参照しない。
 */
export function isExplicitBookingIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === BOOKING_QUICK_REPLY_LABEL) return true;
  return EXPLICIT_BOOKING_INTENT_KEYWORDS.some((kw) => trimmed.includes(kw));
}

// ─── クイックリプライ（タップ選択ボタン） ──────────────────────────────────
//
// 2026-07-17追加。chatBackendReply.quickReplies（satoyama側で選択肢の出し方に沿って
// 生成された文字列配列）を、LINEのクイックリプライ用アクション配列に変換する。
// タップするとlabel文字列がそのままユーザー発言としてLINEに送信され、次の
// invokeChatBackend呼び出しのmessageになる（新しいセッション状態は不要）。

/** LINEクイックリプライの仕様上限（label最大20文字・1メッセージにつき最大13件）。 */
export const QUICK_REPLY_LABEL_MAX_LENGTH = 20;
export const QUICK_REPLY_MAX_ITEMS = 13;

export interface QuickReplyActionItem {
  type: 'action';
  action: { type: 'message'; label: string; text: string };
}

/**
 * satoyama側は既にLINEの制約（最大13個・15字程度のラベル）に沿って選択肢を返す設計だが、
 * Harness側でも独立に安全側の上限を適用する（多層防御・プロンプトの追従率に依存しない）。
 * label（ボタン表示・最大20文字）とtext（タップ時に送信される文言）は同じ文字列を使う
 * （ボタンに書かれた通りの発言が送られる方が、ユーザーにとって直感的なため）。
 */
export function buildQuickReplyItems(options: string[]): QuickReplyActionItem[] {
  return options.slice(0, QUICK_REPLY_MAX_ITEMS).map((option) => {
    const label =
      option.length > QUICK_REPLY_LABEL_MAX_LENGTH ? option.slice(0, QUICK_REPLY_LABEL_MAX_LENGTH) : option;
    return {
      type: 'action',
      action: { type: 'message', label, text: option },
    };
  });
}

// ─── 常時表示フォールバック（2026-07-17追加） ──────────────────────────────
//
// 背景: satoyama側のプロンプト（chatSystemPrompt.ts の LINE_QUICK_REPLY_PROMPT_ADDENDUM）
// は「判断に着地したターンにも固定の次アクション選択肢を出す」よう指示しているが、
// LLMの指示追従は確率的（gemini-2.5-flashが同種の指示を無視した実例が過去に複数回
// 発生・chatSystemPrompt.ts参照）であり、プロンプトだけに頼るとまた無言で選択肢が
// 消える回帰が起こりうる。この関数は「satoyama側が何を返してきても、Harnessが
// 組み立てる最終的なクイックリプライは絶対に空にしない」ことを保証する構造的な
// 最終防衛ライン。
//
// 責務分担: satoyama側（AI）は「会話の内容に応じた選択肢」を出す責務、Harness側
// （この関数）は「LINEのUIとして毎ターン必ず何かタップできる状態にする」という
// “画面表示の契約”を守る責務、と役割を分けている。予約ボタンのラベル・実際に
// タップされたときの処理（isExplicitBookingIntent）は既存の仕組みをそのまま使う
// （新しい経路を発明しない）。

/** quickRepliesが空のときに表示する固定の次アクション（LINE_QUICK_REPLY_PROMPT_ADDENDUMの文言と揃えてある）。 */
export const DEFAULT_QUICK_REPLY_FALLBACK: readonly string[] = [
  'もっと詳しく',
  '別のことを相談する',
  BOOKING_QUICK_REPLY_LABEL,
];

/**
 * satoyama側の応答（quickReplies・book）から、Harnessが実際にLINEへ添付する
 * クイックリプライの選択肢一覧を決定する純関数。
 * - book=trueの場合は「無料相談を予約する」ボタンを末尾に加える（AI自身の
 *   quickReplies内に既に同じ文言が含まれていれば重複させない）。
 * - 上記の結果、選択肢が1件も無ければ {@link DEFAULT_QUICK_REPLY_FALLBACK} を返す
 *   （＝毎ターン必ず何かしらタップできるボタンが付く）。
 */
export function resolveQuickReplyOptions(quickReplies: string[] | undefined, book: boolean): string[] {
  const base = quickReplies ?? [];
  const withBooking = book && !base.includes(BOOKING_QUICK_REPLY_LABEL) ? [...base, BOOKING_QUICK_REPLY_LABEL] : base;
  return withBooking.length > 0 ? withBooking : [...DEFAULT_QUICK_REPLY_FALLBACK];
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

/**
 * 1日あたりの営業時間帯（10:00-17:00・30分刻み）で理論上とりうる枠数の上限。
 * satoyama-ai-base 側 server/booking/slots.ts の BUSINESS_START_HOUR(10) /
 * BUSINESS_END_HOUR(17) / SLOT_MINUTES(30) と同じ前提（(17-10)*60/30 = 14）。
 * 1日分の枠を丸ごと見せる時のボタン数上限として使う（従来の固定5件キャップの撤去）。
 */
const MAX_SLOTS_PER_DAY_DISPLAY = 14;

/** 空き枠一覧（最大 {@link MAX_SLOTS_PER_DAY_DISPLAY} 件）を選択ボタン付き Flex bubble の JSON として組み立てる。
 *
 * 2026-07-17修正: 従来は呼び出し元が渡した空き枠配列（14日分の時系列フラットリスト）の
 * 先頭5件を機械的に切り出していたため、「今日残り5枠」がたまたま5件あると、
 * それ以降の全ての日が一切表示されないバグがあった（Ryo実機報告）。この関数自体は
 * 「渡された枠をボタンにする」責務のみ残し、呼び出し元（webhook.ts）が
 * {@link groupSlotsByJstDay} で日ごとにグルーピングしてから、1日分ずつ渡す設計に変更した。
 *
 * @param dateLabel 指定時、ヘッダーに「7/22(水)の空いている時間」のように日付を明示する。
 *   省略時は従来通り汎用の「空いている日時」ヘッダーになる（後方互換）。
 */
export function buildSlotPickerFlexContents(slots: BookingSlot[], dateLabel?: string): object {
  const limited = slots.slice(0, MAX_SLOTS_PER_DAY_DISPLAY);
  const headerText = dateLabel ? `${dateLabel}の空いている時間` : '空いている日時';
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      backgroundColor: '#f5f2eb',
      contents: [{ type: 'text', text: headerText, size: 'md', weight: 'bold', color: '#1a1a1a', wrap: true }],
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
        { type: 'text', text: 'ご希望の時間をタップしてください', size: 'xs', color: '#64748b', wrap: true },
      ],
    },
  };
}

// ─── 日付ごとのグルーピング（日→時間の2段選択フロー） ────────────────────
//
// 2026-07-17追加。GET /api/line/booking/slots は14日分の枠をすべて時系列フラットな
// 配列で返す（satoyama-ai-base server/booking/index.ts のgetAvailableSlots）。
// これをJST日付単位でグルーピングし、「①日にちを選ぶ→②その日の時間を選ぶ」の
// 2段フローに使う。空き枠取得APIの契約（docs/line-booking-integration.md §3.1）は
// 変更していない — グルーピングはHarness側（この関数）だけで完結する。

const WEEKDAYS_JA_DAY = WEEKDAYS_JA;

/** UTC ISO8601 文字列から JST の日付キー（YYYY-MM-DD）を取り出す。 */
export function toJstDateKey(isoUtc: string): string {
  const jst = new Date(new Date(isoUtc).getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** JST日付キー（YYYY-MM-DD）を「7/22(水)」形式のラベルに変換する。 */
export function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map((n) => Number.parseInt(n, 10));
  // UTC基準でその日付の曜日を計算する（JSTの暦日そのものの曜日なのでタイムゾーン変換は不要）。
  const weekday = WEEKDAYS_JA_DAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}/${day}(${weekday})`;
}

export interface SlotDayGroup {
  dateKey: string;
  label: string;
  slots: BookingSlot[];
}

/** 1日あたりに表示する日付ボタンの上限（14日先までの営業日を素直に出すと最大10日前後になる想定）。 */
const MAX_DAY_GROUPS_DISPLAY = 10;

/**
 * 空き枠のフラット配列をJST日付ごとにグルーピングする。入力は
 * fetchBookingSlots() が返す時系列順の配列を想定しており、出力もその順序
 * （＝日付の早い順）を保つ。表示件数の上限は {@link MAX_DAY_GROUPS_DISPLAY}。
 */
export function groupSlotsByJstDay(slots: BookingSlot[]): SlotDayGroup[] {
  const groups: SlotDayGroup[] = [];
  const indexByDateKey = new Map<string, number>();

  for (const slot of slots) {
    const dateKey = toJstDateKey(slot.start);
    const existingIndex = indexByDateKey.get(dateKey);
    if (existingIndex === undefined) {
      indexByDateKey.set(dateKey, groups.length);
      groups.push({ dateKey, label: formatDayLabel(dateKey), slots: [slot] });
    } else {
      groups[existingIndex].slots.push(slot);
    }
  }

  return groups.slice(0, MAX_DAY_GROUPS_DISPLAY);
}

/** 空き枠のフラット配列から、指定したJST日付キーに属するものだけを抽出する（日→時間の2段目で使う）。 */
export function filterSlotsByJstDay(slots: BookingSlot[], dateKey: string): BookingSlot[] {
  return slots.filter((slot) => toJstDateKey(slot.start) === dateKey);
}

/** 日付選択用の postback data のプレフィックス（webhook.ts のハンドラと共有）。 */
export const CHATBOOK_DAY_PREFIX = 'CHATBOOK_DAY:';

export function buildDayPostbackData(dateKey: string): string {
  return `${CHATBOOK_DAY_PREFIX}${dateKey}`;
}

export function parseDayPostbackData(data: string): string | null {
  if (!data.startsWith(CHATBOOK_DAY_PREFIX)) return null;
  const dateKey = data.slice(CHATBOOK_DAY_PREFIX.length);
  return dateKey || null;
}

/** 日付一覧を選択ボタン付き Flex bubble の JSON として組み立てる（時間選択の前段）。 */
export function buildDayPickerFlexContents(days: SlotDayGroup[]): object {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      backgroundColor: '#f5f2eb',
      contents: [{ type: 'text', text: 'ご希望の日を選んでください', size: 'md', weight: 'bold', color: '#1a1a1a', wrap: true }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: days.map((day) => ({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: `${day.label}・${day.slots.length}枠`,
          data: buildDayPostbackData(day.dateKey),
          displayText: `${day.label} を選びました`,
        },
      })),
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'text', text: 'タップすると、その日の空いている時間を表示します', size: 'xs', color: '#64748b', wrap: true },
      ],
    },
  };
}
