import { describe, expect, it } from 'vitest';
import { isSatoyamaOnboardingRequest } from './intent.js';

describe('isSatoyamaOnboardingRequest', () => {
  it('accepts the dedicated direct path with or without a trailing slash', () => {
    expect(
      isSatoyamaOnboardingRequest(
        new URL('https://worker.example.com/onboarding/satoyama?liffId=known'),
      ),
    ).toBe(true);
    expect(
      isSatoyamaOnboardingRequest(
        new URL('https://worker.example.com/onboarding/satoyama/'),
      ),
    ).toBe(true);
  });

  it('accepts the same-origin path restored through liff.state', () => {
    const url = new URL('https://worker.example.com/?liffId=known');
    url.searchParams.set(
      'liff.state',
      '/onboarding/satoyama?liffId=known',
    );
    expect(isSatoyamaOnboardingRequest(url)).toBe(true);
  });

  it('rejects other paths, malformed state, and cross-origin state', () => {
    expect(
      isSatoyamaOnboardingRequest(
        new URL('https://worker.example.com/?page=book'),
      ),
    ).toBe(false);
    expect(
      isSatoyamaOnboardingRequest(
        new URL(
          'https://worker.example.com/?liff.state=https%3A%2F%2Fevil.example%2Fonboarding%2Fsatoyama',
        ),
      ),
    ).toBe(false);
    expect(
      isSatoyamaOnboardingRequest(
        new URL('https://worker.example.com/?liff.state=http%3A%2F%2F%5B'),
      ),
    ).toBe(false);
  });
});
