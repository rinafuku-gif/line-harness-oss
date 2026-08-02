import type {
  CommonBonus,
  OnboardingOutcome,
} from '../../lib/onboarding-api.js';
import { StarterKitCard } from './StarterKitCard.js';

interface OnboardingOutcomeCardProps {
  outcome: OnboardingOutcome;
  commonBonus: CommonBonus;
  sending: boolean;
  actionMessage: string | null;
  onSendToChat: () => void;
  onStarterKitOpened: () => void;
  onRestart: () => void;
  onClose: () => void;
}

export function OnboardingOutcomeCard({
  outcome,
  commonBonus,
  sending,
  actionMessage,
  onSendToChat,
  onStarterKitOpened,
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

        <StarterKitCard
          bonus={commonBonus}
          issueBonus={outcome.issueBonus}
          onOpened={onStarterKitOpened}
        />

        <section className="consultation-action" aria-labelledby="consultation-action-title">
          <h2 id="consultation-action-title">一緒に整理したい場合</h2>
          <p>
            回答内容をもとに、LINEトークで相談文を送れます。
            送信や予約が自動で始まることはありません。
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={onSendToChat}
            disabled={sending}
          >
            {sending ? '準備しています…' : outcome.cta.label}
          </button>
          <p className="cta-note">
            このボタンを押した時だけ、上の相談文をLINEトークへ送るか、コピーします。
          </p>
          {actionMessage ? (
            <p className="action-message" role="status">
              {actionMessage}
            </p>
          ) : null}
        </section>

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
