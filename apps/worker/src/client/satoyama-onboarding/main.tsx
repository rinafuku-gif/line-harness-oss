import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SatoyamaOnboarding from '../../../../liff/src/pages/SatoyamaOnboarding.js';
import { initLiff } from '../../../../liff/src/lib/liff-auth.js';
import '../../../../liff/src/index.css';

type BootstrapState = 'connecting' | 'login' | 'error';

function prepareContainer(container: HTMLElement): void {
  // The legacy LIFF shell centers a 480 px card with inline styles. The
  // onboarding page owns its responsive layout, so remove only those shell
  // constraints after the dedicated route has been selected.
  document.body.style.display = 'block';
  document.body.style.minHeight = '100vh';
  document.body.style.background = '#f4f7f3';
  container.style.maxWidth = 'none';
  container.style.width = '100%';
  container.style.padding = '0';
}

function renderBootstrapState(
  container: HTMLElement,
  state: BootstrapState,
): void {
  const content = state === 'connecting'
    ? {
        title: 'LINEとの接続を確認しています',
        body: '通常は数秒で画面が開きます。',
      }
    : state === 'login'
      ? {
          title: 'LINEログインへ移動しています',
          body: '画面が切り替わらない場合は、もう一度お試しください。',
        }
      : {
          title: 'ページを開けませんでした',
          body: '通信状態を確認して、もう一度お試しください。',
        };
  const retry = state === 'connecting'
    ? ''
    : `
      <button type="button" class="primary-button" data-onboarding-retry>
        もう一度試す
      </button>
    `;
  container.innerHTML = `
    <div class="satoyama-onboarding-page">
      <main class="onboarding-shell">
        <section class="onboarding-card error-card" role="${state === 'error' ? 'alert' : 'status'}">
          <p class="eyebrow">SATOYAMA AI BASE</p>
          <h1>${content.title}</h1>
          <p>${content.body}</p>
          ${retry}
        </section>
      </main>
    </div>
  `;
  container
    .querySelector<HTMLButtonElement>('[data-onboarding-retry]')
    ?.addEventListener('click', () => window.location.reload());
}

export async function mountSatoyamaOnboarding(
  container: HTMLElement,
): Promise<void> {
  const preview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('preview') === '1';
  prepareContainer(container);
  renderBootstrapState(container, 'connecting');
  if (!preview) {
    try {
      if (!(await initLiff())) {
        renderBootstrapState(container, 'login');
        return;
      }
    } catch {
      renderBootstrapState(container, 'error');
      return;
    }
  }

  container.replaceChildren();
  createRoot(container).render(
    <StrictMode>
      <SatoyamaOnboarding />
    </StrictMode>,
  );
}
