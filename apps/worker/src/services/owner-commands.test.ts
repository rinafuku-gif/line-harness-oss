import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { isOwnerLineUserId, matchOwnerCommand, parseOwnerLineUserIds, resolveOwnerCommandReply } from './owner-commands.js';
import { ADMIN_DASHBOARD_FALLBACK_MESSAGE, ADMIN_DASHBOARD_STATIC_URL } from './adminMagicLink.js';

describe('parseOwnerLineUserIds', () => {
  test('splits a comma-separated list and trims whitespace', () => {
    expect(parseOwnerLineUserIds('U-a, U-b ,U-c')).toEqual(new Set(['U-a', 'U-b', 'U-c']));
  });

  test('drops empty segments (trailing comma / blank entries)', () => {
    expect(parseOwnerLineUserIds('U-a,,  ,U-b,')).toEqual(new Set(['U-a', 'U-b']));
  });

  test('returns an empty set when unset or empty (safe default = nobody is owner)', () => {
    expect(parseOwnerLineUserIds(undefined)).toEqual(new Set());
    expect(parseOwnerLineUserIds('')).toEqual(new Set());
  });
});

describe('isOwnerLineUserId', () => {
  test('true when userId is in the configured list', () => {
    expect(isOwnerLineUserId('U-owner', 'U-owner,U-other')).toBe(true);
  });

  test('false when userId is not in the list', () => {
    expect(isOwnerLineUserId('U-stranger', 'U-owner,U-other')).toBe(false);
  });

  test('false when userId is undefined', () => {
    expect(isOwnerLineUserId(undefined, 'U-owner')).toBe(false);
  });

  test('false when OWNER_LINE_USER_IDS is unset — nobody is treated as owner', () => {
    expect(isOwnerLineUserId('U-owner', undefined)).toBe(false);
  });
});

describe('matchOwnerCommand', () => {
  test('returns the admin URL (with openExternalBrowser=1) for an exact "管理画面" match', () => {
    expect(matchOwnerCommand('管理画面')).toBe(
      'https://satoyama-ai-base.vercel.app/admin?openExternalBrowser=1',
    );
  });

  test('tolerates surrounding whitespace', () => {
    expect(matchOwnerCommand('  管理画面  ')).toBe(
      'https://satoyama-ai-base.vercel.app/admin?openExternalBrowser=1',
    );
  });

  test('returns null for unknown text (falls through to normal handling)', () => {
    expect(matchOwnerCommand('こんにちは')).toBeNull();
  });

  test('returns null for partial/contains matches (exact match only)', () => {
    expect(matchOwnerCommand('管理画面を教えて')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(matchOwnerCommand('')).toBeNull();
  });
});

function mockFetchResponse(overrides: { ok?: boolean; json?: () => Promise<unknown> }) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.ok === false ? 500 : 200,
    statusText: 'OK',
    json: overrides.json ?? (async () => ({})),
  } as unknown as Response;
}

describe('resolveOwnerCommandReply', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('「管理画面」は発行APIを叩き、成功時はopenExternalBrowser=1付きのワンタイムURLを返す（固定URLではない）', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ url: 'https://example.vercel.app/admin-login?token=xyz' }) }),
    );

    const reply = await resolveOwnerCommandReply('管理画面', {
      backendUrl: 'https://example.vercel.app',
      backendSecret: 'shared-secret',
    });

    expect(reply).toBe('https://example.vercel.app/admin-login?token=xyz&openExternalBrowser=1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('「管理画面」で発行APIが失敗したら固定URL＋外部ブラウザ案内にフォールバックする', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const reply = await resolveOwnerCommandReply('管理画面', {
      backendUrl: 'https://example.vercel.app',
      backendSecret: 'shared-secret',
    });

    expect(reply).toBe(ADMIN_DASHBOARD_FALLBACK_MESSAGE);
    expect(reply).toContain(ADMIN_DASHBOARD_STATIC_URL);
  });

  test('前後空白があっても「管理画面」として動的解決される', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ url: 'https://example.vercel.app/admin-login?token=xyz' }) }),
    );

    const reply = await resolveOwnerCommandReply('  管理画面  ', { backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(reply).toBe('https://example.vercel.app/admin-login?token=xyz&openExternalBrowser=1');
  });

  test('管理画面以外の未知の文言はnull（発行APIを叩かない）', async () => {
    const reply = await resolveOwnerCommandReply('こんにちは', { backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(reply).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
