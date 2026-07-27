const SATOYAMA_ONBOARDING_PATH = '/onboarding/satoyama';

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * LINE opens the configured LIFF endpoint first and carries the requested
 * child path in `liff.state`. Direct checks use the child path itself.
 * Cross-origin state is ignored even when its pathname happens to match.
 */
export function isSatoyamaOnboardingRequest(url: URL): boolean {
  if (normalizedPath(url.pathname) === SATOYAMA_ONBOARDING_PATH) return true;

  const state = url.searchParams.get('liff.state');
  if (!state) return false;

  try {
    const restored = new URL(state, url.origin);
    return (
      restored.origin === url.origin &&
      normalizedPath(restored.pathname) === SATOYAMA_ONBOARDING_PATH
    );
  } catch {
    return false;
  }
}
