// LIFF id_token verification.
// Mirrors the helper in routes/booking.ts but lives in services/ so that new
// route modules (e.g. events.ts) can import & share it. booking.ts keeps its
// own copy for now to avoid touching production-stable code in this PR.

import { getLineAccounts } from '@line-crm/db';

export interface VerifyEnv {
  LINE_LOGIN_CHANNEL_ID?: string;
  DB: D1Database;
}

export type VerifyLiffAccountCallerResult =
  | {
      ok: true;
      lineUserId: string;
      accountId: string;
      liffId: string;
    }
  | {
      ok: false;
      reason:
        | 'missing_token'
        | 'unknown_liff'
        | 'login_channel_not_configured'
        | 'invalid_token'
        | 'verification_unavailable';
    };

export async function verifyCallerLineUserId(
  authHeader: string | undefined,
  env: VerifyEnv,
): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) return null;

  const candidates: string[] = [];
  if (env.LINE_LOGIN_CHANNEL_ID) candidates.push(env.LINE_LOGIN_CHANNEL_ID);
  const dbAccounts = await getLineAccounts(env.DB);
  for (const a of dbAccounts) {
    const ch = (a as unknown as { login_channel_id?: string | null }).login_channel_id;
    if (ch && !candidates.includes(ch)) candidates.push(ch);
  }
  for (const channelId of candidates) {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (res.ok) {
      const verified = (await res.json()) as { sub?: string };
      if (verified.sub) return verified.sub;
    }
  }
  return null;
}

/**
 * Verify a LIFF caller against exactly one account.
 *
 * The generic helper above tries all configured Login channels for backwards
 * compatibility. New account-scoped write flows must not do that: the liffId
 * selects one active line_account, and LINE verifies the token against only
 * that account's login_channel_id.
 */
export async function verifyLiffAccountCaller(
  authHeader: string | undefined,
  liffId: string | undefined,
  expectedAccountId: string,
  env: Pick<VerifyEnv, 'DB'>,
): Promise<VerifyLiffAccountCallerResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing_token' };
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) return { ok: false, reason: 'missing_token' };
  if (!liffId || liffId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(liffId)) {
    return { ok: false, reason: 'unknown_liff' };
  }

  const account = await env.DB
    .prepare(
      `SELECT id, liff_id, login_channel_id
         FROM line_accounts
        WHERE id = ?
          AND liff_id = ?
          AND is_active = 1`,
    )
    .bind(expectedAccountId, liffId)
    .first<{
      id: string;
      liff_id: string;
      login_channel_id: string | null;
    }>();
  if (!account) return { ok: false, reason: 'unknown_liff' };
  if (!account.login_channel_id) {
    return { ok: false, reason: 'login_channel_not_configured' };
  }

  try {
    const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: account.login_channel_id,
      }),
    });
    if (!response.ok) return { ok: false, reason: 'invalid_token' };

    const verified = (await response.json()) as { sub?: string; aud?: string };
    if (!verified.sub || (verified.aud && verified.aud !== account.login_channel_id)) {
      return { ok: false, reason: 'invalid_token' };
    }
    return {
      ok: true,
      lineUserId: verified.sub,
      accountId: account.id,
      liffId: account.liff_id,
    };
  } catch {
    return { ok: false, reason: 'verification_unavailable' };
  }
}
