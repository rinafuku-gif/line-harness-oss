import { describe, expect, it } from 'vitest';
import { resolveSatoyamaOnboardingCorsOrigin } from './satoyama-onboarding-cors.js';

const WORKER = 'https://line-harness.example.workers.dev';
const LIFF = 'https://satoyama-onboarding.pages.dev';
const ONBOARDING = `${WORKER}/api/liff/onboarding/satoyama/submit`;

describe('resolveSatoyamaOnboardingCorsOrigin', () => {
  it('allows one explicitly configured HTTPS LIFF origin on onboarding only', () => {
    const env = { SATOYAMA_ONBOARDING_ORIGIN: `${LIFF}/` };
    expect(resolveSatoyamaOnboardingCorsOrigin(env, LIFF, ONBOARDING)).toBe(LIFF);
    expect(
      resolveSatoyamaOnboardingCorsOrigin(
        env,
        LIFF,
        `${WORKER}/api/friends`,
      ),
    ).toBe('');
  });

  it('keeps existing same-origin and admin-origin behavior', () => {
    const env = {
      ADMIN_ORIGIN: 'https://admin.example.com',
      SATOYAMA_ONBOARDING_ORIGIN: LIFF,
    };
    expect(resolveSatoyamaOnboardingCorsOrigin(env, WORKER, ONBOARDING)).toBe(
      WORKER,
    );
    expect(
      resolveSatoyamaOnboardingCorsOrigin(
        env,
        'https://admin.example.com',
        `${WORKER}/api/friends`,
      ),
    ).toBe('https://admin.example.com');
  });

  it('blocks unknown, malformed, and non-HTTPS production origins', () => {
    expect(
      resolveSatoyamaOnboardingCorsOrigin(
        { SATOYAMA_ONBOARDING_ORIGIN: LIFF },
        'https://evil.example.com',
        ONBOARDING,
      ),
    ).toBe('');
    expect(
      resolveSatoyamaOnboardingCorsOrigin(
        { SATOYAMA_ONBOARDING_ORIGIN: 'http://satoyama.example.com' },
        'http://satoyama.example.com',
        ONBOARDING,
      ),
    ).toBe('');
    expect(
      resolveSatoyamaOnboardingCorsOrigin(
        { SATOYAMA_ONBOARDING_ORIGIN: 'not a URL' },
        LIFF,
        ONBOARDING,
      ),
    ).toBe('');
  });
});
