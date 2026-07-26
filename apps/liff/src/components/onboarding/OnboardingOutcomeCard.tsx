import type { OnboardingOutcome } from '../../lib/onboarding-api.js';
import { IssueBonusCard } from './IssueBonusCard.js';

interface OnboardingOutcomeCardProps {
  outcome: OnboardingOutcome;
  sending: boolean;
  actionMessage: string | null;
  onSendToChat: () => void;
  onIssueBonusOpened: () => void;
  onRestart: () => void;
  onClose: () => void;
}

export function OnboardingOutcomeCard({
  outcome,
  sending,
  actionMessage,
  onSendToChat,
  onIssueBonusOpened,
  onRestart,
  onClose,
}: OnboardingOutcomeCardProps) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card outcome-card" aria-labelledby="outcome-title">
        <p className="eyebrow">回答ありがとうございます</p>
        <h1 id="outcome-title">最初は、1つの仕事だけ整理しましょう</h1>
        <p className="outcome-lead">{outcome.initialReply}</p>
        <p>{outcome.areaExample}</p>

        <div className="next-step-box">
          <span>最初の一歩</span>
          <strong>{outcome.nextStep}</strong>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={onSendToChat}
          disabled={sending}
        >
          {sending ? '準備しています…' : outcome.cta.label}
        </button>
        <p className="cta-note">
          このボタンを押した時だけ、上の内容をLINEトークへ送ります。初回適合確認の予約は自動では始まりません。
        </p>
        {actionMessage ? (
          <p className="action-message" role="status">
            {actionMessage}
          </p>
        ) : null}

        <IssueBonusCard
          bonus={outcome.issueBonus}
          onOpened={onIssueBonusOpened}
        />

        <div className="footer-actions">
          <button type="button" className="text-button" onClick={onRestart}>
            回答を見直す
          </button>
          <button type="button" className="text-button" onClick={onClose}>
            LINEへ戻る
          </button>
        </div>
      </section>
    </main>
  );
}
