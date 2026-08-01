// ぽかんと 予約: Googleカレンダー(サービスアカウント)読み取り + 予約ページ + リクエスト保存
// - GET  /api/liff/booking-gcal/availability  … 場所別の空き＋講座（公開）
// - GET  /api/liff/booking-gcal/page          … お客さんの予約ページ（公開）
// - POST /api/liff/booking-gcal/request       … 第1〜3希望のリクエストを保存（公開）
// - GET  /api/booking-gcal/requests           … れいさん用: 保存済みリクエスト一覧（要APIキー）
import { Hono } from 'hono';

const LOCATIONS = ['下北沢', '世田谷・松陰神社前', '千歳船橋', '池袋']; // 常設4拠点（タブ常時表示・現状維持）
// 臨時拠点。カレンダーに拠点名と同じタイトルの予定がある日程の時だけ、予約ページのタブに動的に表示される。
const TEMP_LOCATIONS = ['豊川市', '岡山市', '神戸市', '福岡市', '広島', '今治市', '山梨県・大月市'];
// イベント分類専用（「拠点の予約枠」か「講座」かの判定にのみ使用。タブを常時出すかどうかにはLOCATIONSのみ使う）
const ALL_LOCATION_NAMES = [...LOCATIONS, ...TEMP_LOCATIONS];
// 拠点ごとの住所・アクセス（予約確定・日時変更・前日リマインドの通知文に自動挿入）。
// キーはLOCATIONS/TEMP_LOCATIONSと完全一致させること。該当キーが無い場所は住所行を出さず現状の文面のまま＝フェイルセーフ。
const LOCATION_ADDRESSES: Record<string, string> = {
  '下北沢': '📍東京都世田谷区代沢5-26-13 ベルエール代沢101\n下北沢駅 徒歩7分\n※お時間ちょうどになりましたらインターホンを押してください。',
  '世田谷・松陰神社前': '📍〒154-0023 東京都世田谷区若林4-20-9 若松屋ビル202号室\n世田谷線 松陰神社前駅 徒歩0分',
  '千歳船橋': '📍大きな木の下の暮らしの雑貨店\n東京都世田谷区桜丘3-37-46',
  '池袋': '📍池袋Kakululu\n〒170-0013 東京都豊島区東池袋4-29-6 三角ビル\n東池袋駅 徒歩2分\n※カクルルの店員さんに「整体に来た」とお伝えください。',
  '豊川市': '📍Analog/Tool\n愛知県豊川市新桜町通1丁目3-2\n駐車場あります\n※店員さんに「整体に来た」とお伝えください。',
  '岡山市': '📍岡山県岡山市北区表町3-4-36\n普通の住宅です。車庫の奥に玄関があります。ピンポンを押してください。\n※分からない場合は090-4403-7622へお電話ください。',
  '神戸市': '📍atelier licht\n兵庫県神戸市中央区中山手通7丁目2-1',
  '福岡市': '📍空洞\n〒810-0044 福岡県福岡市中央区六本松1丁目3-10\nわかりにくい建物です。入口は開いています。\n※分からない場合は090-4403-7622へお電話ください。',
  '広島': '📍ヲルガン座3階\n広島県広島市中区十日市町1-4-32 天国ビル\n3階まで階段です。ベンチで待っていてください。',
  '今治市': '📍今治市・森\n愛媛県今治市米屋町4-2-1\n※店員さんに「整体に来た」とお伝えください。',
  '山梨県・大月市': '📍えんがわ / engawa（古民家民泊）\n山梨県大月市梁川町綱の上21-1\nJR中央線 梁川駅 徒歩13分／駐車場あります',
};
const GRAN = 30;
const MENUS = [
  { key: 'care90', name: 'しっかり調整90分', dur: 90 },
  { key: 'fix60', name: '劇的改善60分', dur: 60 },
];
// 場所ごとに選べるコースの制限。未指定の場所は全コース可。
const LOCATION_MENUS: Record<string, string[]> = {
  '下北沢': ['care90'], // 下北沢は90分コースのみ
};
const menusFor = (loc: string) => { const keys = LOCATION_MENUS[loc]; return keys ? MENUS.filter((m) => keys.includes(m.key)) : MENUS; };
const CALENDAR_ID = 'adcr3o@gmail.com';
const REI_TOKEN = 'rei-e31713050f99e0ddec85';

const bookingGcal = new Hono();

// ---- サービスアカウント認証（WebCrypto RS256）----
const b64url = (s: string) => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlBytes = (bytes: Uint8Array) => { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); };
function pemToDer(pem: string): ArrayBuffer { const b = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''); const bin = atob(b); const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i); return buf.buffer; }
async function getToken(sa: any): Promise<string | null> {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const data = `${header}.${claim}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  const jwt = `${data}.${b64urlBytes(new Uint8Array(sig))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const j: any = await res.json();
  return j.access_token ?? null;
}

// ---- 空き計算 ----
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fromMin = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
const overlaps = (a: number, b: number, c: number, d: number) => a < d && b > c;
const toJst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600000);
const jstHM = (iso: string) => { const j = toJst(iso); return `${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`; };
const jstDate = (iso: string) => toJst(iso).toISOString().slice(0, 10);

async function fetchEvents(sa: any, from: string, to: string) {
  const token = await getToken(sa);
  if (!token) throw new Error('token failed');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?timeMin=${from}&timeMax=${to}&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message || 'calendar error');
  return (data.items || []).filter((e: any) => e.start?.dateTime).map((e: any) => ({ title: (e.summary || '').trim(), date: jstDate(e.start.dateTime), start: jstHM(e.start.dateTime), end: jstHM(e.end.dateTime), note: e.description || '' }));
}

async function getBusy(db: any, location: string, date: string, excludeId?: string): Promise<{ s: number; e: number }[]> {
  try {
    const sql = `SELECT start_hm, dur FROM pokanto_booking_requests WHERE location=? AND date=? AND status='confirmed'` + (excludeId ? ` AND id!=?` : ``);
    const rows: any = await db.prepare(sql).bind(...(excludeId ? [location, date, excludeId] : [location, date])).all();
    return (rows.results || []).map((r: any) => ({ s: toMin(r.start_hm), e: toMin(r.start_hm) + r.dur }));
  } catch { return []; }
}
function slotsWithStatus(start: string, end: string, dur: number, busy: { s: number; e: number }[]) {
  const wS = toMin(start), wE = toMin(end); const out: { start: string; busy: boolean }[] = [];
  for (let t = wS; t + dur <= wE; t += GRAN) out.push({ start: fromMin(t), busy: busy.some((b) => overlaps(t, t + dur, b.s, b.e)) });
  return out;
}

// ---- 空き＋講座 ----
bookingGcal.get('/api/liff/booking-gcal/availability', async (c) => {
  try {
    const saRaw = (c.env as any).GOOGLE_SA_KEY;
    if (!saRaw) return c.json({ error: 'GOOGLE_SA_KEY not set' }, 500);
    const sa = JSON.parse(saRaw);
    const nowMs = Date.now();
    const from = c.req.query('from') ?? new Date(nowMs - 24 * 3600000).toISOString();
    const to = c.req.query('to') ?? new Date(nowMs + 92 * 24 * 3600000).toISOString();
    const exclude = c.req.query('exclude') || undefined; // 予約変更時: 動かす予約自身を空き計算から除外
    const events = await fetchEvents(sa, from, to);
    const availability: Record<string, any[]> = {}; const workshops: any[] = [];
    for (const e of events) {
      if (ALL_LOCATION_NAMES.includes(e.title)) {
        const busy = await getBusy((c.env as any).DB, e.title, e.date, exclude);
        (availability[e.title] ||= []).push({ date: e.date, start: e.start, end: e.end, menus: menusFor(e.title).map((m) => ({ key: m.key, menu: m.name, dur: m.dur, slots: slotsWithStatus(e.start, e.end, m.dur, busy) })) });
      } else if (e.title && !e.title.startsWith('【予約】')) { const pm = wsPublicMeta(e.note); workshops.push({ title: e.title, date: e.date, start: e.start, end: e.end, place: pm.place, price: pm.price, online: pm.online, desc: pm.desc }); }
    }
    // 常設4拠点は常にタブ表示。臨時拠点はこの期間内に実際にカレンダー予定があった時だけタブに追加＝動的表示。
    const activeTempLocations = TEMP_LOCATIONS.filter((l) => availability[l] && availability[l].length);
    const shownLocations = [...LOCATIONS, ...activeTempLocations];
    const locationMenus = Object.fromEntries(shownLocations.map((l) => [l, menusFor(l).map((m) => ({ key: m.key, name: m.name }))]));
    return c.json({ ok: true, locations: shownLocations, locationMenus, availability, workshops, eventCount: events.length });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});

// ---- リクエスト保存 ----
bookingGcal.post('/api/liff/booking-gcal/request', async (c) => {
  try {
    const body: any = await c.req.json();
    const menu = MENUS.find((m) => m.key === body.menuKey);
    if (!body.location || !menu || !Array.isArray(body.hopes) || !body.hopes.length) return c.json({ error: 'invalid' }, 400);
    if (!menusFor(body.location).some((m) => m.key === menu.key)) return c.json({ error: 'menu not available at this location' }, 400);
    const id = crypto.randomUUID();
    const first = body.hopes[0];
    const isTest = body.test === true;
    await (c.env as any).DB.prepare(
      `INSERT INTO pokanto_booking_requests (id, created_at, who, phone, location, menu_key, menu_name, dur, date, start_hm, hopes, status, customer_user_id, display_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, new Date().toISOString(), body.who || 'お客さま', body.phone || '', body.location, menu.key, menu.name, menu.dur, first.date, first.start, JSON.stringify(body.hopes), isTest ? 'test' : 'pending', body.userId || '', body.displayName || '').run();
    const hopeLines = body.hopes.map((h: any, i: number) => `第${i + 1}希望 ${h.date} ${h.start}`).join('\n');
    if (!isTest) {
      await linePush(c.env, `🔔 新しい予約リクエスト\n\nお名前: ${body.who || 'お客さま'}\nLINE表示名: ${body.displayName || '—'}\n場所: ${body.location}\nメニュー: ${menu.name}\n電話: ${body.phone || '-'}\n\nご希望:\n${hopeLines}\n\n▼管理画面で確定できます\nhttps://pokanto.r-inafuku.workers.dev/api/liff/booking-gcal/rei?token=${REI_TOKEN}`);
    }
    return c.json({ ok: true, id, test: isTest });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});

// ---- れいさん用: リクエスト一覧（要APIキー）----
bookingGcal.get('/api/booking-gcal/requests', async (c) => {
  try {
    const rows: any = await (c.env as any).DB.prepare(`SELECT * FROM pokanto_booking_requests WHERE status!='test' ORDER BY created_at DESC LIMIT 50`).all();
    return c.json({ ok: true, requests: (rows.results || []).map((r: any) => ({ ...r, hopes: JSON.parse(r.hopes || '[]') })) });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});

// ---- カレンダー書き込み/削除 ----
async function createEvent(sa: any, summary: string, description: string, startISO: string, endISO: string): Promise<string | null> {
  const token = await getToken(sa); if (!token) return null;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, description, start: { dateTime: startISO, timeZone: 'Asia/Tokyo' }, end: { dateTime: endISO, timeZone: 'Asia/Tokyo' } }),
  });
  const d: any = await res.json(); return d.id ?? null;
}
async function deleteEvent(sa: any, eventId: string): Promise<boolean> {
  const token = await getToken(sa); if (!token) return false;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return res.status === 204 || res.ok;
}
const addMin = (hm: string, min: number) => fromMin(toMin(hm) + min);

// ---- 確定/キャンセル 共通ロジック ----
// 予約確定メッセージの本文（doConfirmと検証用rei-test-confirmで共有。場所に住所があれば自動で挿入）
function buildConfirmMessage(who: string, date: string, start: string, location: string): string {
  const addr = LOCATION_ADDRESSES[location];
  const addrText = addr ? `\n\n${addr}` : '';
  return `${who}さん\nありがとうございます。ご予約承りました！\n柔らかめの格好でお越しください。お待ちしています♪\n\n▼ご予約\n${date} ${start}〜／${location}${addrText}`;
}
async function doConfirm(env: any, id: string, hopeIndex: number): Promise<any> {
  const db = env.DB;
  const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(id).first();
  if (!row) return { error: 'not found', status: 404 };
  const hopes = JSON.parse(row.hopes || '[]');
  const hope = hopes[hopeIndex ?? 0];
  if (!hope) return { error: 'invalid hopeIndex', status: 400 };
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const startISO = `${hope.date}T${hope.start}:00+09:00`;
  const endISO = `${hope.date}T${addMin(hope.start, row.dur)}:00+09:00`;
  const summary = `【予約】${row.who} ${row.menu_name}（${row.location}）`;
  const eventId = await createEvent(sa, summary, `LINE予約 / ${row.who}`, startISO, endISO);
  await db.prepare(`UPDATE pokanto_booking_requests SET status='confirmed', date=?, start_hm=?, gcal_event_id=? WHERE id=?`).bind(hope.date, hope.start, eventId, id).run();
  // 予約確定 → お客さまへ「予約後メッセージ」を自動送信（LIFF経由でuserIdが取れている場合のみ）
  if (row.customer_user_id) {
    await pushToUser(env, row.customer_user_id, buildConfirmMessage(row.who, hope.date, hope.start, row.location));
  }
  return { ok: true, confirmed: { date: hope.date, start: hope.start }, gcalEventId: eventId };
}
async function doCancel(env: any, id: string): Promise<any> {
  const db = env.DB;
  const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(id).first();
  if (!row) return { error: 'not found', status: 404 };
  if (row.gcal_event_id) { const sa = JSON.parse(env.GOOGLE_SA_KEY); await deleteEvent(sa, row.gcal_event_id); }
  await db.prepare(`UPDATE pokanto_booking_requests SET status='cancelled' WHERE id=?`).bind(id).run();
  return { ok: true };
}

