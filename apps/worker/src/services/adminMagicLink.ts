/**
 * LINEオーナーコマンド「管理画面」用: SATOYAMA側のワンタイム入場リンク（magic link）
 * 発行APIを叩き、LINE内蔵ブラウザ（WebView）からでもそのままログインできるURLを取得する。
 *
 * 背景: 従来は固定URL (https://satoyama-ai-base.vercel.app/admin) をそのまま返信していたが、
 * LINE内蔵ブラウザはログインフォームの操作と相性が悪く実質使えなかった（Ryo報告
 * 2026-07-17）。SATOYAMA側が発行する単回使用・短命トークン付きURLを踏むだけでログイン
 * 済み状態になる仕組みに切り替える。
 *
 * 設計方針:
 * - バックエンドURL/シークレットは services/chatBackend.ts と同じ wrangler secret
 *   （CHAT_BACKEND_URL / CHAT_BACKEND_SECRET）を再利用する。SATOYAMA側の
 *   /api/line/chat・/api/line/booking と同一の共有シークレットで認証されるサーバー間
 *   APIのため、新規シークレットは追加しない。
 * - 発行に失敗した場合（未設定・タイムアウト・非200・不正なレスポンス）は例外を投げず
 *   null を返す。呼び出し側（owner-commands.ts）が固定URL + 外部ブラウザ案内へ
 *   フォールバックする（サービス停止にしない）。
 */

const ADMIN_MAGIC_LINK_TIMEOUT_MS = 8_000;

/** 発行APIが使えない場合のフォールバック先（従来の固定URL）。 */
export const ADMIN_DASHBOARD_STATIC_URL = 'https://satoyama-ai-base.vercel.app/admin';

/**
 * フォールバック時の案内文。固定URLはLINE内蔵ブラウザではログインフォームが動作しない
 * 既知の制約があるため、外部ブラウザで開くよう明示する。
 */
export const ADMIN_DASHBOARD_FALLBACK_MESSAGE =
  `${ADMIN_DASHBOARD_STATIC_URL}\n\n※LINE内で開けない場合は、外部ブラウザ（Safari/Chrome等）で開いてログインしてください。`;

export interface AdminMagicLinkEnv {
  backendUrl?: string;
  backendSecret?: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

/**
 * SATOYAMA側 POST /api/admin/magic-link を叩き、ワンタイム入場URLを取得する。
 * 成功時はURL文字列、失敗時（未設定・タイムアウト・非200・不正レスポンス）はnullを返す
 * （例外は投げない＝呼び出し側は常に同期的にフォールバック判断できる）。
 */
export async function requestAdminMagicLinkUrl(
  env: AdminMagicLinkEnv,
  timeoutMs = ADMIN_MAGIC_LINK_TIMEOUT_MS,
): Promise<string | null> {
  if (!env.backendUrl || !env.backendSecret) return null;

  try {
    const res = await fetch(joinUrl(env.backendUrl, '/api/admin/magic-link'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.backendSecret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error(`[adminMagicLink] request failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const json = (await res.json().catch(() => null)) as { url?: string } | null;
    // トークンURLはログに出さない（json.urlの値自体はここでも出力しない）。
    if (!json || typeof json.url !== 'string' || !json.url.startsWith('https://')) {
      console.error('[adminMagicLink] response missing a valid url');
      return null;
    }

    return json.url;
  } catch (err) {
    console.error('[adminMagicLink] request threw', err);
    return null;
  }
}

/**
 * オーナーコマンド「管理画面」の返信テキストを組み立てる。
 * 成功時はワンタイムURLのみ（従来通りURL単体で返す＝LINEが自動でリンクプレビューを出す）、
 * 失敗時は固定URL + 外部ブラウザ案内にフォールバックする。
 */
export async function buildAdminDashboardReply(env: AdminMagicLinkEnv): Promise<string> {
  const url = await requestAdminMagicLinkUrl(env);
  return url ?? ADMIN_DASHBOARD_FALLBACK_MESSAGE;
}

/**
 * messages_log（D1・LINEトーク履歴のダッシュボード表示に使う監査ログ）へ書き込む前に、
 * ワンタイムトークンを含むURLをマスクする。トークンは単回使用・TTL10分だが、
 * DBに生のまま残すと窓口の会話ログを見られただけでその10分間はログイン可能になって
 * しまうため、実際にLINEへ送るテキスト（ownerReply）とログに残すテキストを分ける。
 * magic link以外の返信（固定URL・フォールバック文言等）はそのまま返す。
 */
export function redactAdminMagicLinkForLog(reply: string): string {
  if (!reply.includes('/admin-login?token=')) return reply;
  return reply.replace(/\/admin-login\?token=[^\s]+/, '/admin-login?token=[REDACTED]');
}
