import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liffMock = vi.hoisted(() => ({
  init: vi.fn<(config: { liffId: string }) => Promise<void>>(),
  isLoggedIn: vi.fn<() => boolean>(),
  login: vi.fn<(options?: { redirectUri?: string }) => void>(),
  getIDToken: vi.fn<() => string | null>(),
  isInClient: vi.fn<() => boolean>(),
  sendMessages: vi.fn<(messages: Array<{ type: 'text'; text: string }>) => Promise<void>>(),
  closeWindow: vi.fn<() => void>(),
}));

vi.mock('@line/liff', () => ({
  default: liffMock,
}));

import {
  initLiff,
  resolveLiffId,
  sendTextToLineChat,
} from '../src/lib/liff-auth.js';

describe('sendTextToLineChat', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
    liffMock.init.mockResolvedValue();
    liffMock.isLoggedIn.mockReturnValue(true);
    liffMock.getIDToken.mockReturnValue('id-token');
    writeText.mockResolvedValue();
    vi.stubGlobal('window', {
      location: {
        href: 'https://worker.example.com/onboarding/satoyama?liffId=known-liff',
      },
    });
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports that rendering can continue only after login and ID token retrieval', async () => {
    await expect(initLiff()).resolves.toBe(true);
    expect(liffMock.init).toHaveBeenCalledWith({ liffId: 'known-liff' });
    expect(liffMock.getIDToken).toHaveBeenCalledOnce();
  });

  it('starts LINE login and stops rendering when the user is not logged in', async () => {
    liffMock.isLoggedIn.mockReturnValue(false);

    await expect(initLiff()).resolves.toBe(false);
    expect(liffMock.login).toHaveBeenCalledWith({
      redirectUri:
        'https://worker.example.com/onboarding/satoyama?liffId=known-liff',
    });
    expect(liffMock.getIDToken).not.toHaveBeenCalled();
  });

  it('restores the LIFF ID when LINE opens the root endpoint with liff.state', async () => {
    vi.stubGlobal('window', {
      location: {
        href:
          'https://worker.example.com/?liff.state=%2Fonboarding%2Fsatoyama%3FliffId%3Dstate-liff',
      },
    });

    await expect(initLiff()).resolves.toBe(true);
    expect(liffMock.init).toHaveBeenCalledWith({ liffId: 'state-liff' });
  });

  it('settles with an error when LIFF SDK initialization never resolves', async () => {
    vi.useFakeTimers();
    liffMock.init.mockReturnValue(new Promise(() => undefined));

    const expectation = expect(initLiff({ timeoutMs: 50 })).rejects.toThrow(
      '時間内に完了しませんでした',
    );
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
  });

  it('prefers the direct LIFF ID over a different value in liff.state', () => {
    expect(
      resolveLiffId(
        new URL(
          'https://worker.example.com/onboarding/satoyama?liffId=direct&liff.state=%2Fonboarding%2Fsatoyama%3FliffId%3Dstate',
        ),
      ),
    ).toBe('direct');
  });

  it('fails closed when LINE does not return an ID token', async () => {
    liffMock.getIDToken.mockReturnValue(null);

    await expect(initLiff()).rejects.toThrow('本人確認情報');
  });

  it('sends directly when the LIFF client grants message permission', async () => {
    liffMock.isInClient.mockReturnValue(true);
    liffMock.sendMessages.mockResolvedValue();

    await expect(sendTextToLineChat('相談文')).resolves.toBe('sent');
    expect(liffMock.sendMessages).toHaveBeenCalledWith([
      { type: 'text', text: '相談文' },
    ]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies the message when in-client sending is unavailable', async () => {
    liffMock.isInClient.mockReturnValue(true);
    liffMock.sendMessages.mockRejectedValue(new Error('scope unavailable'));

    await expect(sendTextToLineChat('相談文')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('相談文');
  });

  it('copies the message when opened outside the LINE client', async () => {
    liffMock.isInClient.mockReturnValue(false);

    await expect(sendTextToLineChat('相談文')).resolves.toBe('copied');
    expect(liffMock.sendMessages).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('相談文');
  });
});
