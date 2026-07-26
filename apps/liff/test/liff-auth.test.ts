import { beforeEach, describe, expect, it, vi } from 'vitest';

const liffMock = vi.hoisted(() => ({
  isInClient: vi.fn<() => boolean>(),
  sendMessages: vi.fn<(messages: Array<{ type: 'text'; text: string }>) => Promise<void>>(),
  closeWindow: vi.fn<() => void>(),
}));

vi.mock('@line/liff', () => ({
  default: liffMock,
}));

import { sendTextToLineChat } from '../src/lib/liff-auth.js';

describe('sendTextToLineChat', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue();
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    });
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
