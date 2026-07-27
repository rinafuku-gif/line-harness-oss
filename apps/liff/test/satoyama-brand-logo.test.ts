import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SatoyamaBrandLogo } from '../src/components/onboarding/SatoyamaBrandLogo.js';

describe('SATOYAMA onboarding brand logo', () => {
  it('renders only the accessible official logo without a visible text duplicate', () => {
    const html = renderToStaticMarkup(createElement(SatoyamaBrandLogo));

    expect(html).toContain('<img');
    expect(html).toContain('class="brand-logo"');
    expect(html).toContain('alt="SATOYAMA AI BASE"');
    expect(html).toContain('width="512"');
    expect(html).toContain('height="512"');
    expect(html).not.toContain('>SATOYAMA AI BASE<');
  });
});
