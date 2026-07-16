import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  requestAdminMagicLinkUrl,
  buildAdminDashboardReply,
  redactAdminMagicLinkForLog,
  ADMIN_DASHBOARD_STATIC_URL,
  ADMIN_DASHBOARD_FALLBACK_MESSAGE,
} from './adminMagicLink.js';

function mockFetchResponse(overrides: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? 'OK',
    json: overrides.json ?? (async () => ({})),
  } as unknown as Response;
}

describe('requestAdminMagicLinkUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('backendUrl/backendSecretが未設定ならfetchを呼ばずnull', async () => {
    const result = await requestAdminMagicLinkUrl({});
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('backendSecretのみ未設定ならnull', async () => {
    const result = await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app' });
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('POST /api/admin/magic-link をBearer認証で叩き、urlを返す', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ url: 'https://example.vercel.app/admin-login?token=abc123' }) }),
    );

    const result = await requestAdminMagicLinkUrl({
      backendUrl: 'https://example.vercel.app',
      backendSecret: 'shared-secret',
    });

    expect(result).toBe('https://example.vercel.app/admin-login?token=abc123');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://example.vercel.app/api/admin/magic-link');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer shared-secret');
  });

  test('末尾スラッシュ付きbackendUrlでも二重スラッシュにならない', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ url: 'https://example.vercel.app/admin-login?token=x' }) }),
    );

    await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app/', backendSecret: 's' });

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://example.vercel.app/api/admin/magic-link');
  });

  test('非200レスポンスはnull', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ ok: false, status: 503 }));
    const result = await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(result).toBeNull();
  });

  test('urlフィールドが無いレスポンスはnull', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({}) }));
    const result = await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(result).toBeNull();
  });

  test('https以外のurlはnull（不正レスポンス防御）', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({ url: 'javascript:alert(1)' }) }));
    const result = await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(result).toBeNull();
  });

  test('fetchが例外を投げてもnull（タイムアウト等）', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));
    const result = await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(result).toBeNull();
  });

  test('JSONパースに失敗してもnull', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => { throw new Error('invalid json'); } }),
    );
    const result = await requestAdminMagicLinkUrl({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(result).toBeNull();
  });
});

describe('buildAdminDashboardReply', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('発行成功時はワンタイムURLをそのまま返す', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ url: 'https://example.vercel.app/admin-login?token=abc123' }) }),
    );

    const reply = await buildAdminDashboardReply({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(reply).toBe('https://example.vercel.app/admin-login?token=abc123');
  });

  test('発行失敗時は固定URL＋外部ブラウザ案内にフォールバックする', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const reply = await buildAdminDashboardReply({ backendUrl: 'https://example.vercel.app', backendSecret: 's' });
    expect(reply).toBe(ADMIN_DASHBOARD_FALLBACK_MESSAGE);
    expect(reply).toContain(ADMIN_DASHBOARD_STATIC_URL);
    expect(reply).toContain('外部ブラウザ');
  });

  test('env未設定（CHAT_BACKEND_URL/SECRET未投入）でもフォールバックする', async () => {
    const reply = await buildAdminDashboardReply({});
    expect(reply).toBe(ADMIN_DASHBOARD_FALLBACK_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('redactAdminMagicLinkForLog', () => {
  test('magic link URLのtoken部分をマスクする', () => {
    const redacted = redactAdminMagicLinkForLog('https://example.vercel.app/admin-login?token=super-secret-value');
    expect(redacted).toBe('https://example.vercel.app/admin-login?token=[REDACTED]');
    expect(redacted).not.toContain('super-secret-value');
  });

  test('magic link以外の返信（固定URL・フォールバック文言）はそのまま返す', () => {
    expect(redactAdminMagicLinkForLog(ADMIN_DASHBOARD_STATIC_URL)).toBe(ADMIN_DASHBOARD_STATIC_URL);
    expect(redactAdminMagicLinkForLog(ADMIN_DASHBOARD_FALLBACK_MESSAGE)).toBe(ADMIN_DASHBOARD_FALLBACK_MESSAGE);
  });

  test('他のオーナーコマンドの返信文字列にも影響しない', () => {
    expect(redactAdminMagicLinkForLog('こんにちは')).toBe('こんにちは');
  });
});
