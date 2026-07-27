import { describe, expect, it } from 'vitest';
import {
  SATOYAMA_FOLLOWUP_RESULT_URL,
  SATOYAMA_FOLLOWUP_SCENARIOS,
  SATOYAMA_FOLLOWUP_SCENARIO_IDS,
  SATOYAMA_PRICING_URL,
} from './followup-content.js';

describe('SATOYAMA answer follow-up content', () => {
  it('defines one three-step stream for each of the five issue answers', () => {
    expect(Object.keys(SATOYAMA_FOLLOWUP_SCENARIOS)).toHaveLength(5);
    expect(new Set(SATOYAMA_FOLLOWUP_SCENARIO_IDS).size).toBe(5);

    for (const scenario of Object.values(SATOYAMA_FOLLOWUP_SCENARIOS)) {
      expect(scenario.steps).toHaveLength(3);
      expect(scenario.steps.map((step) => step.offsetDays)).toEqual([1, 3, 7]);
      expect(scenario.steps.every((step) => step.deliveryTime === '10:00')).toBe(true);
      expect(scenario.steps[1].message).toContain(SATOYAMA_FOLLOWUP_RESULT_URL);
      expect(scenario.steps[2].message).toContain(SATOYAMA_PRICING_URL);
    }
  });

  it('does not reuse the stopped individual-school scenario language or old host', () => {
    const allMessages = Object.values(SATOYAMA_FOLLOWUP_SCENARIOS)
      .flatMap((scenario) => scenario.steps)
      .map((step) => step.message)
      .join('\n');

    expect(allMessages).not.toMatch(/ひとり経営の相棒|5問・1分|月額の会員/);
    expect(allMessages).not.toContain('satoyama-ai-base.vercel.app');
  });
});
