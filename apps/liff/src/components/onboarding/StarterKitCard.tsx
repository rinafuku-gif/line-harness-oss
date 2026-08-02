import { useRef, useState } from 'react';
import type { CommonBonus, IssueBonus } from '../../lib/onboarding-api.js';

interface StarterKitCardProps {
  bonus: CommonBonus;
  issueBonus: IssueBonus;
  onOpened: () => void;
}

export function StarterKitCard({
  bonus,
  issueBonus,
  onOpened,
}: StarterKitCardProps) {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const trackedOpen = useRef(false);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !trackedOpen.current) {
      trackedOpen.current = true;
      onOpened();
    }
  }

  async function copyPrompt(id: string, prompt: string) {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedId(id);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <section className="starter-kit-card" aria-labelledby="starter-kit-title">
      <p className="bonus-kicker">3問回答特典</p>
      <h2 id="starter-kit-title">{bonus.title}</h2>
      <p>{bonus.summary}</p>
      <button
        type="button"
        className="secondary-button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls="starter-kit-content"
      >
        {open ? 'スタートキットを閉じる' : '無料スタートキットを開く'}
      </button>

      {open ? (
        <div id="starter-kit-content" className="starter-kit-content">
          <section className="kit-section" aria-labelledby="issue-sheet-title">
            <p className="kit-number">01</p>
            <h3 id="issue-sheet-title">{issueBonus.title}</h3>
            <p>{issueBonus.summary}</p>
            <ol className="worksheet-list">
              {issueBonus.worksheet.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </section>

          <section className="kit-section" aria-labelledby="starter-plan-title">
            <p className="kit-number">02</p>
            <h3 id="starter-plan-title">30日で小さく試す進め方</h3>
            <ol className="starter-plan-list">
              {bonus.starterPlan.map((step) => (
                <li key={step.period}>
                  <span>{step.period}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.action}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="kit-section" aria-labelledby="usage-rules-title">
            <p className="kit-number">03</p>
            <h3 id="usage-rules-title">社内AI利用ルールのたたき台</h3>
            <dl className="usage-rule-list">
              {bonus.usageRules.map((rule) => (
                <div key={rule.label}>
                  <dt>{rule.label}</dt>
                  <dd>{rule.detail}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="kit-section" aria-labelledby="prompt-bonus-title">
            <p className="kit-number">BONUS</p>
            <h3 id="prompt-bonus-title">すぐ試せるAI指示文3つ</h3>
            <div className="template-list">
              {bonus.templates.map((template) => (
                <article key={template.id} className="template-card">
                  <h4>{template.title}</h4>
                  <p className="template-use">{template.useCase}</p>
                  <pre>{template.prompt}</pre>
                  <button
                    type="button"
                    className="copy-button"
                    onClick={() => void copyPrompt(template.id, template.prompt)}
                  >
                    {copiedId === template.id ? 'コピーしました' : 'AI指示文をコピー'}
                  </button>
                </article>
              ))}
            </div>
          </section>

          <p className="safety-note">{bonus.note}</p>
        </div>
      ) : null}
    </section>
  );
}
