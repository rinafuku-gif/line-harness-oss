import { toJstString } from '@line-crm/db';

/**
 * Gemini 経由での LINE 相談窓口 一次応答生成。
 *
 * Cloudflare Workers ランタイムのため Node SDK は使わず fetch で REST API を叩く
 * (packages 配下の他プロジェクトの Gemini 呼び出しと同じエンドポイント/モデル規約)。
 * 呼び出し元 (webhook.ts) は失敗/タイムアウトを catch し、従来のフォールバック
 * (upsertChatOnMessage のみ・返信なし) に倒すこと。
 */
const GEMINI_MODEL = 'gemini-flash-latest';

// LINE の replyToken は発行から約1分で失効する。ただし webhook 本体は
// waitUntil 内の非同期処理として実行されるため、LINE への 200 応答自体は
// 先に返却済み — ここでの制約は「replyToken 失効前に返信を試みる」こと。
// 暴走呼び出しを防ぐための上限として 12 秒に設定する。
const GEMINI_TIMEOUT_MS = 12_000;

const GEMINI_MAX_OUTPUT_TOKENS = 512;

export interface InvokeLLMOptions {
  apiKey: string;
  prompt: string;
  timeoutMs?: number;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

/**
 * Gemini にプロンプトを送り、テキスト応答を1つ返す。
 * 失敗時 (HTTP エラー / タイムアウト / 予期しないレスポンス形状) は例外を投げる。
 * 呼び出し元で catch してフォールバックすること。
 */
export async function invokeLLM({ apiKey, prompt, timeoutMs = GEMINI_TIMEOUT_MS }: InvokeLLMOptions): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as GeminiGenerateContentResponse;
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text || !text.trim()) {
    throw new Error('Gemini API returned no text');
  }

  return text.trim();
}

// 直近 60 秒に同一 friend からの incoming メッセージが何件までなら LLM 呼び出しを
// 許可するか。LLM コスト暴発防止が目的で、正規の連投会話まで塞がないよう 3 件は許容する。
const CONSULTATION_RATE_LIMIT_WINDOW_MS = 60_000;
const CONSULTATION_RATE_LIMIT_MAX = 3;

/**
 * 直近 60 秒に同一 friend からの incoming メッセージが CONSULTATION_RATE_LIMIT_MAX 件を
 * 超えていたら true (= LLM 呼び出しをスキップして従来フォールバックへ)。
 *
 * 新規テーブルは作らず既存 messages_log を利用する。webhook.ts は受信テキストを
 * この判定より前に messages_log へ INSERT 済みなので、今回受信した分もこの
 * カウントに含まれる（= 4件目の受信でスキップに転じる）。
 */
export async function isConsultationRateLimited(db: D1Database, friendId: string): Promise<boolean> {
  const cutoff = toJstString(new Date(Date.now() - CONSULTATION_RATE_LIMIT_WINDOW_MS));

  const row = await db
    .prepare(
      `SELECT COUNT(*) as count FROM messages_log
       WHERE friend_id = ? AND direction = 'incoming' AND created_at >= ?`,
    )
    .bind(friendId, cutoff)
    .first<{ count: number }>();

  const count = row?.count ?? 0;
  return count > CONSULTATION_RATE_LIMIT_MAX;
}
