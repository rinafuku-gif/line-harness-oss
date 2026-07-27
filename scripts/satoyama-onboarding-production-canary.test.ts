import { describe, expect, it, vi } from 'vitest';
import { runSatoyamaOnboardingProductionCanary } from './satoyama-onboarding-production-canary.js';

describe('SATOYAMA onboarding production canary safety', () => {
  it('uses only unauthenticated GET requests and never sends a body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('<!doctype html><div id="root"></div>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(
      runSatoyamaOnboardingProductionCanary({
        baseUrl: 'https://line.example.com',
        liffId: 'known-liff-id',
        fetchImpl,
      }),
    ).resolves.toEqual({ pageStatus: 200, apiStatus: 401 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://line.example.com/onboarding/satoyama?liffId=known-liff-id',
    );
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'https://line.example.com/api/liff/onboarding/satoyama?liffId=known-liff-id',
    );
  });

  it('fails if the unauthenticated API does not fail closed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(
      runSatoyamaOnboardingProductionCanary({
        baseUrl: 'https://line.example.com',
        liffId: 'known-liff-id',
        fetchImpl,
      }),
    ).rejects.toThrow(/must fail closed with 401/);
  });

  it('rejects non-HTTPS targets before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runSatoyamaOnboardingProductionCanary({
        baseUrl: 'http://line.example.com',
        liffId: 'known-liff-id',
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
