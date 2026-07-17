import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  isChatParityEnabled,
  invokeChatBackend,
  fetchBookingSlots,
  submitBooking,
  formatSlotLabel,
  formatDayLabel,
  toJstDateKey,
  buildSlotPostbackData,
  parseSlotPostbackData,
  buildSlotPickerFlexContents,
  groupSlotsByJstDay,
  filterSlotsByJstDay,
  buildDayPostbackData,
  parseDayPostbackData,
  buildDayPickerFlexContents,
  buildQuickReplyItems,
  QUICK_REPLY_MAX_ITEMS,
  QUICK_REPLY_LABEL_MAX_LENGTH,
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

  test('passes through quickReplies when the backend returns a non-empty array (2026-07-17追加)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        json: async () => ({ reply: '今どんなことに困っていますか？', book: false, escalate: false, quickReplies: ['予約対応', '発信', 'その他'] }),
      }),
    );

    const result = await invokeChatBackend({ backendUrl: 'https://x', backendSecret: 's', lineUserId: 'U1', message: 'm' });
    expect(result.quickReplies).toEqual(['予約対応', '発信', 'その他']);
  });

  test('omits quickReplies when the backend does not include it (defaults to undefined)', async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ json: async () => ({ reply: 'ok', book: false, escalate: false }) }));

    const result = await invokeChatBackend({ backendUrl: 'https://x', backendSecret: 's', lineUserId: 'U1', message: 'm' });
    expect(result.quickReplies).toBeUndefined();
  });

  test('treats an empty quickReplies array from the backend as undefined', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ json: async () => ({ reply: 'ok', book: false, escalate: false, quickReplies: [] }) }),
    );

    const result = await invokeChatBackend({ backendUrl: 'https://x', backendSecret: 's', lineUserId: 'U1', message: 'm' });
    expect(result.quickReplies).toBeUndefined();
  });

  test('filters out non-string/empty entries in quickReplies (defensive against a malformed backend)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({
        json: async () => ({ reply: 'ok', book: false, escalate: false, quickReplies: ['有効な選択肢', '', '  ', 42, null] }),
      }),
    );

    const result = await invokeChatBackend({ backendUrl: 'https://x', backendSecret: 's', lineUserId: 'U1', message: 'm' });
    expect(result.quickReplies).toEqual(['有効な選択肢']);
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
  // 2026-07-17: 従来は先頭5件で機械的に切っていたため「今日残り5枠」があると
  // それ以降の日が一切表示されないバグがあった。呼び出し元(webhook.ts)が
  // groupSlotsByJstDay で1日分ずつに絞ってから渡す設計になったため、この関数自体の
  // 上限は「1日の理論上の最大枠数」である14件まで緩和されている。
  test('caps the number of buttons at 14 (1日の理論上の最大枠数) even when more slots are given', () => {
    const slots = Array.from({ length: 20 }, (_, i) => ({
      start: `2026-08-01T${String(1 + i).padStart(2, '0')}:00:00.000Z`,
      end: `2026-08-01T${String(1 + i).padStart(2, '0')}:30:00.000Z`,
    }));

    const bubble = buildSlotPickerFlexContents(slots) as {
      body: { contents: unknown[] };
    };

    expect(bubble.body.contents).toHaveLength(14);
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

  test('without a dateLabel, uses the generic header (backward compatible)', () => {
    const slots = [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }];
    const bubble = buildSlotPickerFlexContents(slots) as {
      header: { contents: Array<{ text: string }> };
    };
    expect(bubble.header.contents[0].text).toBe('空いている日時');
  });

  test('with a dateLabel, the header explicitly names the day', () => {
    const slots = [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }];
    const bubble = buildSlotPickerFlexContents(slots, '8/1(土)') as {
      header: { contents: Array<{ text: string }> };
    };
    expect(bubble.header.contents[0].text).toBe('8/1(土)の空いている時間');
  });
});

describe('toJstDateKey', () => {
  test('extracts the JST date key (YYYY-MM-DD) from a UTC ISO string', () => {
    // 2026-08-01T01:00:00.000Z = 2026-08-01 10:00 JST
    expect(toJstDateKey('2026-08-01T01:00:00.000Z')).toBe('2026-08-01');
  });

  test('rolls over to the next JST day when UTC time crosses midnight JST', () => {
    // 2026-07-31T15:30:00.000Z = 2026-08-01 00:30 JST
    expect(toJstDateKey('2026-07-31T15:30:00.000Z')).toBe('2026-08-01');
  });
});

describe('formatDayLabel', () => {
  test('formats a JST date key as "M/D(曜)"', () => {
    expect(formatDayLabel('2026-08-01')).toBe('8/1(土)');
  });
});

