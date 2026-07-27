import { useEffect, useRef, useState } from 'react';
import { BonusTemplates } from '../components/onboarding/BonusTemplates.js';
import { OnboardingOutcomeCard } from '../components/onboarding/OnboardingOutcomeCard.js';
import { QuestionStep } from '../components/onboarding/QuestionStep.js';
import { SatoyamaBrandLogo } from '../components/onboarding/SatoyamaBrandLogo.js';
import {
  OnboardingApiError,
  onboardingApi,
  type AreaCode,
  type IssueCode,
  type OnboardingOutcome,
  type OnboardingPayload,
  type RoleCode,
} from '../lib/onboarding-api.js';
import {
  onboardingSubmissionErrorMessage,
  preparePendingSubmission,
  retainPendingSubmissionForAnswers,
  type PendingOnboardingSubmission,
} from '../lib/onboarding-submission.js';
import { closeLiffWindow, sendTextToLineChat } from '../lib/liff-auth.js';
import '../styles/satoyama-onboarding.css';

type Screen = 'intro' | 'questions' | 'outcome' | 'skipped';

interface Answers {
  issue?: IssueCode;
  role?: RoleCode;
  area?: AreaCode;
}

const isPreview =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('preview') === '1';

function friendlyError(error: unknown): string {
  if (error instanceof OnboardingApiError) {
    if (error.code === 'request_timeout') {
      return 'LINEとの接続確認に時間がかかっています。通信状態を確認して、もう一度お試しください。';
    }
    if (error.code === 'not_following') {
      return 'LINE公式アカウントを友だち追加した状態で、もう一度開いてください。';
    }
    if (error.status === 401) {
      return 'LINEでの本人確認を完了できませんでした。LINEアプリから開き直してください。';
    }
    if (error.status === 503) {
      return 'ただいま本人確認を利用できません。時間をおいて、もう一度お試しください。';
    }
  }
  return '読み込みに失敗しました。通信状態を確認して、もう一度お試しください。';
}

