import { describe, expect, it } from 'vitest';
import {
  AREA_OPTIONS,
  COMMON_BONUS,
  ISSUE_BONUSES,
  ISSUE_OPTIONS,
  ROLE_OPTIONS,
  SATOYAMA_ONBOARDING_TAGS,
  buildSatoyamaOnboardingOutcome,
} from './content.js';

describe('SATOYAMA onboarding content', () => {
  it('contains 14 independent tags across the three axes', () => {
    expect(SATOYAMA_ONBOARDING_TAGS).toHaveLength(14);
    expect(SATOYAMA_ONBOARDING_TAGS.filter((tag) => tag.axis === 'role')).toHaveLength(4);
    expect(SATOYAMA_ONBOARDING_TAGS.filter((tag) => tag.axis === 'issue')).toHaveLength(5);
    expect(SATOYAMA_ONBOARDING_TAGS.filter((tag) => tag.axis === 'area')).toHaveLength(5);
    expect(new Set(SATOYAMA_ONBOARDING_TAGS.map((tag) => tag.name)).size).toBe(14);
    expect(SATOYAMA_ONBOARDING_TAGS.every((tag) => tag.name.startsWith('[SB]'))).toBe(true);
  });

  it('resolves all 5 issue x 4 role combinations and varies area examples', () => {
    const outcomes = ISSUE_OPTIONS.flatMap((issue) =>
      ROLE_OPTIONS.map((role) =>
        buildSatoyamaOnboardingOutcome(issue.code, role.code, 'admin'),
      ),
    );
    expect(outcomes).toHaveLength(20);
    for (const outcome of outcomes) {
      expect(outcome.initialReply.length).toBeGreaterThan(40);
      expect(outcome.nextStep.length).toBeGreaterThan(5);
      expect(outcome.deliveryThemes).toHaveLength(3);
      expect(outcome.cta.label.length).toBeGreaterThan(4);
      expect(outcome.cta.message).not.toMatch(/無料相談|予約/);
      expect(outcome.issueBonus.issue).toBe(outcome.issue);
    }

    const examples = AREA_OPTIONS.map((area) =>
      buildSatoyamaOnboardingOutcome('handoff', 'internal_lead', area.code).areaExample,
    );
    expect(new Set(examples).size).toBe(5);
  });

  it('keeps bonus content versioned and free from unsupported results claims', () => {
    expect(COMMON_BONUS.version).toMatch(/^common-/);
    expect(COMMON_BONUS.starterPlan).toHaveLength(4);
    expect(COMMON_BONUS.usageRules).toHaveLength(3);
    expect(COMMON_BONUS.templates).toHaveLength(3);
    expect(COMMON_BONUS.note).toMatch(/個人情報|顧客|APIキー/);
    expect(Object.keys(ISSUE_BONUSES)).toEqual(ISSUE_OPTIONS.map((option) => option.code));
    const allText = JSON.stringify({ common: COMMON_BONUS, issues: ISSUE_BONUSES });
    expect(allText).not.toMatch(/必ず成果|売上.*倍|成功実績|導入実績/);
  });
});
