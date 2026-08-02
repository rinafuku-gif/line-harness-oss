import type { OnboardingQuestion } from '../../lib/onboarding-api.js';

interface QuestionStepProps {
  question: OnboardingQuestion;
  current: number;
  total: number;
  selectedCode?: string;
  disabled: boolean;
  onSelect: (code: string) => void;
  onBack: () => void;
}

export function QuestionStep({
  question,
  current,
  total,
  selectedCode,
  disabled,
  onSelect,
  onBack,
}: QuestionStepProps) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card question-card" aria-labelledby="question-title">
        <div className="progress-row">
          <button
            className="text-button"
            type="button"
            onClick={onBack}
            disabled={disabled}
          >
            戻る
          </button>
          <span aria-live="polite">
            {current} / {total}
          </span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={current}
          aria-label="質問の進捗"
        >
          <span style={{ width: `${(current / total) * 100}%` }} />
        </div>
        <p className="eyebrow">3つの質問</p>
        <h1 id="question-title">{question.title}</h1>
        <p className="question-help">{question.help}</p>
        <div className="option-list">
          {question.options.map((option) => (
            <button
              key={option.code}
              type="button"
              className={`option-button${selectedCode === option.code ? ' selected' : ''}`}
              onClick={() => onSelect(option.code)}
              disabled={disabled}
              aria-pressed={selectedCode === option.code}
            >
              <span>{option.label}</span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
        {disabled ? (
          <p className="submitting-message" aria-live="polite">
            回答を保存しています…
          </p>
        ) : null}
      </section>
    </main>
  );
}
