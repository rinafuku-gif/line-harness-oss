import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { invokeLLM, isConsultationRateLimited } from './llm.js';

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

describe('invokeLLM', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns trimmed text from a successful Gemini response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '  担当者が確認のうえご連絡します。  ' }] } }],
        }),
      }),
    );

    const result = await invokeLLM({ apiKey: 'test-key', prompt: 'ユーザーの質問です' });

    expect(result).toBe('担当者が確認のうえご連絡します。');
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('generativelanguage.googleapis.com');
    expect(String(url)).toContain('key=test-key');
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init?.body as string);
    expect(body.contents[0].parts[0].text).toBe('ユーザーの質問です');
  });

  test('throws when the Gemini API responds with a non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ ok: false, status: 500, statusText: 'Internal Server Error' }));

    await expect(invokeLLM({ apiKey: 'test-key', prompt: 'test prompt' })).rejects.toThrow('Gemini API error');
  });

  test('throws when the response has no candidates/text', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({ candidates: [] }) }));

    await expect(invokeLLM({ apiKey: 'test-key', prompt: 'test prompt' })).rejects.toThrow('Gemini API returned no text');
  });

  test('propagates rejection when fetch itself fails (timeout/network error)', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));

    await expect(invokeLLM({ apiKey: 'test-key', prompt: 'test prompt' })).rejects.toThrow();
  });

  test('sends thinkingConfig.thinkingBudget=0 to avoid thinking tokens eating maxOutputTokens', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '担当者が確認のうえご連絡します。' } ] }, finishReason: 'STOP' }],
        }),
      }),
    );

    await invokeLLM({ apiKey: 'test-key', prompt: 'test prompt' });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  test('throws (does not return partial text) when finishReason is MAX_TOKENS', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        json: async () => ({
          candidates: [
            {
              content: { parts: [{ text: '大月での古民家民泊における補助金のご利用についてですね。／補助金の' }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
        }),
      }),
    );

    await expect(invokeLLM({ apiKey: 'test-key', prompt: 'test prompt' })).rejects.toThrow('MAX_TOKENS');
  });
});

describe('isConsultationRateLimited', () => {
  function makeDb(count: number | null) {
    const stmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue(count === null ? null : { count }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    return { db, stmt };
  }

  test('returns false when the recent incoming count is within the limit (3)', async () => {
    const { db } = makeDb(3);
    await expect(isConsultationRateLimited(db, 'friend-1')).resolves.toBe(false);
  });

  test('returns true when the recent incoming count exceeds the limit (4)', async () => {
    const { db } = makeDb(4);
    await expect(isConsultationRateLimited(db, 'friend-1')).resolves.toBe(true);
  });

  test('returns false when the query returns no row', async () => {
    const { db } = makeDb(null);
    await expect(isConsultationRateLimited(db, 'friend-1')).resolves.toBe(false);
  });

  test('queries messages_log filtered by friend_id/incoming and binds a ~60s-ago cutoff', async () => {
    const { db, stmt } = makeDb(0);
    const before = Date.now();
    await isConsultationRateLimited(db, 'friend-42');

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('messages_log'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("direction = 'incoming'"));
    expect(stmt.bind).toHaveBeenCalledWith('friend-42', expect.any(String));

    const cutoffArg = stmt.bind.mock.calls[0][1] as string;
    const cutoffMs = new Date(cutoffArg).getTime();
    const ageMs = before - cutoffMs;
    // Cutoff should sit ~60s in the past (allow slack for test execution time).
    expect(ageMs).toBeGreaterThanOrEqual(59_000);
    expect(ageMs).toBeLessThan(65_000);
  });
});
