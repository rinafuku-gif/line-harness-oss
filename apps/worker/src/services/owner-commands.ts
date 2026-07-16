/**
 * オーナーコマンド — アカウント運営者 (Ryo) 本人の LINE から特定のキーワードを送ると、
 * 固定の応答 (今回は管理画面URL) を即返信する仕組み。
 *
 * 設計方針:
 * - 送信者が OWNER_LINE_USER_IDS (Workers Secret・カンマ区切りの LINE userId) に
 *   含まれない場合は一切反応しない。コマンドの存在自体を非オーナーに漏らさないため、
 *   webhook.ts 側では isOwnerLineUserId() が false のときは matchOwnerCommand() を
 *   呼ばずに通常のメッセージ処理 (auto_reply / AI consultation 等) へそのまま
 *   フォールスルーする。
 * - コマンド表 (OWNER_COMMANDS) にキーを追加するだけで新しいコマンドを増やせる
 *   (例: '予約一覧' → 予約管理画面URL)。
 */

/** コマンド文言 (完全一致・前後空白は許容) → 返信テキスト。 */
export const OWNER_COMMANDS: Record<string, string> = {
  管理画面: 'https://satoyama-ai-base.vercel.app/admin',
};

/**
 * OWNER_LINE_USER_IDS の生値 (カンマ区切り、前後空白許容) を Set に変換する。
 * 未設定 / 空文字なら空 Set を返す (=誰もオーナーとして扱われない=安全側デフォルト)。
 */
export function parseOwnerLineUserIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** 送信者の LINE userId がオーナー登録済みかどうか。 */
export function isOwnerLineUserId(userId: string | undefined, raw: string | undefined): boolean {
  if (!userId) return false;
  return parseOwnerLineUserIds(raw).has(userId);
}

/**
 * incomingText が既知のオーナーコマンドと完全一致 (前後空白は許容) するかを判定し、
 * 一致すれば返信テキストを返す。一致しなければ null。
 * 呼び出し側 (webhook.ts) で isOwnerLineUserId() が true のときのみ呼ぶこと。
 */
export function matchOwnerCommand(incomingText: string): string | null {
  const key = incomingText.trim();
  return Object.prototype.hasOwnProperty.call(OWNER_COMMANDS, key) ? OWNER_COMMANDS[key] : null;
}
