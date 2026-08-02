import { getIdToken, getLiffId } from './liff-auth.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';
export const ONBOARDING_REQUEST_TIMEOUT_MS = 10_000;

export type IssueCode =
  | 'key_person'
  | 'handoff'
  | 'unsure_start'
  | 'safe_rules'
  | 'automation';
export type RoleCode = 'owner' | 'internal_lead' | 'frontline' | 'supporter_solo';
export type AreaCode = 'admin' | 'sales' | 'hiring_training' | 'content' | 'undecided';

export interface OnboardingOption<T extends string> {
  code: T;
  label: string;
}

export interface OnboardingQuestion {
  id: 'issue' | 'role' | 'area';
  title: string;
  help: string;
  options: readonly OnboardingOption<string>[];
}

export interface WorkTemplate {
  id: string;
  title: string;
  useCase: string;
  prompt: string;
}

export interface StarterPlanStep {
  period: string;
  title: string;
  action: string;
}

export interface UsageRule {
  label: string;
  detail: string;
}

export interface CommonBonus {
  version: string;
  title: string;
  summary: string;
  note: string;
  starterPlan: readonly StarterPlanStep[];
  usageRules: readonly UsageRule[];
  templates: readonly WorkTemplate[];
}

export interface IssueBonus {
  version: string;
  issue: IssueCode;
  title: string;
  summary: string;
  worksheet: readonly string[];
}

export interface OnboardingOutcome {
  issue: IssueCode;
  role: RoleCode;
  area: AreaCode;
  initialReply: string;
  areaExample: string;
  nextStep: string;
  deliveryThemes: readonly string[];
  cta: {
    label: string;
    message: string;
  };
  issueBonus: IssueBonus;
}

export interface OnboardingState {
  status: 'pending' | 'started' | 'completed' | 'skipped';
  answers: {
    issue: IssueCode;
    role: RoleCode;
    area: AreaCode;
  } | null;
  commonBonusOpened: boolean;
  questionsStarted: boolean;
  issueBonusOpened: boolean;
  ctaClicked: boolean;
  reminderAttempted: boolean;
  completedAt: string | null;
}

export interface OnboardingProgram {
  key: string;
  version: number;
  title: string;
  intro: string;
  questions: readonly OnboardingQuestion[];
  commonBonus: CommonBonus;
}

export interface OnboardingPayload {
  program: OnboardingProgram;
  state: OnboardingState | null;
  outcome: OnboardingOutcome | null;
}

export class OnboardingApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'OnboardingApiError';
  }
}

function endpoint(path = ''): URL {
  const url = new URL(
    `${BASE}/api/liff/onboarding/satoyama${path}`,
    window.location.origin,
  );
  url.searchParams.set('liffId', getLiffId());
  return url;
}

async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OnboardingApiError(0, 'request_timeout'));
    }, ONBOARDING_REQUEST_TIMEOUT_MS);
  });
  const operation = (async () => {
    const response = await fetch(endpoint(path), {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${getIdToken()}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const payload = (await response.json().catch(() => null)) as
      | { success?: boolean; error?: string; data?: T }
      | null;
    if (!response.ok || !payload?.success || payload.data === undefined) {
      throw new OnboardingApiError(
        response.status,
        payload?.error ?? 'request_failed',
      );
    }
    return payload.data;
  })();

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof OnboardingApiError)) {
      throw new OnboardingApiError(0, 'request_timeout');
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const onboardingApi = {
  get: () => request<OnboardingPayload>(),
  markCommonBonusOpened: () =>
    post<{ state: OnboardingState | null }>('/bonus/common/opened'),
  markQuestionsStarted: () =>
    post<{ state: OnboardingState | null }>('/questions/started'),
  submit: (input: {
    issue: IssueCode;
    role: RoleCode;
    area: AreaCode;
    idempotencyKey: string;
  }) =>
    post<{
      state: OnboardingState;
      outcome: OnboardingOutcome;
      idempotentReplay: boolean;
    }>('/submit', input),
  skip: () => post<{ state: OnboardingState }>('/skip'),
  markIssueBonusOpened: () =>
    post<{ state: OnboardingState | null }>('/bonus/issue/opened'),
  markCtaClicked: () =>
    post<{ state: OnboardingState | null }>('/cta/clicked'),
};
