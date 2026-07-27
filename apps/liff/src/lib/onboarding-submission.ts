export interface OnboardingSubmissionAnswers {
  issue?: string;
  role?: string;
  area?: string;
}

export interface PendingOnboardingSubmission {
  idempotencyKey: string;
  answersFingerprint: string;
}

function answersFingerprint(
  answers: OnboardingSubmissionAnswers,
): string | null {
  if (!answers.issue || !answers.role || !answers.area) return null;
  return [answers.issue, answers.role, answers.area].join('|');
}

export function retainPendingSubmissionForAnswers(
  pending: PendingOnboardingSubmission | null,
  answers: OnboardingSubmissionAnswers,
): PendingOnboardingSubmission | null {
  if (!pending) return null;
  return pending.answersFingerprint === answersFingerprint(answers)
    ? pending
    : null;
}

export function preparePendingSubmission(
  pending: PendingOnboardingSubmission | null,
  answers: Required<OnboardingSubmissionAnswers>,
  createIdempotencyKey: () => string,
): PendingOnboardingSubmission {
  const fingerprint = answersFingerprint(answers);
  if (!fingerprint) {
    throw new Error('satoyama_onboarding_incomplete_answers');
  }
  if (pending?.answersFingerprint === fingerprint) return pending;
  return {
    idempotencyKey: createIdempotencyKey(),
    answersFingerprint: fingerprint,
  };
}

export function onboardingSubmissionErrorMessage(status?: number): string {
  if (status === 429) {
    return '回答が続けて送信されました。少し時間をおいて再度お試しください。';
  }
  if (status === 409) {
    return '回答を更新できませんでした。ページを開き直して、もう一度お試しください。';
  }
  return '回答を保存できませんでした。選択内容は残っています。もう一度お試しください。';
}