describe('groupSlotsByJstDay', () => {
  test('groups a flat, time-ordered slot list into per-day buckets, preserving date order', () => {
    const slots = [
      { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }, // 8/1 10:00 JST
      { start: '2026-08-01T02:00:00.000Z', end: '2026-08-01T02:30:00.000Z' }, // 8/1 11:00 JST
      { start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' }, // 8/2 10:00 JST
    ];

    const groups = groupSlotsByJstDay(slots);

    expect(groups).toEqual([
      { dateKey: '2026-08-01', label: '8/1(土)', slots: [slots[0], slots[1]] },
      { dateKey: '2026-08-02', label: '8/2(日)', slots: [slots[2]] },
    ]);
  });

  // 回帰テスト: 旧バグ再現ケース。「当日に5枠以上残っている」状況でも、翌日以降の日が
  // 消えずにグルーピングされることを確認する（buildSlotPickerFlexContentsの固定5件
  // キャップと違い、グルーピング自体は全日程を保持する）。
  test('does not drop later days even when the first day alone has more than the old 5-slot cap', () => {
    const day1Slots = Array.from({ length: 6 }, (_, i) => ({
      start: `2026-08-01T0${i}:00:00.000Z`,
      end: `2026-08-01T0${i}:30:00.000Z`,
    }));
    const day2Slot = { start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' };

    const groups = groupSlotsByJstDay([...day1Slots, day2Slot]);

    expect(groups).toHaveLength(2);
    expect(groups[0].dateKey).toBe('2026-08-01');
    expect(groups[0].slots).toHaveLength(6);
    expect(groups[1].dateKey).toBe('2026-08-02');
    expect(groups[1].slots).toHaveLength(1);
  });

  test('caps the number of day groups at 10', () => {
    const slots = Array.from({ length: 14 }, (_, i) => ({
      start: `2026-08-${String(i + 1).padStart(2, '0')}T01:00:00.000Z`,
      end: `2026-08-${String(i + 1).padStart(2, '0')}T01:30:00.000Z`,
    }));

    const groups = groupSlotsByJstDay(slots);

    expect(groups).toHaveLength(10);
  });

  test('returns an empty array for an empty slot list', () => {
    expect(groupSlotsByJstDay([])).toEqual([]);
  });
});

describe('filterSlotsByJstDay', () => {
  test('returns only the slots that fall on the given JST date key', () => {
    const slots = [
      { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' },
      { start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' },
      { start: '2026-08-01T02:00:00.000Z', end: '2026-08-01T02:30:00.000Z' },
    ];

    expect(filterSlotsByJstDay(slots, '2026-08-01')).toEqual([slots[0], slots[2]]);
  });

  test('returns an empty array when no slot matches the date key', () => {
    const slots = [{ start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' }];
    expect(filterSlotsByJstDay(slots, '2026-09-01')).toEqual([]);
  });
});

describe('day postback data round-trip', () => {
  test('buildDayPostbackData / parseDayPostbackData round-trip correctly', () => {
    const data = buildDayPostbackData('2026-08-01');
    expect(data).toBe('CHATBOOK_DAY:2026-08-01');
    expect(parseDayPostbackData(data)).toBe('2026-08-01');
  });

  test('parseDayPostbackData returns null for unrelated postback data (auto_replies / slot postback等)', () => {
    expect(parseDayPostbackData('コスト比較')).toBeNull();
    expect(parseDayPostbackData('')).toBeNull();
    expect(parseDayPostbackData('CHATBOOK_SLOT:2026-08-01T01:00:00.000Z|2026-08-01T01:30:00.000Z')).toBeNull();
  });

  test('parseDayPostbackData returns null for an empty date key', () => {
    expect(parseDayPostbackData('CHATBOOK_DAY:')).toBeNull();
  });
});

describe('buildDayPickerFlexContents', () => {
  test('renders one button per day group, labeled with the slot count', () => {
    const days = [
      {
        dateKey: '2026-08-01',
        label: '8/1(土)',
        slots: [
          { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T01:30:00.000Z' },
          { start: '2026-08-01T02:00:00.000Z', end: '2026-08-01T02:30:00.000Z' },
        ],
      },
      {
        dateKey: '2026-08-02',
        label: '8/2(日)',
        slots: [{ start: '2026-08-02T01:00:00.000Z', end: '2026-08-02T01:30:00.000Z' }],
      },
    ];

    const bubble = buildDayPickerFlexContents(days) as {
      body: { contents: Array<{ action: { data: string; label: string } }> };
    };

    expect(bubble.body.contents).toHaveLength(2);
    expect(bubble.body.contents[0].action.data).toBe('CHATBOOK_DAY:2026-08-01');
    expect(bubble.body.contents[0].action.label).toBe('8/1(土)・2枠');
    expect(bubble.body.contents[1].action.data).toBe('CHATBOOK_DAY:2026-08-02');
    expect(bubble.body.contents[1].action.label).toBe('8/2(日)・1枠');
  });
});

describe('buildQuickReplyItems', () => {
  // 2026-07-17追加: satoyama側(server/_core/lineChatRoute.ts)が返すquickReplies文字列
  // 配列を、LINEのクイックリプライアクション配列に変換する。タップ時はlabelと同じ文言が
  // そのままユーザー発言として送信される（message型アクション）。

  test('converts each option into a message-type quick reply action (label === text)', () => {
    const items = buildQuickReplyItems(['予約対応', '発信']);
    expect(items).toEqual([
      { type: 'action', action: { type: 'message', label: '予約対応', text: '予約対応' } },
      { type: 'action', action: { type: 'message', label: '発信', text: '発信' } },
    ]);
  });

  test(`caps the number of items at LINE's hard limit (${QUICK_REPLY_MAX_ITEMS}) even if the backend sends more`, () => {
    const options = Array.from({ length: 20 }, (_, i) => `選択肢${i + 1}`);
    const items = buildQuickReplyItems(options);
    expect(items).toHaveLength(QUICK_REPLY_MAX_ITEMS);
    expect(items[0].action.label).toBe('選択肢1');
  });

  test(`truncates a label longer than LINE's hard limit (${QUICK_REPLY_LABEL_MAX_LENGTH} chars) but keeps the full text as the tap payload`, () => {
    const longOption = 'あ'.repeat(QUICK_REPLY_LABEL_MAX_LENGTH + 5);
    const items = buildQuickReplyItems([longOption]);
    expect(items[0].action.label).toHaveLength(QUICK_REPLY_LABEL_MAX_LENGTH);
    expect(items[0].action.text).toBe(longOption);
  });

  test('returns an empty array for an empty options list', () => {
    expect(buildQuickReplyItems([])).toEqual([]);
  });
});
