import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  isChatParityEnabled,
  invokeChatBackend,
  fetchBookingSlots,
  submitBooking,
  formatSlotLabel,
  buildSlotPostbackData,
  parseSlotPostbackData,
  buildSlotPickerFlexContents,
} from './chatBackend.js';

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

describe('isChatParityEnabled', () => {
  test('returns false when neither testUserIds nor parityEnabled is set (fail-safe default)', () => {
    expect(isChatParityEnabled('U123', {})).toBe(false);
  });

  test('returns true for a user in the comma-separated test list', () => {
    expect(isChatParityEnabled('U123', { testUserIds: 'U111,U123,U999' })).toBe(true);
  });

  test('trims whitespace around ids in the test list', () => {
    expect(isChatParityEnabled('U123', { testUserIds: ' U111 , U123 ,U999 ' })).toBe(true);
  });

  test('returns false for a user not in the test list', () => {
    expect(isChatParityEnabled('U999', { testUserIds: 'U111,U123' })).toBe(false);
  });

  test('returns true for everyone when parityEnabled is "all", regardless of testUserIds', () => {
    expect(isChatParityEnabled('U-anyone', { parityEnabled: 'all' })).toBe(true);
  });

  test('parityEnabled values other than "all" do not enable the flow by themselves', () => {
    expect(isChatParityEnabled('U123', { parityEnabled: 'true' })).toBe(false);
  });
});

describe('invokeChatBackend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends Bearer auth + lineUserId/message and returns reply/book/escalate', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ reply: '無料相談で詳しくお伺いできます。', book: true, escalate: false }) }),
    );

    const result = await invokeChatBackend({
      backendUrl: 'https://example.vercel.app',
      backendSecret: 'secret-value',
      lineUserId: 'U123',
      message: '予約したい',
    });

    expect(result).toEqual({ reply: '無料相談で詳しくお伺いできます。', book: true, escalate: false });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://example.vercel.app/api/line/chat');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-value');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ lineUserId: 'U123', message: '予約したい' });
  });

  test('defaults book/escalate to false when the backend omits them', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({ reply: 'こんにちは' }) }));

    const result = await invokeChatBackend({
      backendUrl: 'https://example.vercel.app',
      backendSecret: 'secret',
      lineUserId: 'U1',
      message: 'hi',
    });

    expect(result).toEqual({ reply: 'こんにちは', book: false, escalate: false });
  });

  test('throws on non-ok HTTP status (caller falls back to Gemini)', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ ok: false, status: 500, statusText: 'Internal Server Error' }));

    await expect(
      invokeChatBackend({ backendUrl: 'https://x', backendSecret: 's', lineUserId: 'U1', message: 'm' }),
    ).rejects.toThrow('chat backend error');
  });

  test('throws when reply text is missing/empty', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({ reply: '   ' }) }));

    await expect(
      invokeChatBackend({ backendUrl: 'https://x', backendSecret: 's', lineUserId: 'U1', message: 'm' }),
    ).rejects.toThrow('no reply text');
  });

  test('strips trailing slash from backendUrl before appending the path', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({ reply: 'ok' }) }));

    await invokeChatBackend({ backendUrl: 'https://example.vercel.app/', backendSecret: 's', lineUserId: 'U1', message: 'm' });

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://example.vercel.app/api/line/chat');
  });
});

describe('fetchBookingSlots', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns ok:true with slots on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        json: async () => ({ ok: true, slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }] }),
      }),
    );

    const result = await fetchBookingSlots({ backendUrl: 'https://x', backendSecret: 's' });
    expect(result).toEqual({ ok: true, slots: [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }] });
  });

  test('passes through ok:false / reason:not_configured with message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ ok: false, reason: 'not_configured', message: '現在ご利用いただけません' }) }),
    );

    const result = await fetchBookingSlots({ backendUrl: 'https://x', backendSecret: 's' });
    expect(result).toEqual({ ok: false, reason: 'not_configured', message: '現在ご利用いただけません' });
  });

  test('returns ok:false/fetch_failed on non-ok HTTP status (never throws)', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ ok: false, status: 401 }));

    const result = await fetchBookingSlots({ backendUrl: 'https://x', backendSecret: 's' });
    expect(result).toEqual({ ok: false, reason: 'fetch_failed' });
  });

  test('returns ok:false/fetch_failed when fetch itself throws (network/timeout)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const result = await fetchBookingSlots({ backendUrl: 'https://x', backendSecret: 's' });
    expect(result).toEqual({ ok: false, reason: 'fetch_failed' });
  });
});

