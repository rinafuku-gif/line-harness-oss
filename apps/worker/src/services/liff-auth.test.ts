import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyLiffAccountCaller } from './liff-auth.js';

function accountDb(
  row: { id: string; liff_id: string; login_channel_id: string | null } | null,
): D1Database {
  const statement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(row),
  };
  statement.bind.mockReturnValue(statement);
  return {
    prepare: vi.fn().mockReturnValue(statement),
  } as unknown as D1Database;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyLiffAccountCaller', () => {
  it('verifies against only the login channel selected by the liffId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'U-verified', aud: 'login-channel-satoyama' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const db = accountDb({
      id: 'account-satoyama',
      liff_id: '123456-test',
      login_channel_id: 'login-channel-satoyama',
    });

    const result = await verifyLiffAccountCaller(
      'Bearer signed-id-token',
      '123456-test',
      'account-satoyama',
      { DB: db },
    );

    expect(result).toEqual({
      ok: true,
      lineUserId: 'U-verified',
      accountId: 'account-satoyama',
      liffId: '123456-test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(String(init.body)).toContain('client_id=login-channel-satoyama');
    expect(String(init.body)).toContain('id_token=signed-id-token');
  });

  it('fails closed for unknown LIFF IDs without calling LINE', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyLiffAccountCaller(
      'Bearer token',
      'unknown-liff',
      'account-satoyama',
      { DB: accountDb(null) },
    );
    expect(result).toEqual({ ok: false, reason: 'unknown_liff' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall back to another account when Login channel configuration is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyLiffAccountCaller(
      'Bearer token',
      '123456-test',
      'account-satoyama',
      {
        DB: accountDb({
          id: 'account-satoyama',
          liff_id: '123456-test',
          login_channel_id: null,
        }),
      },
    );
    expect(result).toEqual({ ok: false, reason: 'login_channel_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an audience mismatch even after a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sub: 'U1', aud: 'other-channel' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await verifyLiffAccountCaller(
      'Bearer token',
      '123456-test',
      'account-satoyama',
      {
        DB: accountDb({
          id: 'account-satoyama',
          liff_id: '123456-test',
          login_channel_id: 'expected-channel',
        }),
      },
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('does not expose provider errors when verification is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network with PII')));
    const result = await verifyLiffAccountCaller(
      'Bearer token',
      '123456-test',
      'account-satoyama',
      {
        DB: accountDb({
          id: 'account-satoyama',
          liff_id: '123456-test',
          login_channel_id: 'expected-channel',
        }),
      },
    );
    expect(result).toEqual({ ok: false, reason: 'verification_unavailable' });
  });
});