async function doReschedule(env: any, id: string, newDate: string, newStart: string): Promise<any> {
  const db = env.DB;
  const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(id).first();
  if (!row) return { error: 'not found', status: 404 };
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  if (row.gcal_event_id) await deleteEvent(sa, row.gcal_event_id);
  const startISO = `${newDate}T${newStart}:00+09:00`;
  const endISO = `${newDate}T${addMin(newStart, row.dur)}:00+09:00`;
  const summary = `【予約】${row.who} ${row.menu_name}（${row.location}）`;
  const eventId = await createEvent(sa, summary, `LINE予約 / ${row.who}`, startISO, endISO);
  await db.prepare(`UPDATE pokanto_booking_requests SET date=?, start_hm=?, gcal_event_id=? WHERE id=?`).bind(newDate, newStart, eventId, id).run();
  // お客さま本人へ日時変更をお知らせ（れい操作・お客さま操作どちらの変更でも通知）
  if (row.customer_user_id) {
    const addr = LOCATION_ADDRESSES[row.location];
    const addrText = addr ? `\n\n${addr}\n` : '';
    await pushToUser(env, row.customer_user_id, `${row.who}さん\nご予約の日時が変更になりました。\n新しいご予約：${fmtMD(newDate)} ${newStart}〜／${row.location}${addrText}\nお間違いのないようお願いします🌱`);
  }
  return { ok: true, rescheduled: { date: newDate, start: newStart }, gcalEventId: eventId };
}

// ---- 確定/キャンセル（管理: 要APIキー）----
bookingGcal.post('/api/booking-gcal/confirm', async (c) => {
  try { const b: any = await c.req.json(); const r: any = await doConfirm(c.env as any, b.id, b.hopeIndex ?? 0); return c.json(r, r.status || 200); }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.post('/api/booking-gcal/cancel', async (c) => {
  try { const b: any = await c.req.json(); const r: any = await doCancel(c.env as any, b.id); return c.json(r, r.status || 200); }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});

// ---- れいさん用（URLトークンで開ける）----
const reiOk = (t: string | undefined) => t === REI_TOKEN;
bookingGcal.get('/api/liff/booking-gcal/rei-requests', async (c) => {
  if (!reiOk(c.req.query('token'))) return c.json({ error: 'forbidden' }, 403);
  const rows: any = await (c.env as any).DB.prepare(`SELECT * FROM pokanto_booking_requests WHERE status IN ('pending','confirmed') ORDER BY created_at DESC LIMIT 100`).all();
  return c.json({ ok: true, requests: (rows.results || []).map((r: any) => ({ id: r.id, who: r.who, phone: r.phone || '', location: r.location, menu_name: r.menu_name, menu_key: r.menu_key, dur: r.dur, status: r.status, date: r.date, start_hm: r.start_hm, hopes: JSON.parse(r.hopes || '[]'), display_name: r.display_name || '' })) });
});
bookingGcal.post('/api/liff/booking-gcal/rei-confirm', async (c) => {
  try { const b: any = await c.req.json(); if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403); const r: any = await doConfirm(c.env as any, b.id, b.hopeIndex ?? 0); return c.json(r, r.status || 200); }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.post('/api/liff/booking-gcal/rei-cancel', async (c) => {
  try {
    const b: any = await c.req.json(); if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403);
    const env = c.env as any;
    const row: any = await env.DB.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(b.id).first();
    const r: any = await doCancel(env, b.id);
    if (r.ok && row && row.customer_user_id) {
      await pushToUser(env, row.customer_user_id, `${row.who}さん\nご予約をキャンセルいたしました。\n（${fmtMD(row.date)} ${row.start_hm}〜／${row.location}）\nまたのご予約をお待ちしています^ ^`);
    }
    return c.json(r, r.status || 200);
  }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.post('/api/liff/booking-gcal/rei-reschedule', async (c) => {
  try { const b: any = await c.req.json(); if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403); const r: any = await doReschedule(c.env as any, b.id, b.newDate, b.newStart); return c.json(r, r.status || 200); }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
// ---- 検証用（Ryo単独テスト・token必須。status='test'は空き計算/admin一覧/日次まとめから自動除外され本番に影響しない）----
bookingGcal.get('/api/liff/booking-gcal/rei-test-requests', async (c) => {
  if (!reiOk(c.req.query('token'))) return c.json({ error: 'forbidden' }, 403);
  const rows: any = await (c.env as any).DB.prepare(`SELECT id, created_at, who, location, menu_name, display_name, customer_user_id FROM pokanto_booking_requests WHERE status='test' ORDER BY created_at DESC LIMIT 20`).all();
  const requests = (rows.results || []).map((r: any) => ({ id: r.id, created_at: r.created_at, who: r.who, location: r.location, menu_name: r.menu_name, display_name: r.display_name, hasLineUser: !!r.customer_user_id }));
  return c.json({ ok: true, requests });
});
bookingGcal.post('/api/liff/booking-gcal/rei-test-clear', async (c) => {
  try {
    const b: any = await c.req.json();
    if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403);
    const r: any = await (c.env as any).DB.prepare(`DELETE FROM pokanto_booking_requests WHERE status='test'`).run();
    return c.json({ ok: true, deleted: r.meta?.changes ?? 0 });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
// 検証用: テスト予約(status='test')を実際には確定させず、確定通知（住所入り）だけをRyo自身のLINEに送る。
// カレンダー書き込み・status変更・れいさんへの通知は一切行わない（status='test'のまま＝本番の一覧/空き計算/日次バッチから常に除外）。
bookingGcal.post('/api/liff/booking-gcal/rei-test-confirm', async (c) => {
  try {
    const b: any = await c.req.json();
    if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403);
    const db = (c.env as any).DB;
    const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(b.id).first();
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'test') return c.json({ error: 'test予約のみ確認できます' }, 400); // 安全弁: 本番予約は誤ってもここでは確定できない
    const hopes = JSON.parse(row.hopes || '[]');
    const hope = hopes[b.hopeIndex ?? 0];
    if (!hope) return c.json({ error: 'invalid hopeIndex' }, 400);
    if (!row.customer_user_id) return c.json({ error: 'no-line-user', message: 'このテスト予約にはLINEユーザー情報がありません。LINEアプリ内でログインした状態でテスト予約を送り直してください。' }, 400);
    await pushToUser(c.env as any, row.customer_user_id, buildConfirmMessage(row.who, hope.date, hope.start, row.location));
    return c.json({ ok: true, sent: true });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.get('/api/liff/booking-gcal/rei-test', (c) => c.html(REI_TEST_PAGE_HTML));
// ---- 既存予約の一括取り込み（管理・要トークン）: カレンダー【予約】書込＋D1 confirmedでブロック ----
bookingGcal.post('/api/liff/booking-gcal/import-existing', async (c) => {
  try {
    const b: any = await c.req.json();
    if (b.token !== REI_TOKEN) return c.json({ error: 'forbidden' }, 403);
    const env = c.env as any;
    const sa = JSON.parse(env.GOOGLE_SA_KEY);
    const db = env.DB;
    const out: any[] = [];
    for (const it of b.items || []) {
      const dur = toMin(it.end) - toMin(it.start);
      const menu = dur === 90 ? { key: 'care90', name: 'しっかり調整90分' } : dur === 60 ? { key: 'fix60', name: '劇的改善60分' } : { key: 'other', name: `施術${dur}分` };
      const id = crypto.randomUUID();
      const startISO = `${it.date}T${it.start}:00+09:00`;
      const endISO = `${it.date}T${it.end}:00+09:00`;
      const summary = `【予約】${it.who}（${it.location}）`;
      const eventId = await createEvent(sa, summary, '既存予約（一括登録）', startISO, endISO);
      await db.prepare(`INSERT INTO pokanto_booking_requests (id, created_at, who, phone, location, menu_key, menu_name, dur, date, start_hm, hopes, status, gcal_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?)`)
        .bind(id, new Date().toISOString(), it.who, '', it.location, menu.key, menu.name, dur, it.date, it.start, JSON.stringify([{ date: it.date, start: it.start }]), eventId).run();
      out.push({ who: it.who, date: it.date, start: it.start, end: it.end, dur, location: it.location, eventId });
    }
    return c.json({ ok: true, count: out.length, items: out });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
// ---- 日次バッチ: 前日リマインド＋施術後メッセージ（外部cronから叩く・要トークン）----
bookingGcal.post('/api/liff/booking-gcal/run-daily', async (c) => {
  try {
    const b: any = await c.req.json();
    if (b.token !== REI_TOKEN) return c.json({ error: 'forbidden' }, 403);
    const env = c.env as any; const db = env.DB;
    const tomorrow = jstDateOffset(1);
    const yesterday = jstDateOffset(-1);
    let reminder = 0, thanks = 0;
    // 前日リマインド（明日の確定予約・LIFFでuserIdが取れている人のみ・未送信のみ）
    const rem: any = await db.prepare(`SELECT id, start_hm, location, customer_user_id FROM pokanto_booking_requests WHERE date=? AND status='confirmed' AND customer_user_id IS NOT NULL AND customer_user_id!='' AND COALESCE(reminder_sent,0)=0`).bind(tomorrow).all();
    for (const r of rem.results || []) {
      const addr = LOCATION_ADDRESSES[r.location];
      const addrText = addr ? `\n\n${addr}\n` : '';
      await pushToUser(env, r.customer_user_id, `こんにちは♪ 明日のご予約のリマインドです^ ^\n明日 ${r.start_hm}〜、${r.location}でお待ちしています。${addrText}\nご都合の変更等あれば、このトークからお知らせください。\nお気をつけてお越しください♪`);
      await db.prepare(`UPDATE pokanto_booking_requests SET reminder_sent=1 WHERE id=?`).bind(r.id).run();
      reminder++;
    }
    // 施術後メッセージ（昨日の確定予約・未送信のみ）
    const th: any = await db.prepare(`SELECT id, customer_user_id FROM pokanto_booking_requests WHERE date=? AND status='confirmed' AND customer_user_id IS NOT NULL AND customer_user_id!='' AND COALESCE(thanks_sent,0)=0`).bind(yesterday).all();
    for (const r of th.results || []) {
      await pushToUser(env, r.customer_user_id, `昨日はありがとうございました♪ 施術直後の楽な感じをたくさん思い出していただいて、どんどん楽に変化してゆくのを楽しんで観察していってください。またのご予約お待ちしています^ ^`);
      await db.prepare(`UPDATE pokanto_booking_requests SET thanks_sent=1 WHERE id=?`).bind(r.id).run();
      thanks++;
    }
    return c.json({ ok: true, reminder, thanks });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.get('/api/liff/booking-gcal/rei', (c) => c.html(REI_PAGE_HTML));

// ---- れいさん向け 手順書一覧（許可リスト）----
// ここに無い slug は404。R2は既存 IMAGES バケット(pokanto-images)の manuals/ プレフィックスを流用。
// 更新は正本(~/agents/ceo/output/のHTML)を直してから ~/agents/tools/pokanto-line/sync-docs.sh を実行するだけ（再デプロイ不要）。
const REI_DOCS: { slug: string; label: string }[] = [
  { slug: 'manual-overview', label: '運用マニュアル（総合）' },
  { slug: 'liff-setup', label: 'LINEログイン設定の手順' },
  { slug: 'notify-on', label: '予約通知をオンにする手順' },
  { slug: 'booking-test', label: '予約テストの手順' },
  { slug: 'message-examples', label: 'お客さま返信の例文集' },
];
// ---- れいさん向け 手順書配信（token必須・許可リスト外/未アップロードは404・本文はtoken一致時のみ返す）----
bookingGcal.get('/api/liff/booking-gcal/manual/:slug', async (c) => {
  if (!reiOk(c.req.query('token'))) return c.text('forbidden', 403);
  const slug = c.req.param('slug');
  if (!REI_DOCS.some((d) => d.slug === slug)) return c.text('not found', 404);
  const obj = await (c.env as any).IMAGES.get(`manuals/${slug}.html`);
  if (!obj) return c.text('not found', 404);
  return new Response(obj.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
});

// ======== LINE通知（予約が入ったられいさんの個人LINEへpush）========
// 受け取り先userIdは pokanto_notify_targets テーブルで管理。
// 登録方法: れいさんがぽかんとLINEに「予約通知オン」と送る → 下のwebhookでuserIdを保存。
// マニュアル(output/ぽかんとLINE_れいさん用_予約通知オン手順)の案内語と完全一致させること。
async function getNotifyTargets(db: any): Promise<string[]> {
  try { const r: any = await db.prepare(`SELECT user_id FROM pokanto_notify_targets`).all(); return (r.results || []).map((x: any) => x.user_id); }
  catch { return []; }
}
async function linePush(env: any, text: string): Promise<void> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN; if (!token) return;
  const targets = await getNotifyTargets(env.DB); if (!targets.length) return;
  for (const to of targets) {
    try {
      await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to, messages: [{ type: 'text', text }] }) });
    } catch { /* 通知失敗は本処理を止めない */ }
  }
}
async function pushToUser(env: any, userId: string, text: string): Promise<void> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN; if (!token || !userId) return;
  try { await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }) }); } catch { /* noop */ }
}
async function lineReply(env: any, replyToken: string, text: string): Promise<void> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN; if (!token || !replyToken) return;
  try { await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }) }); } catch { /* noop */ }
}
// JST基準で days 日後の YYYY-MM-DD
const jstDateOffset = (days: number) => new Date(Date.now() + 9 * 3600000 + days * 864e5).toISOString().slice(0, 10);
// 指定日の確定予約をLINE返信用テキストに整形
async function bookingsSummary(db: any, date: string, reiUrl: string): Promise<string> {
  const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(date + 'T12:00:00Z').getUTCDay()];
  const parts = date.split('-').map(Number);
  const label = `${parts[1]}/${parts[2]}(${wd})`;
  let list: any[] = [];
  try { const r: any = await db.prepare(`SELECT start_hm, dur, location, who, display_name FROM pokanto_booking_requests WHERE date=? AND status='confirmed' ORDER BY start_hm`).bind(date).all(); list = r.results || []; } catch { /* noop */ }
  if (!list.length) return `📅 ${label} のご予約はありません。\n\n▼管理画面\n${reiUrl}`;
  const lines = list.map((r: any) => `${r.start_hm}　${r.location}　${r.who}（${r.dur}分）／LINE: ${r.display_name || '—'}`).join('\n');
  return `📅 ${label} のご予約（${list.length}件）\n\n${lines}\n\n▼確定・変更はこちら\n${reiUrl}`;
}
// 日付 YYYY-MM-DD → M/D(曜)
function fmtMD(date: string): string {
  const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(date + 'T12:00:00Z').getUTCDay()];
  const p = date.split('-').map(Number);
  return `${p[1]}/${p[2]}(${wd})`;
}
// あるお客さま(userId)の今日以降の確定予約
async function customerBookings(db: any, uid: string): Promise<any[]> {
  const today = jstDateOffset(0);
  try { const r: any = await db.prepare(`SELECT id, date, start_hm, location, dur, who FROM pokanto_booking_requests WHERE customer_user_id=? AND status='confirmed' AND date>=? ORDER BY date, start_hm`).bind(uid, today).all(); return r.results || []; } catch { return []; }
}
// メッセージ配列をそのままreply（テンプレート等に使う）
async function lineReplyRaw(env: any, replyToken: string, messages: any[]): Promise<void> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN; if (!token || !replyToken) return;
  try { await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ replyToken, messages }) }); } catch { /* noop */ }
}
// ---- マイ予約ページ用: LIFF accessTokenの検証 ----
// Authorizationヘッダから "Bearer xxx" のトークン部分だけを取り出す
const bearerFrom = (c: any): string | null => {
  const h = c.req.header('authorization') || c.req.header('Authorization');
  const m = (h || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
};
// LINEのaccessTokenを検証し、確定した本人のuserIdを返す（不正・失効時はnull）。
// クエリ/bodyのuidは信用しない前提のため、uidは必ずこの関数の戻り値のみを使うこと。
async function verifyLiffUid(accessToken: string | null, env: any): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const vRes = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
    const v: any = await vRes.json();
    if (!vRes.ok || !v || !(Number(v.expires_in) > 0)) return null;
    const expectedClientId = env?.LINE_LOGIN_CHANNEL_ID;
    if (expectedClientId && v.client_id && String(v.client_id) !== String(expectedClientId)) return null;
    const pRes = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!pRes.ok) return null;
    const p: any = await pRes.json();
    return p?.userId || null;
  } catch { return null; }
}

