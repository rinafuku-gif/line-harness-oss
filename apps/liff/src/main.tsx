import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { initLiff } from './lib/liff-auth.js';
import './index.css';

(async () => {
  try {
    const preview =
      import.meta.env.DEV &&
      window.location.pathname === '/onboarding/satoyama' &&
      new URLSearchParams(window.location.search).get('preview') === '1';
    if (!preview) await initLiff();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    );
  } catch (err) {
    const root = document.getElementById('root')!;
    const container = document.createElement('div');
    const heading = document.createElement('h1');
    const message = document.createElement('p');
    container.style.cssText = 'padding: 2rem; font-family: sans-serif; color: #b91c1c;';
    heading.style.cssText = 'font-size: 1.25rem; margin-bottom: 1rem;';
    heading.textContent = '起動できませんでした';
    message.textContent = err instanceof Error ? err.message : String(err);
    container.append(heading, message);
    root.replaceChildren(container);
  }
})();
