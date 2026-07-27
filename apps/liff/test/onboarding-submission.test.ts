import { describe, expect, it, vi } from 'vitest';
import {
  onboardingSubmissionErrorMessage,
  preparePendingSubmission,
  retainPendingSubmissionForAnswers,
} from '../src/lib/onboarding-submission.js';

const answers = {
  issue: 'handoff',
  role: 'internal_lead',
  area: 'admin',
};

describe('SATOYAMA onboarding submission state', () => {
  it('reuses one idempotency key for a simple retry with the same answers', () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce('first-key')
      .mockReturnValueOnce('second-key');
    const first = preparePendingSubmission(null, answers, createKey);
    const retry = preparePendingSubmission(first, { ...answers }, createKey);

    expect(first.idempotencyKey).toBe('first-key');
    expect(retry).toBe(first);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('drops the pending key as soon as one selected answer changes', () => {
    const pending = preparePendingSubmission(null, answers, () => 'first-key');
    const retained = retainPendingSubmissionForAnswers(pending, {
      ...answers,
      issue: 'automation',
    });
    const changed = preparePendingSubmission(
      retained,
      { ...answers, issue: 'automation' },
      () => 'second-key',
    );

    expect(retained).toBeNull();
    expect(changed.idempotencyKey).toBe('second-key');
  });

  it('uses nontechnical guidance for a 429 response', () => {
    expect(onboardingSubmissionErrorMessage(429)).toBe(
      '回答が続けて送信されました。少し時間をおいて再度お試しください。',
    );
    expect(onboardingSubmissionErrorMessage(429)).not.toMatch(/429|rate|limit/i);
  });
});
