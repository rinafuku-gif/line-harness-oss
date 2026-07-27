import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingOutcomeCard } from '../src/components/onboarding/OnboardingOutcomeCard.js';

const outcome = {
  issue: 'handoff' as const,
  role: 'internal_lead' as const,
  area: 'admin' as const,
  initialReply: '回答ありがとうございます。',
  areaExample: '事務・管理業務の例です。',
  nextStep: '1つの仕事を選ぶ',
  deliveryThemes: ['聞き取り', '手順書', '試行'],
  cta: {
    label: 'AIと手順を整理する',
    message: '手順を整理したいです。',
  },
  issueBonus: {
    version: 'test-v1',
    issue: 'handoff' as const,
    title: '引き継ぎ1枚テンプレート',
    summary: '引き継ぎを整理する型です。',
    worksheet: ['作業名と目的'],
  },
};

describe('SATOYAMA onboarding outcome copy', () => {
  it('describes copy fallback and avoids the internal term 適合確認', () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingOutcomeCard, {
        outcome,
        sending: false,
        actionMessage: null,
        onSendToChat: vi.fn(),
        onIssueBonusOpened: vi.fn(),
        onRestart: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('LINEトークへ送るか、コピーします');
    expect(html).toContain('無料相談の予約は自動では始まりません');
    expect(html).not.toContain('適合確認');
  });
});
