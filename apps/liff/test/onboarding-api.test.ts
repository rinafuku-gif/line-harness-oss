import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/liff-auth.js', () => ({
  getIdToken: () => 'id-token',
  getLiffId: () => 'known-liff',
}));

import {
  ONBOARDING_REQUEST_TIMEOUT_MS,
  OnboardingApiError,
  onboardingApi,
} from '../src/lib/onboarding-api.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SATOYAMA onboarding API request boundary', () => {
  it('settles with a retryable timeout when the request never resolves', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { origin: 'https://line.satoyama-ai-base.com' },
    });
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const request = onboardingApi.get();
    const expectation = expect(request).rejects.toMatchObject({
      status: 0,
      code: 'request_timeout',
    });
    await vi.advanceTimersByTimeAsync(ONBOARDING_REQUEST_TIMEOUT_MS);
    await expectation;

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://line.satoyama-ai-base.com');
    expect(url.searchParams.get('liffId')).toBe('known-liff');
    expect(init.signal?.aborted).toBe(true);
  });

  it('keeps same-origin API calls and the ID token boundary', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://line.satoyama-ai-base.com' },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { program: {}, state: null, outcome: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(onboardingApi.get()).resolves.toMatchObject({
      state: null,
      outcome: null,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      'https://line.satoyama-ai-base.com/api/liff/onboarding/satoyama?liffId=known-liff',
    );
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer id-token',
    );
  });

  it('preserves provider status errors instead of mislabeling them as timeouts', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://line.satoyama-ai-base.com' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(onboardingApi.get()).rejects.toEqual(
      expect.objectContaining<Partial<OnboardingApiError>>({
        status: 401,
        code: 'Unauthorized',
      }),
    );
  });
});
