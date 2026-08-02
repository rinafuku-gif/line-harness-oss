import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StarterKitTeaser } from '../src/components/onboarding/StarterKitTeaser.js';
import { StarterKitCard } from '../src/components/onboarding/StarterKitCard.js';
import { onboardingPreviewPayload } from '../src/dev/onboarding-preview.js';

describe('SATOYAMA onboarding starter kit visibility', () => {
  it('shows only the benefit summary before the questions', () => {
    const html = renderToStaticMarkup(<StarterKitTeaser />);

    expect(html).toContain('3問回答後の無料特典');
    expect(html).toContain('回答が終わると、この画面で開けます');
    expect(html).not.toContain('AI指示文をコピー');
    expect(html).not.toContain('1週目');
  });

  it('unlocks the complete kit only on the completed outcome screen', () => {
    const payload = onboardingPreviewPayload();
    const outcome = payload.outcome;
    if (!outcome) throw new Error('preview outcome missing');

    const html = renderToStaticMarkup(
      <StarterKitCard
        bonus={payload.program.commonBonus}
        issueBonus={outcome.issueBonus}
        onOpened={() => undefined}
      />,
    );

    expect(html).toContain('3問回答特典');
    expect(html).toContain('無料スタートキットを開く');
    expect(html).not.toContain('友だち追加特典・検証版');
  });
});