// お客さまからのメッセージ（予約確認・キャンセル・変更）
// 暫定トリガー: 将来リッチメニューのボタン(postback)化でこのテキスト判定は廃止予定
async function handleCustomerCommand(env: any, ev: any, uid: string, text: string): Promise<void> {
  const db = env.DB;
  const norm = text.replace(/[\s　]+/g, ''); // 空白混入対策の軽い正規化（完全一致判定にのみ使用）
  if (norm === '予約キャンセル') {
    const bs = await customerBookings(db, uid);
    if (!bs.length) { await lineReply(env, ev.replyToken, 'キャンセルできるご予約が見つかりませんでした。'); return; }
    if (bs.length === 1) {
      const b = bs[0];
      await lineReplyRaw(env, ev.replyToken, [{ type: 'template', altText: 'ご予約のキャンセル確認', template: { type: 'confirm', text: `${fmtMD(b.date)} ${b.start_hm}〜／${b.location} のご予約をキャンセルしますか？`, actions: [{ type: 'postback', label: 'キャンセルする', data: `cancel:${b.id}`, displayText: 'キャンセルします' }, { type: 'message', label: 'やめる', text: 'キャンセルしません' }] } }]);
      return;
    }
    const lines = bs.map((b: any) => `・${fmtMD(b.date)} ${b.start_hm}〜 ${b.location}`).join('\n');
    await lineReply(env, ev.replyToken, `現在、複数のご予約があります。\n${lines}\n\nキャンセルをご希望の日時を、このトークにお知らせください。担当が対応いたします。`);
    await linePush(env, `🔔 キャンセルのご希望\n${bs[0].who}さん（複数予約あり）\nお客さまからキャンセルの連絡がありました。トークをご確認ください。`);
    return;
  }
  if (norm === '予約変更') {
    const bs = await customerBookings(db, uid);
    if (!bs.length) { await lineReply(env, ev.replyToken, '変更できるご予約が見つかりませんでした。'); return; }
    await lineReply(env, ev.replyToken, `ご予約の変更をご希望ですね。\nお手数ですが、一度「予約キャンセル」と送ってキャンセルしたあと、メニューの「ご予約」から取り直してください。\n\nうまくいかないときは、ご希望の日時をこのトークにお送りください（担当が確認します）。`);
    await linePush(env, `🔔 変更のご希望\n${bs[0].who}さん\nお客さまから予約変更の連絡がありました。トークをご確認ください。`);
    return;
  }
  if (norm === '予約確認') {
    const bs = await customerBookings(db, uid);
    if (!bs.length) { await lineReply(env, ev.replyToken, '現在、お客さまのご予約は見つかりませんでした。\nご予約はメニューの「ご予約」からどうぞ。'); return; }
    const lines = bs.map((b: any) => `${fmtMD(b.date)} ${b.start_hm}〜　${b.location}`).join('\n');
    await lineReply(env, ev.replyToken, `ご予約の確認です。\n\n${lines}\n\n変更・キャンセルをご希望のときは「予約キャンセル」または「予約変更」と送ってください。`);
    return;
  }
  // それ以外は無反応（通常のメッセージはれいさんが手動で対応）
}
// お客さまのキャンセル確定ボタン
async function handleCustomerPostback(env: any, ev: any, uid: string): Promise<void> {
  const data = ev.postback?.data || '';
  if (!data.startsWith('cancel:')) return;
  const rid = data.slice(7);
  const db = env.DB;
  const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(rid).first();
  if (!row || row.customer_user_id !== uid || row.status !== 'confirmed') { await lineReply(env, ev.replyToken, 'このご予約はすでにキャンセル済み、または見つかりませんでした。'); return; }
  await doCancel(env, rid);
  await lineReply(env, ev.replyToken, `${fmtMD(row.date)} ${row.start_hm}〜／${row.location} のご予約をキャンセルしました。\nまたのご予約をお待ちしています^ ^`);
  await linePush(env, `🔔 予約キャンセル\n${row.who}さん\n${fmtMD(row.date)} ${row.start_hm}〜 ${row.location}\nお客さまがLINEからキャンセルされました。`);
}
async function verifyLineSignature(secret: string, body: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return signature === expected;
}
// ぽかんと予約通知 専用Webhook（harnessの/webhookは使わない）
bookingGcal.post('/api/liff/booking-gcal/webhook', async (c) => {
  const env = c.env as any;
  const raw = await c.req.text();
  const secret = env.LINE_CHANNEL_SECRET;
  // 署名必須（secretが無い環境では受け付けない）
  if (!secret || !(await verifyLineSignature(secret, raw, c.req.header('x-line-signature')))) return c.text('forbidden', 403);
  let body: any = {}; try { body = JSON.parse(raw || '{}'); } catch { return c.text('bad', 400); }
  const reiUrl = `https://pokanto.r-inafuku.workers.dev/api/liff/booking-gcal/rei?token=${REI_TOKEN}`;
  for (const ev of body.events || []) {
    const uid = ev.source?.userId; if (!uid) continue;
    // お客さまのキャンセル確定ボタン
    if (ev.type === 'postback') { await handleCustomerPostback(env, ev, uid); continue; }
    if (!(ev.type === 'message' && ev.message?.type === 'text')) continue;
    const text = (ev.message.text || '').trim();
    const norm = text.replace(/[\s　]+/g, ''); // 空白混入対策の軽い正規化（完全一致判定にのみ使用）
    // 通知先の登録（誰でも・専用フレーズの完全一致のみ。マニュアル記載語と一致させること）
    if (norm === '予約通知オン') {
      try { await env.DB.prepare(`INSERT OR IGNORE INTO pokanto_notify_targets (user_id, added_at) VALUES (?,?)`).bind(uid, new Date().toISOString()).run(); } catch { /* noop */ }
      await lineReply(env, ev.replyToken, '✅ 予約通知の受け取り先に登録しました。\nこれから予約・講座のお申し込みが入ると、このトークにお知らせします。\n\n「管理」「今日」「明日」と送ると、予約の確認ができます。');
      continue;
    }
    const targets = await getNotifyTargets(env.DB);
    if (targets.includes(uid)) {
      // れいさん（管理コマンド）
      if (/今日|きょう|本日|ほんじつ/.test(text)) {
        await lineReply(env, ev.replyToken, await bookingsSummary(env.DB, jstDateOffset(0), reiUrl));
      } else if (/明日|あした|あす|みょうにち/.test(text)) {
        await lineReply(env, ev.replyToken, await bookingsSummary(env.DB, jstDateOffset(1), reiUrl));
      } else if (/管理|一覧|かんり/.test(text)) {
        await lineReply(env, ev.replyToken, `▼予約の管理・確定はこちら\n${reiUrl}\n\n「今日」「明日」と送ると、その日の予約一覧が見られます。`);
      }
    } else {
      // お客さま（予約確認・キャンセル・変更）
      await handleCustomerCommand(env, ev, uid, text);
    }
  }
  return c.text('OK', 200);
});

