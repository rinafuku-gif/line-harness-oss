import { useRef, useState } from 'react';
import type { IssueBonus } from '../../lib/onboarding-api.js';

interface IssueBonusCardProps {
  bonus: IssueBonus;
  onOpened: () => void;
}

export function IssueBonusCard({ bonus, onOpened }: IssueBonusCardProps) {
  const [open, setOpen] = useState(false);
  const trackedOpen = useRef(false);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !trackedOpen.current) {
      trackedOpen.current = true;
      onOpened();
    }
  }

  return (
    <section className="issue-bonus-card" aria-labelledby="issue-bonus-title">
      <p className="bonus-kicker">回答後の追加シート</p>
      <h2 id="issue-bonus-title">{bonus.title}</h2>
      <p>{bonus.summary}</p>
      <button
        type="button"
        className="secondary-button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls="issue-bonus-content"
      >
        {open ? 'シートを閉じる' : '追加シートを見る'}
      </button>
      {open ? (
        <ol id="issue-bonus-content" className="worksheet-list">
          {bonus.worksheet.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
