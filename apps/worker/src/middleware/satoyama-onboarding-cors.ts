import {
  resolveCorsOrigin,
  type AdminAuthEnv,
} from './admin-auth-config.js';

export interface SatoyamaOnboardingCorsEnv extends AdminAuthEnv {
  SATOYAMA_ONBOARDING_ORIGIN?: string;
}

const ONBOARDING_API_PATH = '/api/liff/onboarding/satoyama';

function normalizedHttpsOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isOnboardingApi(requestUrl: string): boolean {
  try {
    const path = new URL(requestUrl).pathname;
    return path === ONBOARDING_API_PATH || path.startsWith(`${ONBOARDING_API_PATH}/`);
  } catch {
    return false;
  }
}

/**
 * Keep the existing admin/same-origin CORS policy intact, while permitting one
 * separately hosted LIFF origin only on the SATOYAMA onboarding endpoints.
 * The LIFF flow uses a Bearer ID token and never relies on admin cookies.
 */
export function resolveSatoyamaOnboardingCorsOrigin(
  env: SatoyamaOnboardingCorsEnv,
  origin: string | null | undefined,
  requestUrl: string,
): string {
  const existing = resolveCorsOrigin(env, origin, requestUrl);
  if (existing || !origin || !isOnboardingApi(requestUrl)) return existing;

  const configured = normalizedHttpsOrigin(env.SATOYAMA_ONBOARDING_ORIGIN);
  const requested = normalizedHttpsOrigin(origin);
  return configured && requested === configured ? origin : '';
}