// ======== ワークショップ・講座 申込 ========
// れいさんはカレンダー予定の説明欄に下記の型で書く（自由文もOK・残りはdescへ）:
//   場所：下北沢スタジオ / 料金：3,000円 / 定員：8名
//   オンライン：Zoom / URL：https://...   ← URLは公開せず確定後の確認ページでのみ表示
const toHalfDigits = (s: string) => (s || '').replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)));
interface WsMeta { place: string; price: string; online: string; url: string; capacity: number | null; desc: string; }
function parseWorkshopMeta(note: string): WsMeta {
  let place = '', price = '', online = '', url = '', capacity: number | null = null;
  const rest: string[] = [];
  (note || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.trim(); if (!line) return; let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:場所|会場)\s*[:：]\s*(.+)$/))) { place = m[1].trim(); return; }
    if ((m = line.match(/^(?:料金|参加費|参加料|受講料|費用|価格)\s*[:：]\s*(.+)$/))) { price = m[1].trim(); return; }
    if ((m = line.match(/^定員\s*[:：]?\s*([0-9０-９]+)/))) { const n = parseInt(toHalfDigits(m[1])); if (!isNaN(n)) capacity = n; return; }
    if ((m = line.match(/^(?:URL|ＵＲＬ|リンク|Zoom|ズーム|参加リンク)\s*[:：]\s*(.+)$/i))) { url = m[1].trim(); return; }
    if ((m = line.match(/^オンライン\s*[:：]?\s*(.*)$/))) { online = m[1].trim() || 'オンライン'; return; }
    if (/^https?:\/\/\S+$/i.test(line)) { url = line; return; }
    rest.push(line);
  });
  return { place, price, online, url, capacity, desc: rest.join('\n') };
}
const isOnlineMeta = (m: WsMeta) => !!(m.online || m.url);
// 公開してよい構造化フィールド（URLは含めない）
function wsPublicMeta(note: string) { const m = parseWorkshopMeta(note); return { place: m.place, price: m.price, online: isOnlineMeta(m), desc: m.desc, capacity: m.capacity }; }
async function getEventById(sa: any, eventId: string) {
  const token = await getToken(sa); if (!token) return null;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`, { headers: { Authorization: `Bearer ${token}` } });
  const d: any = await res.json(); if (!d || d.error || !d.start?.dateTime) return null;
  return { title: (d.summary || '').trim(), note: d.description || '', date: jstDate(d.start.dateTime), start: jstHM(d.start.dateTime), end: jstHM(d.end.dateTime) };
}
async function fetchWorkshops(sa: any, from: string, to: string) {
  const token = await getToken(sa); if (!token) throw new Error('token failed');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?timeMin=${from}&timeMax=${to}&singleEvents=true&orderBy=startTime`;
  const data: any = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (data.error) throw new Error(data.error.message || 'calendar error');
  return (data.items || []).filter((e: any) => e.start?.dateTime && (e.summary || '').trim() && !ALL_LOCATION_NAMES.includes((e.summary || '').trim()) && !(e.summary || '').startsWith('【予約】'))
    .map((e: any) => ({ eventId: e.id, title: (e.summary || '').trim(), date: jstDate(e.start.dateTime), start: jstHM(e.start.dateTime), end: jstHM(e.end.dateTime), note: e.description || '' }));
}
bookingGcal.get('/api/liff/booking-gcal/workshops-data', async (c) => {
  try {
    const sa = JSON.parse((c.env as any).GOOGLE_SA_KEY);
    const now = Date.now();
    const ws = await fetchWorkshops(sa, new Date(now - 864e5).toISOString(), new Date(now + 92 * 864e5).toISOString());
    const db = (c.env as any).DB;
    const out: any[] = [];
    for (const w of ws) {
      const pm = wsPublicMeta(w.note);
      const cnt: any = await db.prepare(`SELECT COALESCE(SUM(count),0) AS taken FROM pokanto_workshop_apps WHERE workshop_event_id=? AND status IN ('applied','confirmed')`).bind(w.eventId).first();
      const taken = Number(cnt?.taken || 0);
      out.push({ eventId: w.eventId, title: w.title, date: w.date, start: w.start, end: w.end, place: pm.place, price: pm.price, online: pm.online, desc: pm.desc, capacity: pm.capacity, taken, remaining: pm.capacity != null ? Math.max(0, pm.capacity - taken) : null });
    }
    return c.json({ ok: true, workshops: out });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.post('/api/liff/booking-gcal/ws-apply', async (c) => {
  try {
    const b: any = await c.req.json();
    if (!b.eventId || !b.who) return c.json({ error: 'invalid' }, 400);
    const count = Math.max(1, parseInt(b.count) || 1);
    const id = crypto.randomUUID();
    await (c.env as any).DB.prepare(`INSERT INTO pokanto_workshop_apps (id, created_at, workshop_event_id, workshop_title, date, who, phone, count, status) VALUES (?,?,?,?,?,?,?,?, 'applied')`).bind(id, new Date().toISOString(), b.eventId, b.title || '', b.date || '', b.who, b.phone || '', count).run();
    await linePush(c.env, `🔔 講座のお申し込み\n\n講座: ${b.title || ''}\n日程: ${b.date || '-'}\nお名前: ${b.who}\n人数: ${count}名\n電話: ${b.phone || '-'}\n\n▼管理画面で確認できます\nhttps://pokanto.r-inafuku.workers.dev/api/liff/booking-gcal/rei?token=${REI_TOKEN}`);
    return c.json({ ok: true, id });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.get('/api/liff/booking-gcal/rei-ws', async (c) => {
  if (!reiOk(c.req.query('token'))) return c.json({ error: 'forbidden' }, 403);
  const rows: any = await (c.env as any).DB.prepare(`SELECT * FROM pokanto_workshop_apps WHERE status IN ('applied','confirmed') ORDER BY date, created_at`).all();
  return c.json({ ok: true, apps: rows.results || [] });
});
bookingGcal.post('/api/liff/booking-gcal/rei-ws-confirm', async (c) => {
  try { const b: any = await c.req.json(); if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403); await (c.env as any).DB.prepare(`UPDATE pokanto_workshop_apps SET status='confirmed' WHERE id=?`).bind(b.id).run(); return c.json({ ok: true }); }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.post('/api/liff/booking-gcal/rei-ws-cancel', async (c) => {
  try { const b: any = await c.req.json(); if (!reiOk(b.token)) return c.json({ error: 'forbidden' }, 403); await (c.env as any).DB.prepare(`UPDATE pokanto_workshop_apps SET status='cancelled' WHERE id=?`).bind(b.id).run(); return c.json({ ok: true }); }
  catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});

// ---- お客さん用: 申込確認ページ（自分のidが鍵）----
bookingGcal.get('/api/liff/booking-gcal/ws-status-data', async (c) => {
  try {
    const id = c.req.query('id'); if (!id) return c.json({ error: 'invalid' }, 400);
    const app: any = await (c.env as any).DB.prepare(`SELECT * FROM pokanto_workshop_apps WHERE id=?`).bind(id).first();
    if (!app) return c.json({ error: 'not found' }, 404);
    const sa = JSON.parse((c.env as any).GOOGLE_SA_KEY);
    const ev = await getEventById(sa, app.workshop_event_id);
    const meta = parseWorkshopMeta(ev ? ev.note : '');
    const online = isOnlineMeta(meta);
    const confirmed = app.status === 'confirmed';
    return c.json({
      ok: true, status: app.status, who: app.who, count: app.count,
      title: (ev && ev.title) || app.workshop_title, date: (ev && ev.date) || app.date, start: (ev && ev.start) || '', end: (ev && ev.end) || '',
      place: meta.place, price: meta.price, online, desc: meta.desc,
      url: confirmed && online ? meta.url || '' : '',
    });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.get('/api/liff/booking-gcal/ws-status', (c) => c.html(WS_STATUS_HTML));

// ---- ワークショップ・講座ページ ----
bookingGcal.get('/api/liff/booking-gcal/workshops', (c) => c.html(WS_PAGE_HTML));

// ---- マイ予約ページ（お客さん本人が自分の予約を確認・キャンセル）----
// 認証: Authorizationヘッダの LIFF accessToken を毎回検証し、そこから取れたuserIdのみを本人キーとして使う。
bookingGcal.get('/api/liff/booking-gcal/my-bookings', async (c) => {
  try {
    const uid = await verifyLiffUid(bearerFrom(c), c.env as any);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    const db = (c.env as any).DB;
    const today = jstDateOffset(0);
    const rows: any = await db.prepare(
      `SELECT id, date, start_hm, location, dur, who, menu_name, menu_key, status, hopes FROM pokanto_booking_requests WHERE customer_user_id=? AND status IN ('confirmed','pending') AND date>=? ORDER BY status, date, start_hm`
    ).bind(uid, today).all();
    const bookings = (rows.results || []).map((r: any) => ({ ...r, hopes: JSON.parse(r.hopes || '[]') }));
    return c.json({ ok: true, bookings });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.post('/api/liff/booking-gcal/my-cancel', async (c) => {
  try {
    const uid = await verifyLiffUid(bearerFrom(c), c.env as any);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    const b: any = await c.req.json();
    if (!b.id) return c.json({ error: 'invalid' }, 400);
    const env = c.env as any; const db = env.DB;
    const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(b.id).first();
    if (!row || row.customer_user_id !== uid || (row.status !== 'confirmed' && row.status !== 'pending')) return c.json({ error: 'forbidden' }, 403);
    const msg = row.status === 'pending'
      ? `🔔 予約リクエストの取り下げ\n${row.who}さん\n${fmtMD(row.date)} ${row.start_hm}〜 ${row.location}（ご希望）\nお客さまがLINE（マイ予約ページ）からリクエストを取り下げられました。`
      : `🔔 予約キャンセル\n${row.who}さん\n${fmtMD(row.date)} ${row.start_hm}〜 ${row.location}\nお客さまがLINE（マイ予約ページ）からキャンセルされました。`;
    await doCancel(env, b.id);
    await linePush(env, msg);
    const custMsg = row.status === 'pending'
      ? `${row.who}さん\n予約リクエストを取り下げました。\nまたいつでもご予約ください^ ^`
      : `${row.who}さん\nご予約をキャンセルしました。\n（${fmtMD(row.date)} ${row.start_hm}〜／${row.location}）\nまたのご予約お待ちしています^ ^`;
    await pushToUser(env, uid, custMsg);
    return c.json({ ok: true });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
// お客さま本人が確定予約の時間を変更（空き枠から選ぶ）。所有権チェック必須。
bookingGcal.post('/api/liff/booking-gcal/my-reschedule', async (c) => {
  try {
    const uid = await verifyLiffUid(bearerFrom(c), c.env as any);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    const b: any = await c.req.json();
    if (!b.id || !b.newDate || !b.newStart) return c.json({ error: 'invalid' }, 400);
    const env = c.env as any; const db = env.DB;
    const row: any = await db.prepare(`SELECT * FROM pokanto_booking_requests WHERE id=?`).bind(b.id).first();
    if (!row || row.customer_user_id !== uid || row.status !== 'confirmed') return c.json({ error: 'forbidden' }, 403);
    const oldLabel = `${fmtMD(row.date)} ${row.start_hm}〜`;
    const r: any = await doReschedule(env, b.id, b.newDate, b.newStart);
    if (r.error) return c.json(r, r.status || 500);
    await linePush(env, `🔔 予約の時間変更\n${row.who}さん\n${oldLabel} → ${fmtMD(b.newDate)} ${b.newStart}〜／${row.location}\nお客さまがLINE（マイ予約ページ）から時間を変更されました。`);
    return c.json({ ok: true });
  } catch (err: any) { return c.json({ error: String(err?.message || err) }, 500); }
});
bookingGcal.get('/api/liff/booking-gcal/mypage', (c) => c.html(MYPAGE_HTML));

// ---- お客さんの予約ページ ----
bookingGcal.get('/api/liff/booking-gcal/page', (c) => c.html(PAGE_HTML));

const PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="ぽかんと予約"><title>ぽかんと ご予約</title>'
+ '<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>'
+ '<style>'
+ ':root{--b:#5b82a6;--bd:#3f6488;--bg:#eef2f5;--ink:#33454f;--line:#dde6ec;--g:#06C755}'
+ '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.7}'
+ '.h{background:linear-gradient(135deg,#5b82a6,#83a8c6);color:#fff;padding:18px 16px}.h b{font-size:1.1rem}.h p{margin:4px 0 0;font-size:.82rem;opacity:.95}'
+ '.w{max-width:560px;margin:0 auto;padding:14px}'
+ '.lbl{font-size:.78rem;color:#7c8b96;margin:14px 0 6px}'
+ '.tabs{display:flex;flex-wrap:wrap;gap:6px}.tab{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 13px;font-size:.85rem;cursor:pointer}.tab.on{background:var(--b);color:#fff;border-color:var(--b)}'
+ '.day{border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin:10px 0;background:#fff}.day h4{margin:0 0 8px;font-size:.9rem;color:var(--bd)}'
+ '.slots{display:flex;flex-wrap:wrap;gap:6px}.slot{border:1px solid var(--line);border-radius:9px;padding:7px 4px;width:62px;text-align:center;font-size:.83rem;cursor:pointer;background:#fff;position:relative}'
+ '.slot.busy{background:#f1f2f3;color:#b7bcc1;text-decoration:line-through;cursor:not-allowed}.slot.sel{border-color:var(--b);background:#eaf6ee;color:var(--bd);font-weight:700}'
+ '.rk{position:absolute;top:-8px;right:-6px;background:var(--b);color:#fff;border-radius:50%;width:19px;height:19px;font-size:.68rem;display:flex;align-items:center;justify-content:center}'
+ '.send{margin-top:14px;width:100%;background:var(--g);color:#fff;border:none;border-radius:12px;padding:13px;font-size:.95rem;font-weight:700;cursor:pointer}.send:disabled{background:#c9ccd0}'
+ '.hint{font-size:.78rem;color:#7c8b96;margin-top:8px}.empty{color:#7c8b96;font-size:.86rem;padding:10px 0}'
+ '.inp{width:100%;border:1px solid #cfd8e0;border-radius:10px;padding:11px;font-size:.95rem;margin-top:8px}'
+ '.ws{border:1px solid var(--line);border-radius:12px;padding:10px 13px;margin:8px 0;background:#fff}.ws h4{margin:0 0 3px;font-size:.9rem;color:var(--bd)}.ws p{margin:0;font-size:.8rem;color:#667}'
+ '</style></head><body>'
+ '<div class="h"><b>療術院ぽかんと ご予約</b><p>ご希望の場所・メニューを選び、空き枠を最大3つまで（第1〜第3希望）選んで送信してください。</p></div>'
+ '<div class="w">'
+ '<div class="lbl">場所</div><div class="tabs" id="locTabs"></div>'
+ '<div class="lbl">メニュー</div><div class="tabs" id="menuTabs"></div>'
+ '<div id="days"></div>'
+ '<div class="lbl">お名前（フルネーム）と電話番号</div><input class="inp" id="nm" placeholder="お名前（フルネーム）"><input class="inp" id="tel" type="tel" inputmode="tel" placeholder="電話番号（例：090-1234-5678）">'
+ '<button class="send" id="send" onclick="submitReq()" disabled>希望を選んでください</button>'
+ '<div class="hint" id="hint">空いている枠をタップ（最大3つ）→ 第1・第2・第3希望として送れます。</div>'
+ '</div>'
+ '<script>'
+ 'var MENUS=[{key:"care90",name:"しっかり調整90分"},{key:"fix60",name:"劇的改善60分"}];'
+ 'var st={data:null,loc:null,menuKey:"fix60",hopes:[],userId:"",displayName:""};'
+ 'var TEST_MODE=(new URLSearchParams(location.search).get("test")==="1");if(TEST_MODE){var _b=document.createElement("div");_b.textContent="\u{1F527} テストモード：れいさんに通知は届きません";_b.style.cssText="background:#fff3cd;color:#7a5b00;padding:10px 14px;font-size:.85rem;text-align:center;font-weight:700";document.body.insertBefore(_b,document.body.firstChild);}'
+ 'function wd(d){return ["日","月","火","水","木","金","土"][new Date(d+"T00:00:00").getDay()];}'
+ 'function fmt(d){var p=d.split("-");return (+p[1])+"/"+(+p[2])+"("+wd(d)+")";}'
+ 'function load(){fetch("/api/liff/booking-gcal/availability").then(function(r){return r.json();}).then(function(j){st.data=j;var locs=Object.keys(j.availability||{});st.loc=locs.length?locs[0]:(j.locations[0]);fixMenu();render();});}'
+ 'function render(){renderLoc();renderMenu();renderDays();}'
+ 'function renderLoc(){var av=st.data.availability||{};var h="";st.data.locations.forEach(function(l){var has=av[l]&&av[l].length;h+="<div class=\\"tab "+(l===st.loc?"on":"")+"\\" onclick=\\"setLoc(\'"+l+"\')\\">"+l+(has?"":" (予定なし)")+"</div>";});document.getElementById("locTabs").innerHTML=h;}'
+ 'function menusForLoc(){var lm=(st.data&&st.data.locationMenus||{})[st.loc];return (lm&&lm.length)?lm:MENUS;}'
+ 'function fixMenu(){var ms=menusForLoc();if(!ms.some(function(m){return m.key===st.menuKey;}))st.menuKey=ms[0].key;}'
+ 'function renderMenu(){var h="";menusForLoc().forEach(function(m){h+="<div class=\\"tab "+(m.key===st.menuKey?"on":"")+"\\" onclick=\\"setMenu(\'"+m.key+"\')\\">"+m.name+"</div>";});document.getElementById("menuTabs").innerHTML=h;}'
+ 'function renderDays(){var av=(st.data.availability||{})[st.loc]||[];if(!av.length){document.getElementById("days").innerHTML="<div class=\\"empty\\">この場所の空きはまだありません。</div>";upd();return;}var h="";av.forEach(function(d){var mm=d.menus.filter(function(x){return x.key===st.menuKey;})[0];h+="<div class=\\"day\\"><h4>"+fmt(d.date)+"  "+d.start+"〜"+d.end+"</h4><div class=\\"slots\\">";mm.slots.forEach(function(s){var rk=hopeRank(d.date,s.start);var cls=s.busy?"slot busy":(rk>=0?"slot sel":"slot");var oc=s.busy?"":" onclick=\\"pick(\'"+d.date+"\',\'"+s.start+"\')\\"";h+="<div class=\\""+cls+"\\""+oc+">"+s.start+(rk>=0?"<span class=\\"rk\\">"+(rk+1)+"</span>":"")+"</div>";});h+="</div></div>";});document.getElementById("days").innerHTML=h;upd();}'
+ 'function renderWs(){var ws=st.data.workshops||[];var h="";if(!ws.length){h="<div class=\\"empty\\">現在ご案内中の講座はありません。</div>";}ws.forEach(function(w){var mt=(w.online?"🖥 オンライン":(w.place||""))+(w.price?"　"+w.price:"");h+="<div class=\\"ws\\"><h4>"+w.title+"</h4><p>"+fmt(w.date)+" "+w.start+"〜"+w.end+"　"+mt+"</p></div>";});document.getElementById("ws").innerHTML=h;}'
+ 'function hopeRank(d,s){for(var i=0;i<st.hopes.length;i++){if(st.hopes[i].date===d&&st.hopes[i].start===s)return i;}return -1;}'
+ 'function pick(d,s){var i=hopeRank(d,s);if(i>=0){st.hopes.splice(i,1);}else{if(st.hopes.length>=3){alert("希望は3つまでです");return;}st.hopes.push({date:d,start:s});}renderDays();}'
+ 'function setLoc(l){st.loc=l;fixMenu();st.hopes=[];render();}function setMenu(k){st.menuKey=k;st.hopes=[];render();}'
+ 'function upd(){var b=document.getElementById("send");b.disabled=st.hopes.length===0;b.textContent=st.hopes.length?("第1〜第"+st.hopes.length+"希望を送信"):"希望を選んでください";}'
+ 'function submitReq(){if(!st.hopes.length)return;var nm=document.getElementById("nm").value.trim();var tel=document.getElementById("tel").value.trim();if(!nm){alert("お名前（フルネーム）を入力してください");return;}if(!tel){alert("電話番号を入力してください");return;}var mn=(menusForLoc().filter(function(m){return m.key===st.menuKey;})[0]||{}).name;fetch("/api/liff/booking-gcal/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({who:nm,phone:tel,location:st.loc,menuKey:st.menuKey,hopes:st.hopes,userId:st.userId,displayName:st.displayName||"",test:TEST_MODE})}).then(function(r){return r.json();}).then(function(j){if(j.ok){document.getElementById("hint").textContent=TEST_MODE?"✅ テスト送信しました（れいさんには届きません）。管理者ページ「テスト予約の確認」で表示名を確認してください。":"✅ リクエストを送信しました（"+st.loc+"／"+mn+"）。担当より確定のご連絡をします。";st.hopes=[];document.getElementById("nm").value="";document.getElementById("tel").value="";renderDays();}else{document.getElementById("hint").textContent="送信に失敗しました。もう一度お試しください。";}});}'
+ 'var LIFF_ID="2010614528-iGDhVxUS";'
+ 'if(window.liff){liff.init({liffId:LIFF_ID}).then(function(){if(liff.isLoggedIn()){return liff.getProfile().then(function(p){st.userId=p.userId;st.displayName=p.displayName||"";});}}).catch(function(){}).then(function(){load();});}else{load();}'
+ '</script></body></html>';

const REI_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="ぽかんと予約管理"><title>ぽかんと 予約管理（れいさん用）</title>
<style>
:root{--bg:#EBF1F7;--sf:#FFFFFF;--sf2:#F1F6FA;--ac:#1F6EB0;--ac-f:#D5E9F7;--pos:#177249;--pos-f:#C8E8D8;--warn:#9C4608;--warn-f:#F5E0CC;--new:#6B35A0;--new-f:#EBE0F7;--tx:#102236;--tx2:#456278;--tx3:#87AABF;--bd:#BFD2E2;--r:8px;--bar-h:48px;--tab-h:44px}
@media(prefers-color-scheme:dark){:root{--bg:#0B1824;--sf:#172638;--sf2:#1E3248;--ac:#4A9AD8;--ac-f:#193352;--pos:#20956A;--pos-f:#112C20;--warn:#D07830;--warn-f:#2E1708;--new:#9C5AC8;--new-f:#23123A;--tx:#D4E8F4;--tx2:#7CA4BC;--tx3:#3E6080;--bd:#1E3650}}
:root[data-theme="dark"]{--bg:#0B1824;--sf:#172638;--sf2:#1E3248;--ac:#4A9AD8;--ac-f:#193352;--pos:#20956A;--pos-f:#112C20;--warn:#D07830;--warn-f:#2E1708;--new:#9C5AC8;--new-f:#23123A;--tx:#D4E8F4;--tx2:#7CA4BC;--tx3:#3E6080;--bd:#1E3650}
:root[data-theme="light"]{--bg:#EBF1F7;--sf:#FFFFFF;--sf2:#F1F6FA;--ac:#1F6EB0;--ac-f:#D5E9F7;--pos:#177249;--pos-f:#C8E8D8;--warn:#9C4608;--warn-f:#F5E0CC;--new:#6B35A0;--new-f:#EBE0F7;--tx:#102236;--tx2:#456278;--tx3:#87AABF;--bd:#BFD2E2}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);min-height:100vh;font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.app{max-width:480px;margin:0 auto;min-height:100vh;background:var(--sf)}
.app-bar{position:sticky;top:0;z-index:30;background:var(--ac);color:#fff;height:var(--bar-h);display:flex;align-items:center;justify-content:space-between;padding:0 16px;box-shadow:0 1px 6px rgba(0,0,0,.18)}
.app-bar-title{font-size:16px;font-weight:700;letter-spacing:-.01em}
.reload-btn{background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:999px;padding:5px 13px;font-size:.78rem;cursor:pointer;font-family:inherit}
.summary{background:var(--sf);border-bottom:1px solid var(--bd)}
.sum-grid{display:grid;grid-template-columns:1fr 1fr}
.sum-cell{padding:10px 12px;border-right:1px solid var(--bd);position:relative}
.sum-cell:last-child{border-right:none}
.sum-cell.has-new{background:var(--new-f)}
.sum-cat{font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--tx2);margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sum-stat{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--tx2);line-height:1.55}
.sum-stat strong{font-size:12px;font-weight:700;color:var(--tx)}
.sum-stat.is-new strong{color:var(--new)}
.sum-stat.is-warn strong{color:var(--warn)}
.sum-stat.is-conf strong{color:var(--pos)}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.d-n{background:var(--new)}.d-w{background:var(--warn)}.d-c{background:var(--pos)}
.sum-new-flag{position:absolute;top:8px;right:8px;background:var(--new);color:#fff;font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.03em}
.tab-bar{position:sticky;top:var(--bar-h);z-index:20;background:var(--sf);border-bottom:2px solid var(--bd);display:flex;box-shadow:0 1px 4px rgba(8,28,56,.06)}
.tab-btn{flex:1;height:var(--tab-h);background:none;border:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;color:var(--tx2);display:flex;align-items:center;justify-content:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-2px;transition:color .15s,border-color .15s;padding:0 8px;-webkit-tap-highlight-color:transparent}
.tab-btn[aria-selected="true"]{color:var(--ac);border-bottom-color:var(--ac)}
.badge{background:var(--warn);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;line-height:1.4}
.tab-panel{display:none}
.tab-panel.active{display:block}
.add-section{border-bottom:1px solid var(--bd);background:var(--sf2)}
.add-toggle{width:100%;background:none;border:none;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600;color:var(--ac);display:flex;align-items:center;gap:8px;padding:13px 16px;transition:background .1s;-webkit-tap-highlight-color:transparent}
.add-toggle:hover{background:var(--ac-f)}
.add-chev{font-size:12px;transition:transform .2s;margin-left:auto;color:var(--tx3)}
.add-toggle[aria-expanded="true"] .add-chev{transform:rotate(180deg)}
.add-form{display:none;padding:0 16px 16px}
.add-form.open{display:block}
.add-form label{display:block;font-size:12px;font-weight:700;color:var(--tx2);margin-bottom:3px;margin-top:12px}
.add-form input,.add-form select{display:block;width:100%;border:1px solid var(--bd);border-radius:6px;background:var(--sf);color:var(--tx);font-family:inherit;font-size:14px;padding:9px 12px;-webkit-appearance:none}
.add-form input:focus,.add-form select:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-f)}
.form-row{display:flex;gap:8px}
.form-group{display:flex;flex-direction:column;flex:1}
.btn-submit{display:block;width:100%;margin-top:14px;background:var(--ac);color:#fff;border:none;border-radius:6px;font-family:inherit;font-size:14px;font-weight:700;padding:11px;cursor:pointer}
.btn-submit:active{opacity:.88}
.sec-hd{padding:12px 16px 6px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);display:flex;align-items:center;justify-content:space-between}
.sec-cnt{background:var(--sf2);border:1px solid var(--bd);font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;color:var(--tx2);letter-spacing:.02em;text-transform:none}
.sec-hd.is-n .sec-cnt{background:var(--new-f);border-color:var(--new);color:var(--new)}
.sec-hd.is-w .sec-cnt{background:var(--warn-f);border-color:var(--warn);color:var(--warn)}
.card{margin:0 12px 8px;background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;box-shadow:0 1px 3px rgba(8,28,56,.07)}
.card.c-n{border-left:3px solid var(--new)}
.card.c-w{border-left:3px solid var(--warn)}
.card.c-c{border-left:3px solid var(--pos)}
.card-body{padding:12px 14px}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px}
.card-name{font-size:14px;font-weight:700;color:var(--tx)}
.card-st{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;flex-shrink:0}
.st-n{background:var(--new-f);color:var(--new)}
.st-w{background:var(--warn-f);color:var(--warn)}
.st-c{background:var(--pos-f);color:var(--pos)}
.card-meta{font-size:12px;color:var(--tx2);line-height:1.7}
.card-phone{font-size:12px;color:var(--tx2);margin-top:4px}
.card-actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.btn{flex:1;min-width:80px;height:36px;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;-webkit-tap-highlight-color:transparent;transition:opacity .1s}
.btn:active{opacity:.82}
.btn-confirm{background:var(--pos);color:#fff}
.btn-cancel{background:var(--warn-f);color:var(--warn);border:1px solid var(--warn)}
.btn-remove{background:var(--sf2);color:var(--tx2);border:1px solid var(--bd)}
.hopes-list{display:flex;flex-direction:column;gap:7px;margin-top:9px}
.btn-hope{text-align:left;border:1px solid var(--bd);background:var(--sf);color:var(--tx);border-radius:8px;padding:9px 12px;font-size:.88rem;cursor:pointer;font-family:inherit;width:100%}
.btn-hope:hover{background:var(--ac-f);border-color:var(--ac)}
.btn-hope b{color:var(--pos)}
.picker{margin-top:8px;padding:8px;background:var(--sf2);border-radius:9px}
.slotbtn{border:1px solid var(--bd);background:var(--sf);border-radius:8px;padding:6px 4px;width:58px;text-align:center;font-size:.82rem;cursor:pointer;margin:3px;color:var(--tx);font-family:inherit}
.slotbtn:hover{background:var(--ac-f);border-color:var(--ac)}
.conf-toggle{width:100%;background:none;border:none;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;color:var(--tx2);padding:10px 16px;display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:transparent}
.chev{font-size:12px;transition:transform .2s;display:inline-block}
.conf-toggle[aria-expanded="true"] .chev{transform:rotate(180deg)}
.conf-list{display:none}
.conf-list.open{display:block}
.manual-card{margin:0 12px 8px;background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.manual-link{display:block;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:10px 12px;font-size:.88rem;color:var(--ac);text-decoration:none}
.manual-link:hover{background:var(--ac-f)}
.empty{padding:24px 16px;text-align:center;color:var(--tx3);font-size:13px}
.bottom-space{height:40px}
</style></head><body>
<div class="app">
<header class="app-bar">
  <span class="app-bar-title">ぽかんと 予約管理</span>
  <button class="reload-btn" onclick="load()">更新</button>
</header>
<section class="summary">
  <div class="sum-grid">
    <div class="sum-cell" id="sum-s">
      <h2 class="sum-cat">施術予約</h2>
      <div class="sum-stat is-warn"><span class="dot d-w"></span>要確認 <strong id="s-warn">–</strong>件</div>
      <div class="sum-stat is-conf"><span class="dot d-c"></span>確定済み <strong id="s-conf">–</strong>件</div>
    </div>
    <div class="sum-cell" id="sum-w">
      <h2 class="sum-cat">講座・ワークショップ</h2>
      <div class="sum-stat is-new"><span class="dot d-n"></span>新着 <strong id="w-new">–</strong>件</div>
      <div class="sum-stat is-warn"><span class="dot d-w"></span>要確認 <strong id="w-warn">–</strong>件</div>
      <div class="sum-stat is-conf"><span class="dot d-c"></span>確定済み <strong id="w-conf">–</strong>件</div>
      <span class="sum-new-flag" id="w-flag" hidden>NEW</span>
    </div>
  </div>
</section>
<div class="tab-bar" role="tablist">
  <button class="tab-btn" role="tab" aria-selected="false" id="tab-s" data-tab="s">施術予約</button>
  <button class="tab-btn" role="tab" aria-selected="false" id="tab-w" data-tab="w">講座・ワークショップ</button>
</div>
<div class="tab-panel" id="panel-s" role="tabpanel">
  <div class="add-section">
    <button class="add-toggle" aria-expanded="false" id="add-btn" aria-controls="add-form">
      <span>＋&nbsp;手動で予約を追加</span>
      <span class="add-chev" aria-hidden="true">▾</span>
    </button>
    <div class="add-form" id="add-form">
      <div class="form-row">
        <div class="form-group"><label for="f-date">日付</label><input type="date" id="f-date" name="f_date"></div>
        <div class="form-group"><label for="f-time">時刻</label><input type="time" id="f-time" name="f_time"></div>
      </div>
      <div class="form-group"><label for="f-loc">場所</label><select id="f-loc" name="f_loc"><option value="">選択してください</option><option>下北沢</option><option>世田谷・松陰神社前</option><option>千歳船橋</option><option>池袋</option></select></div>
      <div class="form-group"><label for="f-menu">メニュー</label><select id="f-menu" name="f_menu"><option value="90">しっかり調整90分</option><option value="60">劇的改善60分</option></select></div>
      <div class="form-group"><label for="f-name">お名前</label><input type="text" id="f-name" name="f_name" placeholder="例：山田花子"></div>
      <button class="btn-submit" type="button" id="submit-manual">この枠を予約で埋める</button>
    </div>
  </div>
  <div class="sec-hd is-w">要確認 <span class="sec-cnt" id="cnt-sw">–</span></div>
  <div id="list-sw"><div class="empty">読み込み中…</div></div>
  <div class="sec-hd">確定済み <span class="sec-cnt" id="cnt-sc">–</span></div>
  <button class="conf-toggle" aria-expanded="false" id="ct-s"><span class="chev">▾</span><span id="ct-s-lbl">確定済みを表示</span></button>
  <div class="conf-list" id="list-sc"></div>
  <div class="sec-hd" style="margin-top:8px">📖 マニュアル</div>
  <div class="manual-card">
    <a class="manual-link" id="doc-manual-overview" target="_blank" rel="noopener">運用マニュアル（総合）</a>
    <a class="manual-link" id="doc-liff-setup" target="_blank" rel="noopener">LINEログイン設定の手順</a>
    <a class="manual-link" id="doc-notify-on" target="_blank" rel="noopener">予約通知をオンにする手順</a>
    <a class="manual-link" id="doc-booking-test" target="_blank" rel="noopener">予約テストの手順</a>
    <a class="manual-link" id="doc-message-examples" target="_blank" rel="noopener">お客さま返信の例文集</a>
  </div>
  <div class="bottom-space"></div>
</div>
<div class="tab-panel" id="panel-w" role="tabpanel">
  <div class="sec-hd is-n" id="hd-wn" hidden>新着 <span class="sec-cnt" id="cnt-wn">0件</span></div>
  <div id="list-wn"></div>
  <div class="sec-hd is-w" id="hd-ww" hidden>要確認 <span class="sec-cnt" id="cnt-ww">0件</span></div>
  <div id="list-ww"></div>
  <div class="sec-hd">確定済み <span class="sec-cnt" id="cnt-wc">–</span></div>
  <button class="conf-toggle" aria-expanded="false" id="ct-w"><span class="chev">▾</span><span id="ct-w-lbl">確定済みを表示</span></button>
  <div class="conf-list" id="list-wc"></div>
  <div class="bottom-space"></div>
</div>
</div>
<script>
var token=new URLSearchParams(location.search).get('token')||'';
var avData=null,CONF={},WSAPPS=[],REQS=[];
var SS={
  get:function(k){try{var v=sessionStorage.getItem('pk_'+k);return v!==null?JSON.parse(v):null;}catch(e){return null;}},
  set:function(k,v){try{sessionStorage.setItem('pk_'+k,JSON.stringify(v));}catch(e){}}
};
function pad2(n){return String(n).padStart(2,'0');}
function fmt(d,t){var p=d.split('-');var dow=['日','月','火','水','木','金','土'][new Date(d+'T00:00:00').getDay()];return(+p[1])+'/'+(+p[2])+'('+dow+')'+(t?' '+t:'');}
function isNew(c){return c&&(Date.now()-new Date(c).getTime())<86400000;}
function setDocLinks(){['manual-overview','liff-setup','notify-on','booking-test','message-examples'].forEach(function(s){var e=document.getElementById('doc-'+s);if(e)e.href='/api/liff/booking-gcal/manual/'+s+'?token='+encodeURIComponent(token);});}
function switchTab(tab,push){
  document.querySelectorAll('.tab-btn').forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.toggle('active',p.id==='panel-'+tab);});
  if(push!==false){SS.set('tab',tab);var u=new URL(location.href);u.hash=tab;history.pushState({tab:tab},'',u.toString());}
}
window.addEventListener('popstate',function(e){if(e.state&&e.state.tab)switchTab(e.state.tab,false);});
function initAddToggle(){
  var btn=document.getElementById('add-btn'),form=document.getElementById('add-form');
  if(SS.get('add_open')===true){btn.setAttribute('aria-expanded','true');form.classList.add('open');}
  btn.addEventListener('click',function(){var open=btn.getAttribute('aria-expanded')!=='true';btn.setAttribute('aria-expanded',String(open));form.classList.toggle('open',open);SS.set('add_open',open);if(open){var f=form.querySelector('input,select');if(f)f.focus();}});
}
function initConfToggle(btnId,listId){
  var btn=document.getElementById(btnId),list=document.getElementById(listId),key='ct_'+listId;
  if(SS.get(key)===true){btn.setAttribute('aria-expanded','true');list.classList.add('open');}
  btn.addEventListener('click',function(){var open=btn.getAttribute('aria-expanded')!=='true';btn.setAttribute('aria-expanded',String(open));list.classList.toggle('open',open);SS.set(key,open);});
}
function initFormPersist(){
  document.querySelectorAll('.add-form input,.add-form select').forEach(function(inp){
    var k='fld_'+inp.name,v=SS.get(k);
    if(v!==null)inp.value=v;
    inp.addEventListener('input',function(){SS.set(k,inp.value);});
    inp.addEventListener('change',function(){SS.set(k,inp.value);});
  });
}
function addManual(){
  var date=document.getElementById('f-date').value,time=document.getElementById('f-time').value;
  var loc=document.getElementById('f-loc').value,dur=parseInt(document.getElementById('f-menu').value);
  var who=document.getElementById('f-name').value.trim();
  if(!date||!time||!loc||!who){alert('場所・日付・時刻・お名前を入れてください');return;}
  var p=time.split(':'),t=(+p[0])*60+(+p[1])+dur,end=pad2(Math.floor(t/60)%24)+':'+pad2(t%60);
  fetch('/api/liff/booking-gcal/import-existing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,items:[{date:date,start:time,end:end,location:loc,who:who}]})}).then(function(r){return r.json();}).then(function(j){if(j.ok){document.getElementById('f-name').value='';SS.set('fld_f_name','');alert('追加しました。この枠を予約で埋めました。');load();}else alert('追加に失敗しました。');});
}
function renderSessions(){
  var pend=REQS.filter(function(r){return r.status==='pending';});
  var conf=REQS.filter(function(r){return r.status==='confirmed';});
  CONF={};conf.forEach(function(r){CONF[r.id]=r;});
  document.getElementById('s-warn').textContent=pend.length;
  document.getElementById('s-conf').textContent=conf.length;
  var tb=document.getElementById('tab-s'),badge=tb.querySelector('.badge');
  if(pend.length>0){if(!badge){badge=document.createElement('span');badge.className='badge';tb.appendChild(badge);}badge.textContent=pend.length;}else if(badge)badge.remove();
  document.getElementById('cnt-sw').textContent=pend.length+'件';
  document.getElementById('cnt-sc').textContent=conf.length+'件';
  var lw=document.getElementById('list-sw');lw.innerHTML='';
  if(!pend.length)lw.innerHTML='<div class="empty">保留中の施術予約はありません。</div>';
  else pend.forEach(function(r){lw.appendChild(sessCard(r));});
  document.getElementById('ct-s-lbl').textContent='確定済み '+conf.length+'件を表示';
  var lc=document.getElementById('list-sc');lc.innerHTML='';
  conf.forEach(function(r){lc.appendChild(sessCardConf(r));});
}
function sessCard(r){
  var d=document.createElement('div');d.className='card c-w';
  var meta=r.location+'／'+r.menu_name+(r.phone?'　☎'+r.phone:'')+'　LINE:'+(r.display_name||'—');
  var h='<div class="card-body"><div class="card-head"><div class="card-name">'+r.who+'</div><span class="card-st st-w">要確認</span></div><div class="card-meta">'+meta+'</div><div class="hopes-list">';
  (r.hopes||[]).forEach(function(hp,i){h+='<button class="btn-hope" onclick="cf(\''+r.id+'\','+i+')">第'+(i+1)+'希望　'+fmt(hp.date)+' '+hp.start+'　<b>この時間で確定</b></button>';});
  h+='</div><div class="card-actions"><button class="btn btn-cancel" onclick="cx(\''+r.id+'\')">キャンセル</button></div></div>';
  d.innerHTML=h;return d;
}
function sessCardConf(r){
  var d=document.createElement('div');d.className='card c-c';
  var meta=r.location+'／'+r.menu_name+'　'+fmt(r.date,r.start_hm)+(r.phone?'　☎'+r.phone:'')+'　LINE:'+(r.display_name||'—');
  var h='<div class="card-body"><div class="card-head"><div class="card-name">'+r.who+'</div><span class="card-st st-c">確定済み</span></div><div class="card-meta">'+meta+'</div><div class="card-actions"><button class="btn btn-remove" onclick="tgl(\''+r.id+'\')">時間を変更</button><button class="btn btn-cancel" onclick="cx(\''+r.id+'\')">キャンセル</button></div><div class="picker" id="rs-'+r.id+'" style="display:none"></div></div>';
  d.innerHTML=h;return d;
}
function renderWS(){
  var nw=WSAPPS.filter(function(a){return a.status==='applied'&&isNew(a.created_at);});
  var wr=WSAPPS.filter(function(a){return a.status==='applied'&&!isNew(a.created_at);});
  var cf=WSAPPS.filter(function(a){return a.status==='confirmed';});
  document.getElementById('w-new').textContent=nw.length;
  document.getElementById('w-warn').textContent=wr.length;
  document.getElementById('w-conf').textContent=cf.length;
  var cell=document.getElementById('sum-w'),flag=document.getElementById('w-flag');
  cell.classList.toggle('has-new',nw.length>0);
  if(flag)flag.hidden=nw.length===0;
  var tb=document.getElementById('tab-w'),badge=tb.querySelector('.badge');
  var total=nw.length+wr.length;
  if(total>0){if(!badge){badge=document.createElement('span');badge.className='badge';tb.appendChild(badge);}badge.textContent=total;}else if(badge)badge.remove();
  document.getElementById('hd-wn').hidden=nw.length===0;
  document.getElementById('hd-ww').hidden=wr.length===0;
  document.getElementById('cnt-wn').textContent=nw.length+'件';
  document.getElementById('cnt-ww').textContent=wr.length+'件';
  document.getElementById('cnt-wc').textContent=cf.length+'件';
  var ln=document.getElementById('list-wn');ln.innerHTML='';
  var lw=document.getElementById('list-ww');lw.innerHTML='';
  var lc=document.getElementById('list-wc');lc.innerHTML='';
  if(!nw.length&&!wr.length)ln.innerHTML='<div class="empty">申込中の講座・ワークショップはありません。</div>';
  nw.forEach(function(a){ln.appendChild(wsCard(a,'n'));});
  wr.forEach(function(a){lw.appendChild(wsCard(a,'w'));});
  cf.forEach(function(a){lc.appendChild(wsCard(a,'c'));});
  document.getElementById('ct-w-lbl').textContent='確定済み '+cf.length+'件を表示';
  return nw.length>0;
}
function wsCard(a,t){
  var d=document.createElement('div');d.className='card c-'+t;
  var stL={n:['st-n','新着'],w:['st-w','要確認'],c:['st-c','確定済み']}[t];
  var h='<div class="card-body"><div class="card-head"><div class="card-name">'+a.workshop_title+'</div><span class="card-st '+stL[0]+'">'+stL[1]+'</span></div><div class="card-meta">'+(a.date?fmt(a.date):'')+'　'+a.who+'　'+a.count+'名</div>';
  if(a.phone)h+='<div class="card-phone">📞 '+a.phone+'</div>';
  if(t!=='c')h+='<div class="card-actions"><button class="btn btn-confirm" onclick="wsc(\''+a.id+'\')">確定する</button><button class="btn btn-cancel" onclick="wsx(\''+a.id+'\')">申込取消</button></div>';
  else h+='<div class="card-actions"><button class="btn btn-remove" onclick="wsx(\''+a.id+'\')">取消・削除</button></div>';
  h+='</div>';
  d.innerHTML=h;return d;
}
function load(){
  document.getElementById('list-sw').innerHTML='<div class="empty">読み込み中…</div>';
  Promise.all([
    fetch('/api/liff/booking-gcal/rei-requests?token='+encodeURIComponent(token)).then(function(r){return r.json();}),
    fetch('/api/liff/booking-gcal/availability').then(function(r){return r.json();}),
    fetch('/api/liff/booking-gcal/rei-ws?token='+encodeURIComponent(token)).then(function(r){return r.json();})
  ]).then(function(res){
    if(res[0].error){document.getElementById('list-sw').innerHTML='<div class="empty">アクセスできません。URLをご確認ください。</div>';return;}
    REQS=res[0].requests||[];
    avData=res[1]||{};
    WSAPPS=(res[2]&&res[2].apps)||[];
    renderSessions();
    var wsNew=renderWS();
    var savedTab=SS.get('tab');
    if(!savedTab){var t=wsNew?'w':'s';switchTab(t,false);history.replaceState({tab:t},'','#'+t);}
  });
}
function cf(id,idx){fetch('/api/liff/booking-gcal/rei-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,id:id,hopeIndex:idx})}).then(function(r){return r.json();}).then(function(j){if(j.ok)load();else alert('確定に失敗しました');});}
function cx(id){fetch('/api/liff/booking-gcal/rei-cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,id:id})}).then(function(r){return r.json();}).then(function(j){if(j.ok)load();else alert('キャンセルに失敗しました');});}
function tgl(id){
  var el=document.getElementById('rs-'+id);
  if(el.style.display!=='none'){el.style.display='none';return;}
  var r=CONF[id];if(!r)return;
  var days=((avData.availability||{})[r.location])||[];
  var h='<div style="font-size:.8rem;color:var(--tx3);margin:0 0 6px">変更先の空き枠を選んでください（'+r.location+'）</div>';
  var any=false;
  days.forEach(function(d){
    var mm=(d.menus||[]).filter(function(x){return x.key===r.menu_key;})[0];
    if(!mm)return;
    var free=mm.slots.filter(function(s){return !s.busy;});
    if(!free.length)return;
    any=true;
    h+='<div style="font-size:.82rem;font-weight:600;color:var(--ac);margin:6px 0 2px">'+fmt(d.date)+'</div><div>';
    free.forEach(function(s){h+='<button class="slotbtn" onclick="rs(\''+id+'\',\''+d.date+'\',\''+s.start+'\')">'+s.start+'</button>';});
    h+='</div>';
  });
  if(!any)h+='<div class="empty">変更できる空き枠がありません。</div>';
  el.innerHTML=h;el.style.display='block';
}
function rs(id,date,start){fetch('/api/liff/booking-gcal/rei-reschedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,id:id,newDate:date,newStart:start})}).then(function(r){return r.json();}).then(function(j){if(j.ok)load();else alert('変更に失敗しました');});}
function wsc(id){fetch('/api/liff/booking-gcal/rei-ws-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,id:id})}).then(function(r){return r.json();}).then(function(j){if(j.ok)load();});}
function wsx(id){fetch('/api/liff/booking-gcal/rei-ws-cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,id:id})}).then(function(r){return r.json();}).then(function(j){if(j.ok)load();});}
(function init(){
  setDocLinks();
  var saved=SS.get('tab');
  var initTab=saved||'s';
  switchTab(initTab,false);
  history.replaceState({tab:initTab},'','#'+initTab);
  document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){switchTab(b.dataset.tab);});});
  initAddToggle();
  initConfToggle('ct-s','list-sc');
  initConfToggle('ct-w','list-wc');
  initFormPersist();
  document.getElementById('submit-manual').addEventListener('click',addManual);
  load();
})();
</script></body></html>`;

const REI_TEST_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ぽかんと 検証用</title>
<style>*{box-sizing:border-box}body{margin:0;background:#eef2f5;color:#33454f;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;padding:16px}
.card{background:#fff;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.who{font-weight:700}.meta{color:#6b7c86;font-size:.85rem;margin-top:4px}
.btn{background:#c0453f;color:#fff;border:none;border-radius:10px;padding:12px 18px;font-size:.95rem;width:100%;margin-top:6px}
.btn2{background:#3f7a52;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:.86rem;width:100%;margin-top:9px}
.btn2:disabled{opacity:.6}
.warn{color:#c0453f;font-size:.8rem;margin-top:8px}
.sub{color:#6b7c86;font-size:.83rem;margin:4px 0 14px}
.empty{color:#8a97a0;text-align:center;padding:30px 0}
h1{font-size:1.05rem;margin-bottom:2px}
</style></head><body>
<h1>&#128295; テスト予約の確認（表示名・住所検証用）</h1>
<p class="sub">緑のボタンで「確定」すると、住所入りの確定通知をご自身のLINEだけに送れます（れいさんのカレンダー・通知には触れません）。</p>
<div id="list">読み込み中…</div>
<button class="btn" onclick="clearAll()">テストデータを全部消す</button>
<script>
var token=new URLSearchParams(location.search).get("token")||"";
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function load(){fetch("/api/liff/booking-gcal/rei-test-requests?token="+encodeURIComponent(token)).then(function(r){return r.json();}).then(function(j){var el=document.getElementById("list");if(j.error){el.innerHTML='<div class="empty">アクセスできません。URLをご確認ください。</div>';return;}var reqs=j.requests||[];if(!reqs.length){el.innerHTML='<div class="empty">まだテスト予約はありません。</div>';return;}var h="";reqs.forEach(function(r){h+='<div class="card"><div class="who">'+esc(r.who)+'</div><div class="meta">LINE表示名: <b>'+esc(r.display_name||"（空）")+'</b></div><div class="meta">'+esc(r.location)+'／'+esc(r.menu_name)+'</div><div class="meta">'+esc(r.created_at)+'</div>';if(r.hasLineUser){h+='<button class="btn2" data-id="'+r.id+'">📍 確定して住所入り通知を自分に送る</button>';}else{h+='<div class="warn">⚠️ LINEユーザー情報がありません。LINEアプリ内で開いたページから送り直してください。</div>';}h+='</div>';});el.innerHTML=h;Array.prototype.forEach.call(el.querySelectorAll(".btn2"),function(btn){btn.addEventListener("click",function(){confirmTest(btn.getAttribute("data-id"),btn);});});});}
function confirmTest(id,btn){if(!id)return;if(btn){btn.disabled=true;btn.textContent="送信中…";}fetch("/api/liff/booking-gcal/rei-test-confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token,id:id,hopeIndex:0})}).then(function(r){return r.json();}).then(function(j){if(j.ok){alert("送りました。ご自身のLINEをご確認ください。");}else{alert("失敗しました: "+(j.message||j.error||""));}if(btn){btn.disabled=false;btn.textContent="📍 確定して住所入り通知を自分に送る";}});}
function clearAll(){if(!confirm("テストデータを全部消しますか？"))return;fetch("/api/liff/booking-gcal/rei-test-clear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token})}).then(function(r){return r.json();}).then(function(j){alert(j.ok?("消しました（"+j.deleted+"件）"):"失敗しました");load();});}
load();
</script></body></html>`;

const WS_PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="ぽかんと講座"><title>ぽかんと ワークショップ・講座</title>'
+ '<style>'
+ '*{box-sizing:border-box}body{margin:0;background:#eef2f5;color:#33454f;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.7}'
+ '.h{background:linear-gradient(135deg,#5b82a6,#83a8c6);color:#fff;padding:18px 16px}.h b{font-size:1.1rem}.h p{margin:4px 0 0;font-size:.82rem;opacity:.95}'
+ '.w{max-width:560px;margin:0 auto;padding:14px}'
+ '.card{background:#fff;border:1px solid #dde6ec;border-radius:12px;padding:14px 16px;margin:10px 0}'
+ '.card h3{margin:0 0 4px;font-size:1.02rem;color:#3f6488}.card .dt{font-size:.86rem;color:#5b82a6;font-weight:600}.card p{margin:6px 0 0;font-size:.88rem;color:#556;white-space:pre-wrap}'
+ '.mrow{font-size:.86rem;color:#4a5a64;margin-top:5px}.mrow b{color:#3f6488;font-weight:600}'
+ '.empty{color:#7c8b96;font-size:.88rem;padding:14px 0;text-align:center}'
+ '.cap{display:inline-block;background:#eaf6ee;color:#2f9e57;border-radius:999px;padding:2px 11px;font-size:.8rem;margin-top:8px}'
+ '.full{display:inline-block;background:#f1f2f3;color:#999;border-radius:999px;padding:2px 11px;font-size:.8rem;margin-top:8px}'
+ '.apply{display:block;width:100%;margin-top:11px;background:#5b82a6;color:#fff;border:none;border-radius:10px;padding:11px;font-size:.92rem;font-weight:700;cursor:pointer}.apply:disabled{background:#c9ccd0}'
+ '.form{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}.form input{flex:1;min-width:130px;border:1px solid #cfd8e0;border-radius:8px;padding:10px}.form select{border:1px solid #cfd8e0;border-radius:8px;padding:10px}.sub{background:#06C755;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}'
+ '</style></head><body>'
+ '<div class="h"><b>ワークショップ・講座</b><p>ぽかんとの身体ワークショップ・各種講座のご案内です。気になるものは「申し込む」からどうぞ。</p></div>'
+ '<div class="w"><div id="list"><div class="empty">読み込み中…</div></div></div>'
+ '<script>'
+ 'var WS=[];'
+ 'function esc(s){return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
+ 'function wd(d){return ["日","月","火","水","木","金","土"][new Date(d+"T00:00:00").getDay()];}'
+ 'function fmt(d){var p=d.split("-");return (+p[1])+"/"+(+p[2])+"("+wd(d)+")";}'
+ 'fetch("/api/liff/booking-gcal/workshops-data").then(function(r){return r.json();}).then(function(j){WS=j.workshops||[];render();});'
+ 'function metaRows(w){var h="";if(w.online){h+="<div class=\\"mrow\\"><b>🖥 オンライン</b></div>";}else if(w.place){h+="<div class=\\"mrow\\"><b>📍 場所</b>　"+esc(w.place)+"</div>";}if(w.price){h+="<div class=\\"mrow\\"><b>💴 料金</b>　"+esc(w.price)+"</div>";}if(w.desc){h+="<p>"+esc(w.desc)+"</p>";}return h;}'
+ 'function render(){var h="";if(!WS.length){h="<div class=\\"empty\\">現在ご案内中の講座はありません。</div>";}WS.forEach(function(w,i){var full=(w.remaining!=null&&w.remaining<=0);var capTxt=w.capacity!=null?(full?"満席":"残り"+w.remaining+"名"):"";h+="<div class=\\"card\\"><h3>"+esc(w.title)+"</h3><div class=\\"dt\\">"+fmt(w.date)+" "+w.start+"〜"+w.end+"</div>"+metaRows(w)+(capTxt?"<div class=\\""+(full?"full":"cap")+"\\">"+capTxt+"</div>":"");if(full){h+="<button class=\\"apply\\" disabled>満席です</button>";}else{h+="<button class=\\"apply\\" onclick=\\"tgl("+i+")\\">申し込む</button><div class=\\"form\\" id=\\"f"+i+"\\" style=\\"display:none\\"><input id=\\"n"+i+"\\" placeholder=\\"お名前（フルネーム）\\"><input id=\\"t"+i+"\\" type=\\"tel\\" inputmode=\\"tel\\" placeholder=\\"電話番号\\"><select id=\\"c"+i+"\\"><option>1名</option><option>2名</option><option>3名</option><option>4名</option><option>5名</option></select><button class=\\"sub\\" onclick=\\"apply("+i+")\\">送信</button></div>";}h+="</div>";});document.getElementById("list").innerHTML=h;}'
+ 'function tgl(i){var f=document.getElementById("f"+i);f.style.display=(f.style.display==="none")?"flex":"none";}'
+ 'function apply(i){var w=WS[i];var name=document.getElementById("n"+i).value.trim();var tel=document.getElementById("t"+i).value.trim();if(!name){alert("お名前（フルネーム）を入力してください");return;}if(!tel){alert("電話番号を入力してください");return;}var count=document.getElementById("c"+i).selectedIndex+1;var btn=event&&event.target;if(btn){btn.disabled=true;btn.textContent="送信中…";}fetch("/api/liff/booking-gcal/ws-apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({eventId:w.eventId,title:w.title,date:w.date,who:name,phone:tel,count:count})}).then(function(r){return r.json();}).then(function(j){if(j.ok&&j.id){location.href="/api/liff/booking-gcal/ws-status?id="+encodeURIComponent(j.id);}else{alert("送信に失敗しました");if(btn){btn.disabled=false;btn.textContent="送信";}}});}'
+ '</script></body></html>';

const WS_STATUS_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="ぽかんと申込確認"><title>ぽかんと 申込確認</title>'
+ '<style>'
+ '*{box-sizing:border-box}body{margin:0;background:#eef2f5;color:#33454f;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.7}'
+ '.h{background:linear-gradient(135deg,#5b82a6,#83a8c6);color:#fff;padding:18px 16px}.h b{font-size:1.1rem}.h p{margin:4px 0 0;font-size:.8rem;opacity:.95}.rl{float:right;background:rgba(255,255,255,.25);border:none;color:#fff;border-radius:999px;padding:4px 12px;font-size:.78rem;cursor:pointer}'
+ '.w{max-width:560px;margin:0 auto;padding:14px}'
+ '.card{background:#fff;border:1px solid #dde6ec;border-radius:12px;padding:15px 16px;margin:10px 0}'
+ '.card h3{margin:0 0 4px;font-size:1.05rem;color:#3f6488}.card .dt{font-size:.88rem;color:#5b82a6;font-weight:600}'
+ '.mrow{font-size:.86rem;color:#4a5a64;margin-top:5px}.mrow b{color:#3f6488;font-weight:600}'
+ '.st{border-radius:12px;padding:14px 16px;margin:10px 0;font-size:.95rem;font-weight:700;text-align:center}'
+ '.st.wait{background:#fff7e6;color:#b7791f;border:1px solid #f0dca8}.st.ok{background:#eaf6ee;color:#2f9e57;border:1px solid #b9e2c6}.st.ng{background:#f6eceb;color:#a15641;border:1px solid #e6cfc9}'
+ '.urlbox{background:#fff;border:1px solid #dde6ec;border-radius:12px;padding:14px 16px;margin:10px 0}'
+ '.urlbox .lbl{font-size:.8rem;color:#7c8b96;margin-bottom:8px}'
+ '.join{display:block;width:100%;background:#06C755;color:#fff;border:none;border-radius:10px;padding:13px;font-size:.98rem;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}'
+ '.urltxt{word-break:break-all;font-size:.82rem;color:#557;margin-top:10px;background:#f6f8fa;border-radius:8px;padding:9px}'
+ '.copy{margin-top:8px;background:#eef2f5;border:1px solid #cfd8e0;color:#3f6488;border-radius:8px;padding:8px 14px;font-size:.82rem;cursor:pointer}'
+ '.note{font-size:.82rem;color:#7c8b96;margin-top:12px;text-align:center}.empty{color:#7c8b96;font-size:.9rem;padding:24px 0;text-align:center}'
+ '</style></head><body>'
+ '<div class="h"><button class="rl" onclick="load()">更新</button><b>お申し込みの確認</b><p>このページをブックマークしておくと、確定状況をいつでも確認できます。</p></div>'
+ '<div class="w"><div id="body"><div class="empty">読み込み中…</div></div></div>'
+ '<script>'
+ 'var id=new URLSearchParams(location.search).get("id")||"";'
+ 'function esc(s){return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
+ 'function wd(d){return ["日","月","火","水","木","金","土"][new Date(d+"T00:00:00").getDay()];}'
+ 'function fmt(d){if(!d)return "";var p=d.split("-");return (+p[1])+"/"+(+p[2])+"("+wd(d)+")";}'
+ 'function load(){if(!id){document.getElementById("body").innerHTML="<div class=\\"empty\\">申込が見つかりません。</div>";return;}fetch("/api/liff/booking-gcal/ws-status-data?id="+encodeURIComponent(id)).then(function(r){return r.json();}).then(render).catch(function(){document.getElementById("body").innerHTML="<div class=\\"empty\\">読み込みに失敗しました。時間をおいて更新してください。</div>";});}'
+ 'function render(j){if(!j||!j.ok){document.getElementById("body").innerHTML="<div class=\\"empty\\">申込が見つかりません。URLをご確認ください。</div>";return;}'
+ 'var meta="";if(j.online){meta+="<div class=\\"mrow\\"><b>🖥 オンライン</b></div>";}else if(j.place){meta+="<div class=\\"mrow\\"><b>📍 場所</b>　"+esc(j.place)+"</div>";}if(j.price){meta+="<div class=\\"mrow\\"><b>💴 料金</b>　"+esc(j.price)+"</div>";}'
+ 'var timeTxt=(j.date?fmt(j.date):"")+(j.start?" "+j.start+(j.end?"〜"+j.end:""):"");'
+ 'var h="<div class=\\"card\\"><h3>"+esc(j.title)+"</h3><div class=\\"dt\\">"+timeTxt+"</div>"+meta+"<div class=\\"mrow\\">お申込："+esc(j.who)+"　"+esc(j.count)+"名</div></div>";'
+ 'if(j.status==="cancelled"){h+="<div class=\\"st ng\\">この申込は取り消されました</div>";}'
+ 'else if(j.status==="confirmed"){h+="<div class=\\"st ok\\">✅ ご予約が確定しました</div>";'
+ 'if(j.online){if(j.url){h+="<div class=\\"urlbox\\"><div class=\\"lbl\\">オンライン参加用リンク</div><a class=\\"join\\" href=\\""+esc(j.url)+"\\" target=\\"_blank\\" rel=\\"noopener\\">参加用リンクを開く</a><div class=\\"urltxt\\" id=\\"ut\\">"+esc(j.url)+"</div><button class=\\"copy\\" onclick=\\"cp()\\">リンクをコピー</button></div>";}else{h+="<div class=\\"note\\">オンライン参加用のリンクは、準備ができ次第このページに表示されます。</div>";}}}'
+ 'else{h+="<div class=\\"st wait\\">お申し込みを受け付けました<br><span style=\\"font-weight:400;font-size:.85rem\\">担当が確認しています。確定するとこのページでお知らせします。</span></div>";}'
+ 'document.getElementById("body").innerHTML=h;}'
+ 'function cp(){var t=document.getElementById("ut");if(!t)return;var v=t.textContent;if(navigator.clipboard){navigator.clipboard.writeText(v).then(function(){alert("リンクをコピーしました");});}else{alert(v);}}'
+ 'load();setInterval(load,20000);'
+ '</script></body></html>';

const MYPAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="ぽかんとマイ予約"><title>ぽかんと マイ予約</title>'
+ '<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>'
+ '<style>'
+ ':root{--b:#3591b9;--b2:#78c0de;--bg:#fcfdf7;--ink:#33454f;--line:#dde6ec}'
+ '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.7}'
+ '.h{background:linear-gradient(135deg,#3591b9,#78c0de);color:#fff;padding:18px 16px}.h b{font-size:1.1rem}.h p{margin:4px 0 0;font-size:.82rem;opacity:.95}'
+ '.w{max-width:560px;margin:0 auto;padding:14px}'
+ '.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}'
+ '.card .dt{font-size:1rem;font-weight:700;color:var(--b)}.card .meta{font-size:.86rem;color:#556;margin-top:4px}'
+ '.cancelBtn{margin-top:11px;width:100%;background:#fff;color:#b0623f;border:1px solid #e6cfc9;border-radius:9px;padding:10px;font-size:.88rem;cursor:pointer}'
+ '.cancelBtn:disabled{opacity:.5;cursor:not-allowed}'
+ '.sec{font-size:.82rem;font-weight:700;color:var(--b);margin:20px 2px 6px}'
+ '.wait{display:inline-block;background:#fff7e6;color:#b7791f;border:1px solid #f0dca8;border-radius:999px;padding:1px 10px;font-size:.76rem;font-weight:700;margin-bottom:6px}'
+ '.hope{font-size:.85rem;color:#556;padding:2px 0}'
+ '.btnrow{display:flex;gap:8px;margin-top:11px}.btnrow .cancelBtn,.btnrow .chgBtn{margin-top:0;width:auto;flex:1}'
+ '.chgBtn{background:#fff;color:var(--b);border:1px solid #bcdcea;border-radius:9px;padding:10px;font-size:.88rem;cursor:pointer}'
+ '.picker{margin-top:10px;padding:10px;background:#f4f9fb;border:1px solid #d6e6ef;border-radius:10px}'
+ '.pkhint{font-size:.8rem;color:#6b7b86;margin-bottom:4px}.pkday{font-size:.82rem;font-weight:700;color:var(--b);margin:8px 0 3px}'
+ '.slotbtn{border:1px solid #bcdcea;background:#fff;color:var(--b);border-radius:8px;padding:7px 4px;width:58px;text-align:center;font-size:.83rem;cursor:pointer;margin:3px 3px 0 0}'
+ '.pkempty{font-size:.83rem;color:#9aa3ab;padding:4px 0}'
+ '.loading{color:#7c8b96;font-size:.9rem;padding:26px 10px;text-align:center}'
+ '.empty{color:#7c8b96;font-size:.9rem;padding:26px 10px;text-align:center}'
+ '.errbox{color:#a15641;font-size:.9rem;padding:18px 10px;text-align:center;background:#f6eceb;border-radius:12px;margin:12px 0}'
+ '.retry{margin-top:10px;background:var(--b);color:#fff;border:none;border-radius:9px;padding:9px 18px;font-size:.86rem;cursor:pointer}'
+ '.toast{background:#eaf6ee;color:#2f9e57;border:1px solid #b9e2c6;border-radius:10px;padding:11px 14px;font-size:.88rem;text-align:center;margin:10px 0}'
+ '.note{font-size:.8rem;color:#7c8b96;margin-top:14px;text-align:center}'
+ '</style></head><body>'
+ '<div class="h"><b>マイ予約</b><p>ご自身のご予約の確認・キャンセルができます。</p></div>'
+ '<div class="w"><div id="state"></div><div id="list"></div><div class="note">ご予約はメニューの「ご予約」からどうぞ。</div></div>'
+ '<script>'
+ 'function esc(s){return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
+ 'function wd(d){return ["日","月","火","水","木","金","土"][new Date(d+"T00:00:00").getDay()];}'
+ 'function fmt(d){var p=d.split("-");return (+p[1])+"/"+(+p[2])+"("+wd(d)+")";}'
+ '// マイ予約ページ専用のLIFFアプリID（予約フォームのiGDhVxUSとは別枠）\n'
+ 'var LIFF_ID="2010614528-dYHYFLUf";'
+ 'var accessToken=null;var CONF={};var AVAIL=null;'
+ 'function authHeaders(){return accessToken?{"Authorization":"Bearer "+accessToken}:{};}'
+ 'function setState(kind,msg){var el=document.getElementById("state");if(kind==="loading"){el.innerHTML="<div class=\\"loading\\">"+msg+"</div>";}else if(kind==="error"){el.innerHTML="<div class=\\"errbox\\">"+msg+"<br><button class=\\"retry\\" id=\\"retryBtn\\">更新</button></div>";var rb=document.getElementById("retryBtn");if(rb)rb.addEventListener("click",loadBookings);}else if(kind==="empty"){el.innerHTML="<div class=\\"empty\\">"+msg+"</div>";}else if(kind==="toast"){el.innerHTML="<div class=\\"toast\\">"+msg+"</div>";}else{el.innerHTML="";}}'
+ 'function renderList(bookings){var listEl=document.getElementById("list");if(!bookings||!bookings.length){listEl.innerHTML="";setState("empty","現在ご予約はありません。メニューの「ご予約」からどうぞ。");return;}setState("none","");CONF={};var conf=[],pend=[];bookings.forEach(function(b){(b.status==="pending"?pend:conf).push(b);});var h="";if(conf.length){h+="<div class=\\"sec\\">確定したご予約</div>";conf.forEach(function(b){CONF[b.id]=b;h+="<div class=\\"card\\"><div class=\\"dt\\">"+fmt(b.date)+" "+b.start_hm+"〜</div><div class=\\"meta\\">"+esc(b.location)+"　"+esc(b.menu_name||"")+"</div><div class=\\"btnrow\\"><button class=\\"chgBtn\\" data-id=\\""+b.id+"\\">時間を変更</button><button class=\\"cancelBtn\\" data-id=\\""+b.id+"\\">キャンセル</button></div><div class=\\"picker\\" id=\\"pk-"+b.id+"\\" style=\\"display:none\\"></div></div>";});}if(pend.length){h+="<div class=\\"sec\\">確定待ち（リクエスト送信中）</div>";pend.forEach(function(b){var hopes=b.hopes||[];var hl="";hopes.forEach(function(hp,i){hl+="<div class=\\"hope\\">第"+(i+1)+"希望　"+fmt(hp.date)+" "+hp.start+"〜</div>";});h+="<div class=\\"card\\"><div class=\\"wait\\">確定待ち</div><div class=\\"meta\\" style=\\"margin-bottom:6px\\">"+esc(b.location)+"　"+esc(b.menu_name||"")+"</div>"+hl+"<button class=\\"cancelBtn\\" data-id=\\""+b.id+"\\">リクエストを取り下げる</button></div>";});}listEl.innerHTML=h;Array.prototype.forEach.call(listEl.querySelectorAll(".cancelBtn"),function(btn){btn.addEventListener("click",function(){onCancel(btn.getAttribute("data-id"),btn);});});Array.prototype.forEach.call(listEl.querySelectorAll(".chgBtn"),function(btn){btn.addEventListener("click",function(){toggleChange(btn.getAttribute("data-id"));});});}'
+ 'function loadBookings(){setState("loading","読み込み中…");Promise.all([fetch("/api/liff/booking-gcal/my-bookings",{headers:authHeaders()}).then(function(r){if(!r.ok)throw new Error("http "+r.status);return r.json();}),fetch("/api/liff/booking-gcal/availability").then(function(r){return r.json();}).catch(function(){return null;})]).then(function(res){var j=res[0];AVAIL=res[1]||{};if(!j||!j.ok)throw new Error("bad response");renderList(j.bookings||[]);}).catch(function(){document.getElementById("list").innerHTML="";setState("error","読み込みに失敗しました。更新してください。");});}'
+ 'function toggleChange(id){var el=document.getElementById("pk-"+id);if(!el)return;if(el.style.display!=="none"){el.style.display="none";return;}var b=CONF[id];if(!b){return;}el.innerHTML="<div class=\\"pkempty\\">空き枠を読み込み中…</div>";el.style.display="block";fetch("/api/liff/booking-gcal/availability?exclude="+encodeURIComponent(id)).then(function(res){return res.json();}).then(function(ad){var days=((ad.availability||{})[b.location])||[];var h="<div class=\\"pkhint\\">変更したい新しい時間を選んでください（"+esc(b.location)+"）</div>";var any=false;days.forEach(function(d){var mm=(d.menus||[]).filter(function(x){return x.key===b.menu_key;})[0];if(!mm)return;var free=mm.slots.filter(function(s){return !s.busy;});if(!free.length)return;any=true;h+="<div class=\\"pkday\\">"+fmt(d.date)+"</div><div>";free.forEach(function(s){h+="<button class=\\"slotbtn\\" data-id=\\""+id+"\\" data-date=\\""+d.date+"\\" data-start=\\""+s.start+"\\">"+s.start+"</button>";});h+="</div>";});if(!any)h+="<div class=\\"pkempty\\">変更できる空き枠がありません。</div>";el.innerHTML=h;Array.prototype.forEach.call(el.querySelectorAll(".slotbtn"),function(sb){sb.addEventListener("click",function(){doChange(sb.getAttribute("data-id"),sb.getAttribute("data-date"),sb.getAttribute("data-start"),sb);});});}).catch(function(){el.innerHTML="<div class=\\"pkempty\\">読み込みに失敗しました。</div>";});}'
+ 'function doChange(id,date,start,btn){if(!confirm(fmt(date)+" "+start+"〜 に変更しますか？"))return;var orig=btn?btn.textContent:"";if(btn){btn.disabled=true;btn.textContent="…";}fetch("/api/liff/booking-gcal/my-reschedule",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},authHeaders()),body:JSON.stringify({id:id,newDate:date,newStart:start})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});}).then(function(res){if(res.ok&&res.body&&res.body.ok){setState("toast","✅ 時間を変更しました");loadBookings();}else{alert("変更に失敗しました。時間をおいてお試しください。");if(btn){btn.disabled=false;btn.textContent=orig;}}}).catch(function(){alert("変更に失敗しました。時間をおいてお試しください。");if(btn){btn.disabled=false;btn.textContent=orig;}});}'
+ 'function onCancel(id,btn){if(!id)return;if(!confirm("このご予約を取り消しますか？"))return;var orig=btn?btn.textContent:"";if(btn){btn.disabled=true;btn.textContent="処理中…";}fetch("/api/liff/booking-gcal/my-cancel",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},authHeaders()),body:JSON.stringify({id:id})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});}).then(function(res){if(res.ok&&res.body&&res.body.ok){setState("toast","✅ 取り消しました");loadBookings();}else{alert("取り消しに失敗しました。時間をおいてお試しください。");if(btn){btn.disabled=false;btn.textContent=orig;}}}).catch(function(){alert("取り消しに失敗しました。時間をおいてお試しください。");if(btn){btn.disabled=false;btn.textContent=orig;}});}'
+ 'function init(){if(!window.liff){setState("error","LINEアプリ内でお開きください。");return;}liff.init({liffId:LIFF_ID}).then(function(){if(!liff.isLoggedIn()){liff.login();return;}accessToken=liff.getAccessToken();if(!accessToken){setState("error","ログイン情報の取得に失敗しました。時間をおいて開き直してください。");return;}loadBookings();}).catch(function(){setState("error","初期化に失敗しました。時間をおいて開き直してください。");});}'
+ 'init();'
+ '</script></body></html>';

export { bookingGcal };