export default function SatoyamaOnboarding() {
  const [payload, setPayload] = useState<OnboardingPayload | null>(null);
  const [outcome, setOutcome] = useState<OnboardingOutcome | null>(null);
  const [screen, setScreen] = useState<Screen>('intro');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pendingSubmission = useRef<PendingOnboardingSubmission | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'AI活用の3問整理 | SATOYAMA AI BASE';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = isPreview
          ? (await import('../dev/onboarding-preview.js')).onboardingPreviewPayload()
          : await onboardingApi.get();
        if (cancelled) return;
        setPayload(data);
        setOutcome(data.outcome);
        if (data.state?.answers) setAnswers(data.state.answers);

        const previewScreen = new URLSearchParams(window.location.search).get('screen');
        if (isPreview && previewScreen === 'outcome' && data.outcome) {
          setScreen('outcome');
        } else if (data.state?.status === 'completed' && data.outcome) {
          setScreen('outcome');
        } else if (data.state?.status === 'skipped') {
          setScreen('skipped');
        } else {
          setScreen('intro');
        }
      } catch (loadError) {
        if (!cancelled) setError(friendlyError(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function startQuestions() {
    setQuestionIndex(0);
    setError(null);
    setScreen('questions');
    if (!isPreview) {
      void onboardingApi.markQuestionsStarted().catch(() => undefined);
    }
  }

  function goBack() {
    setError(null);
    if (questionIndex === 0) {
      setScreen(outcome ? 'outcome' : 'intro');
      return;
    }
    setQuestionIndex((current) => current - 1);
  }

  async function submitAnswers(nextAnswers: Required<Answers>) {
    setSubmitting(true);
    setError(null);
    try {
      if (isPreview) {
        setOutcome(payload?.outcome ?? null);
        setScreen('outcome');
        pendingSubmission.current = null;
        return;
      }
      const submission = preparePendingSubmission(
        pendingSubmission.current,
        nextAnswers,
        () => window.crypto.randomUUID(),
      );
      pendingSubmission.current = submission;
      const result = await onboardingApi.submit({
        ...nextAnswers,
        idempotencyKey: submission.idempotencyKey,
      });
      setOutcome(result.outcome);
      setPayload((current) =>
        current
          ? {
              ...current,
              state: result.state,
              outcome: result.outcome,
            }
          : current,
      );
      setScreen('outcome');
      pendingSubmission.current = null;
    } catch (submitError) {
      setError(onboardingSubmissionErrorMessage(
        submitError instanceof OnboardingApiError ? submitError.status : undefined,
      ));
    } finally {
      setSubmitting(false);
    }
  }

  function selectAnswer(code: string) {
    if (!payload || submitting) return;
    const question = payload.program.questions[questionIndex];
    const next = { ...answers };
    if (question.id === 'issue') next.issue = code as IssueCode;
    if (question.id === 'role') next.role = code as RoleCode;
    if (question.id === 'area') next.area = code as AreaCode;
    pendingSubmission.current = retainPendingSubmissionForAnswers(
      pendingSubmission.current,
      next,
    );
    setAnswers(next);

    if (questionIndex < payload.program.questions.length - 1) {
      setQuestionIndex((current) => current + 1);
      return;
    }
    if (next.issue && next.role && next.area) {
      void submitAnswers(next as Required<Answers>);
    }
  }

  async function skipQuestions() {
    setSkipping(true);
    setError(null);
    try {
      if (!isPreview) {
        const result = await onboardingApi.skip();
        setPayload((current) =>
          current ? { ...current, state: result.state } : current,
        );
      }
      setScreen('skipped');
    } catch (skipError) {
      setError(friendlyError(skipError));
    } finally {
      setSkipping(false);
    }
  }

  async function sendOutcomeToChat() {
    if (!outcome) return;
    setSubmitting(true);
    setActionMessage(null);
    try {
      if (isPreview) {
        setActionMessage('プレビューではLINEトークへ送信しません。');
        return;
      }
      await onboardingApi.markCtaClicked().catch(() => undefined);
      const result = await sendTextToLineChat(outcome.cta.message);
      if (result === 'sent') {
        closeLiffWindow();
      } else if (result === 'copied') {
        setActionMessage(
          '相談文をコピーしました。LINEトークに貼り付けて送信してください。',
        );
      } else {
        setActionMessage(
          `次の相談文をLINEトークへ送ってください: ${outcome.cta.message}`,
        );
      }
    } catch {
      setActionMessage(
        'LINEトークへ送れませんでした。LINEアプリから開き直してください。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function trackCommonBonus() {
    if (!isPreview) {
      void onboardingApi.markCommonBonusOpened().catch(() => undefined);
    }
  }

  function trackIssueBonus() {
    if (!isPreview) {
      void onboardingApi.markIssueBonusOpened().catch(() => undefined);
    }
  }

  if (loading) {
    return (
      <div className="satoyama-onboarding-page">
        <main className="onboarding-shell">
          <section className="onboarding-card loading-card" aria-live="polite">
            <span className="loading-dot" aria-hidden="true" />
            読み込んでいます…
          </section>
        </main>
      </div>
    );
  }

  if (!payload || (error && !payload)) {
    return (
      <div className="satoyama-onboarding-page">
        <main className="onboarding-shell">
          <section className="onboarding-card error-card" role="alert">
            <SatoyamaBrandLogo />
            <h1>ページを開けませんでした</h1>
            <p>{error}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => setReloadKey((current) => current + 1)}
            >
              もう一度試す
            </button>
            <button type="button" className="text-button" onClick={closeLiffWindow}>
              LINEへ戻る
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (screen === 'questions') {
    const question = payload.program.questions[questionIndex];
    return (
      <div className="satoyama-onboarding-page">
        <QuestionStep
          question={question}
          current={questionIndex + 1}
          total={payload.program.questions.length}
          selectedCode={answers[question.id]}
          disabled={submitting}
          onSelect={selectAnswer}
          onBack={goBack}
        />
        {error ? (
          <p className="floating-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (screen === 'outcome' && outcome) {
    return (
      <div className="satoyama-onboarding-page">
        <OnboardingOutcomeCard
          outcome={outcome}
          sending={submitting}
          actionMessage={actionMessage}
          onSendToChat={() => void sendOutcomeToChat()}
          onIssueBonusOpened={trackIssueBonus}
          onRestart={startQuestions}
          onClose={closeLiffWindow}
        />
      </div>
    );
  }

  return (
    <div className="satoyama-onboarding-page">
      <main className="onboarding-shell">
        <section className="onboarding-card intro-card" aria-labelledby="intro-title">
          <SatoyamaBrandLogo />
          <h1 id="intro-title">{payload.program.title}</h1>
          <p className="intro-copy">{payload.program.intro}</p>
          <p className="privacy-note">
            選択内容とLINE上の識別子を、案内の個別化、相談受付、サービス改善のために保存します。
            回答しなくても、AI相談やリッチメニューは利用できます。詳しくは
            <a
              href="https://www.satoyama-ai-base.com/legal/privacy"
              target="_blank"
              rel="noreferrer"
            >
              プライバシーポリシー
            </a>
            をご確認ください。
          </p>

          {screen === 'skipped' ? (
            <p className="skip-confirmation" role="status">
              今回は回答しない設定にしました。必要になった時は、いつでもこのページから回答できます。
            </p>
          ) : null}

          <BonusTemplates
            bonus={payload.program.commonBonus}
            onOpened={trackCommonBonus}
          />

          <button type="button" className="primary-button" onClick={startQuestions}>
            3問に答える
          </button>
          <p className="time-note">目安25〜40秒・入力作業なし</p>
          <div className="footer-actions vertical">
            <button
              type="button"
              className="text-button"
              onClick={() => void skipQuestions()}
              disabled={skipping}
            >
              {skipping ? '保存しています…' : '今回は回答しない'}
            </button>
            <button type="button" className="text-button" onClick={closeLiffWindow}>
              LINEへ戻る
            </button>
          </div>
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
