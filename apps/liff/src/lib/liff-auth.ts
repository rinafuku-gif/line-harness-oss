import liff from '@line/liff';

let _liffId: string | null = null;
let _idToken: string | null = null;

const DEFAULT_LIFF_INIT_TIMEOUT_MS = 10_000;

function liffIdFromState(url: URL): string | null {
  const state = url.searchParams.get('liff.state');
  if (!state) return null;
  try {
    const restored = new URL(state, url.origin);
    return restored.searchParams.get('liffId');
  } catch {
    return null;
  }
}

export function resolveLiffId(url: URL): string | null {
  return (
    url.searchParams.get('liffId') ??
    liffIdFromState(url) ??
    import.meta.env.VITE_DEFAULT_LIFF_ID ??
    null
  );
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function initLiff(
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const url = new URL(window.location.href);
  // On the first LIFF redirect, additional path/query information can still
  // be packed into liff.state. Read the public liffId from there only for SDK
  // initialization; the server independently binds it to one account.
  const liffId = resolveLiffId(url);
  if (!liffId) {
    throw new Error('liffId not provided. Append ?liffId=... to the URL.');
  }
  _liffId = liffId;
  await withTimeout(
    liff.init({ liffId }),
    options.timeoutMs ?? DEFAULT_LIFF_INIT_TIMEOUT_MS,
    'LINEとの接続確認が時間内に完了しませんでした。',
  );
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: url.href });
    return false;
  }
  // id_token は Worker 側で LINE Login verify API を叩いて caller を確定するために使う。
  _idToken = liff.getIDToken();
  if (!_idToken) {
    throw new Error('LINEの本人確認情報を取得できませんでした。LINEアプリから開き直してください。');
  }
  return true;
}

export function getLiffId(): string {
  if (!_liffId) throw new Error('LIFF not initialized');
  return _liffId;
}

export function getIdToken(): string {
  if (!_idToken) throw new Error('LIFF not initialized or id_token not available');
  return _idToken;
}

export async function sendTextToLineChat(
  text: string,
): Promise<'sent' | 'copied' | 'copy_failed'> {
  if (liff.isInClient()) {
    try {
      await liff.sendMessages([{ type: 'text', text }]);
      return 'sent';
    } catch {
      // 初回公開では chat_message.write を要求しない。権限がない場合や
      // LINE側の送信に失敗した場合も、同じ文面をコピーして本人が送れるようにする。
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'copy_failed';
  }
}

export function closeLiffWindow(): void {
  if (liff.isInClient()) {
    liff.closeWindow();
    return;
  }
  if (window.history.length > 1) {
    window.history.back();
  }
}