describe('submitBooking', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns success with reservation details on 201', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        status: 201,
        json: async () => ({
          success: true,
          reservationId: 42,
          start: '2026-08-01T01:00:00.000Z',
          end: '2026-08-01T01:30:00.000Z',
          meetLink: 'https://meet.google.com/abc-defg-hij',
        }),
      }),
    );

    const result = await submitBooking({
      backendUrl: 'https://x',
      backendSecret: 's',
      start: '2026-08-01T01:00:00.000Z',
      name: '山田太郎',
      lineUserId: 'U1',
    });

    expect(result).toEqual({
      success: true,
      reservationId: 42,
      start: '2026-08-01T01:00:00.000Z',
      end: '2026-08-01T01:30:00.000Z',
      meetLink: 'https://meet.google.com/abc-defg-hij',
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ start: '2026-08-01T01:00:00.000Z', name: '山田太郎', email: undefined, lineUserId: 'U1' });
  });

  test('omits email from the request body when not provided', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ status: 201, json: async () => ({ success: true, reservationId: 1, start: 's', end: 'e' }) }));

    await submitBooking({ backendUrl: 'https://x', backendSecret: 's', start: 's', name: 'n', lineUserId: 'U1' });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.email).toBeUndefined();
  });

  test('maps 409 slot_taken to a typed error result', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ status: 409, json: async () => ({ success: false, code: 'slot_taken' }) }));

    const result = await submitBooking({ backendUrl: 'https://x', backendSecret: 's', start: 's', name: 'n', lineUserId: 'U1' });
    expect(result).toEqual({ success: false, code: 'slot_taken' });
  });

  test('maps HTTP 401 to code:unauthorized without leaking response body', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ status: 401, json: async () => ({ error: 'Unauthorized' }) }));

    const result = await submitBooking({ backendUrl: 'https://x', backendSecret: 's', start: 's', name: 'n', lineUserId: 'U1' });
    expect(result).toEqual({ success: false, code: 'unauthorized' });
  });

  test('falls back to code:internal_error when fetch throws (network/timeout)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));

    const result = await submitBooking({ backendUrl: 'https://x', backendSecret: 's', start: 's', name: 'n', lineUserId: 'U1' });
    expect(result).toEqual({ success: false, code: 'internal_error' });
  });

  test('falls back to code:internal_error when the error response has no code field', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ status: 500, json: async () => ({ success: false }) }));

    const result = await submitBooking({ backendUrl: 'https://x', backendSecret: 's', start: 's', name: 'n', lineUserId: 'U1' });
    expect(result).toEqual({ success: false, code: 'internal_error' });
  });
});

describe('formatSlotLabel', () => {
  test('formats a UTC ISO string as JST date/weekday/time', () => {
    // 2026-08-01T01:00:00.000Z = 2026-08-01 10:00 JST, which is a Saturday.
    expect(formatSlotLabel('2026-08-01T01:00:00.000Z')).toBe('8/1(土) 10:00');
  });

  test('rolls over to the next JST day when UTC time crosses midnight JST', () => {
    // 2026-07-31T15:30:00.000Z = 2026-08-01 00:30 JST.
    expect(formatSlotLabel('2026-07-31T15:30:00.000Z')).toBe('8/1(土) 00:30');
  });
});

describe('slot postback data round-trip', () => {
  test('buildSlotPostbackData / parseSlotPostbackData round-trip correctly', () => {
    const slot = { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' };
    const data = buildSlotPostbackData(slot);
    expect(data).toBe('CHATBOOK_SLOT:2026-08-01T01:00:00.000Z|2026-08-01T01:30:00.000Z');
    expect(parseSlotPostbackData(data)).toEqual(slot);
  });

  test('parseSlotPostbackData returns null for unrelated postback data (auto_replies etc.)', () => {
    expect(parseSlotPostbackData('コスト比較')).toBeNull();
    expect(parseSlotPostbackData('')).toBeNull();
  });

  test('parseSlotPostbackData returns null for malformed CHATBOOK_SLOT data', () => {
    expect(parseSlotPostbackData('CHATBOOK_SLOT:onlystart')).toBeNull();
  });
});

describe('buildSlotPickerFlexContents', () => {
  test('caps the number of buttons at 5 even when more slots are given', () => {
    const slots = Array.from({ length: 8 }, (_, i) => ({
      start: `2026-08-0${(i % 9) + 1}T01:00:00.000Z`,
      end: `2026-08-0${(i % 9) + 1}T01:30:00.000Z`,
    }));

    const bubble = buildSlotPickerFlexContents(slots) as {
      body: { contents: unknown[] };
    };

    expect(bubble.body.contents).toHaveLength(5);
  });

  test('each button postback data matches the offered slot', () => {
    const slots = [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }];
    const bubble = buildSlotPickerFlexContents(slots) as {
      body: { contents: Array<{ action: { data: string; label: string } }> };
    };

    expect(bubble.body.contents[0].action.data).toBe(
      'CHATBOOK_SLOT:2026-08-01T01:00:00.000Z|2026-08-01T01:30:00.000Z',
    );
    expect(bubble.body.contents[0].action.label).toBe('8/1(土) 10:00');
  });
});
