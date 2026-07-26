import { useRef, useState } from 'react';
import type { CommonBonus } from '../../lib/onboarding-api.js';

interface BonusTemplatesProps {
  bonus: CommonBonus;
  onOpened: () => void;
}

export function BonusTemplates({ bonus, onOpened }: BonusTemplatesProps) {
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
    <section className="bonus-card" aria-labelledby="common-bonus-title">
      <p className="bonus-kicker">友だち追加特典・検証版</p>
      <h2 id="common-bonus-title">{bonus.title}</h2>
      <p>{bonus.summary}</p>
      <button
        type="button"
        className="secondary-button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls="common-bonus-content"
      >
        {open ? 'テンプレートを閉じる' : '3つのテンプレートを見る'}
      </button>
      {open ? (
        <div id="common-bonus-content" className="template-list">
          {bonus.templates.map((template) => (
            <article key={template.id} className="template-card">
              <h3>{template.title}</h3>
              <p className="template-use">{template.useCase}</p>
              <pre>{template.prompt}</pre>
              <button
                type="button"
                className="copy-button"
                onClick={() => void copyPrompt(template.id, template.prompt)}
              >
                {copiedId === template.id ? 'コピーしました' : 'テンプレートをコピー'}
              </button>
            </article>
          ))}
          <p className="safety-note">{bonus.note}</p>
        </div>
      ) : null}
    </section>
  );
}
