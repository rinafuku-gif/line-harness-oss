import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SatoyamaOnboarding from '../../../../liff/src/pages/SatoyamaOnboarding.js';
import { initLiff } from '../../../../liff/src/lib/liff-auth.js';
import '../../../../liff/src/index.css';

export async function mountSatoyamaOnboarding(
  container: HTMLElement,
): Promise<void> {
  const preview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('preview') === '1';
  if (!preview && !(await initLiff())) return;

  // The legacy LIFF shell centers a 480 px card with inline styles. The
  // onboarding page owns its responsive layout, so remove only those shell
  // constraints after the dedicated route has been selected.
  document.body.style.display = 'block';
  document.body.style.minHeight = '100vh';
  document.body.style.background = '#f4f7f3';
  container.style.maxWidth = 'none';
  container.style.width = '100%';
  container.style.padding = '0';
  container.replaceChildren();

  createRoot(container).render(
    <StrictMode>
      <SatoyamaOnboarding />
    </StrictMode>,
  );
}
