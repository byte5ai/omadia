'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import type {
  ConductorMissingCapability,
  ConductorPersonCandidate,
  ConductorPersonSuggestion,
} from '@/app/_lib/api';

// Cards rendered under a builder reply. Both PROPOSE and hand off to an explicit
// click (parity with the template-proposal cards): a missing connector opens the
// inline MCP connect modal; a person candidate is written into the step only when
// the operator picks it — a unique match is pre-selected, never auto-applied.

export function MissingCapabilityCards({
  items,
  resolved,
  onConnect,
  onChange,
  onReset,
  disabled = false,
}: {
  items: ConductorMissingCapability[];
  /** stepId → actionId already connected in this session (card shows the result). */
  resolved: Record<string, string>;
  onConnect: (item: ConductorMissingCapability) => void;
  /** Re-open the modal at the connected server's tool list to pick another tool. */
  onChange: (item: ConductorMissingCapability) => void;
  /** Put the step back to the ref the builder wrote. */
  onReset: (item: ConductorMissingCapability) => void;
  /** true while a builder turn is in flight — picks would be overwritten by the reply. */
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  return (
    <div className="mt-2 grid gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{t('chatMissingHeading')}</div>
      {items.map((item) => {
        const done = resolved[item.stepId];
        return (
          <div
            key={`${item.stepId}:${item.ref}`}
            data-testid="missing-capability-card"
            className="grid gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 px-3 py-2"
          >
            <p className="text-[12px] text-[color:var(--fg-muted)]">
              {item.kind === 'action' ? t('chatMissingAction') : t('chatMissingAgent')}{' '}
              <span className="font-mono text-[11px] text-[color:var(--fg-strong)]">{item.ref}</span>
            </p>
            {done ? (
              <div className="grid gap-1">
                <p className="text-[12px] text-[color:var(--fg-strong)]">
                  {t('chatMissingConnected', { stepId: item.stepId })}{' '}
                  <span className="font-mono text-[11px]">{done}</span>
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onChange(item)}>
                    {t('chatMissingChange')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onReset(item)}>
                    {t('chatMissingReset')}
                  </Button>
                </div>
              </div>
            ) : item.kind === 'action' ? (
              <div>
                <Button variant="primary" size="sm" disabled={disabled} onClick={() => onConnect(item)}>
                  {t('chatMissingConnect')}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A unique candidate is pre-selected visually; writing it still takes the click. */
function isPreselected(s: ConductorPersonSuggestion, c: ConductorPersonCandidate): boolean {
  return s.candidates.length === 1 && !s.partial && c.displayName.trim().toLowerCase() === s.query.trim().toLowerCase();
}

export function PersonSuggestionCards({
  items,
  applied,
  onPick,
  disabled = false,
}: {
  items: ConductorPersonSuggestion[];
  disabled?: boolean;
  /** stepId → candidate the operator picked in this session. */
  applied: Record<string, ConductorPersonCandidate>;
  onPick: (stepId: string, candidate: ConductorPersonCandidate | null) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  return (
    <div className="mt-2 grid gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{t('chatPeopleHeading')}</div>
      {items.map((s) => {
        const chosen = applied[s.stepId];
        return (
          <div
            key={s.stepId}
            data-testid="person-suggestion-card"
            className="grid gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 px-3 py-2"
          >
            <p className="text-[12px] text-[color:var(--fg-muted)]">{t('chatPersonQuery', { query: s.query, stepId: s.stepId })}</p>
            {chosen ? (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--fg-strong)]">
                <span>{t('chatPersonApplied', { name: chosen.displayName })}</span>
                <span className="font-mono text-[11px] text-[color:var(--fg-muted)]">{chosen.email ?? chosen.principalRef}</span>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onPick(s.stepId, null)}>
                  {t('chatPersonChange')}
                </Button>
              </div>
            ) : s.candidates.length === 0 ? (
              <p className="text-[12px] text-[color:var(--fg-muted)]">{t('chatPersonNone')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {s.candidates.map((c) => (
                  <Button
                    key={`${c.channelType}:${c.principalRef}`}
                    variant={isPreselected(s, c) ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={disabled}
                    onClick={() => onPick(s.stepId, c)}
                  >
                    {c.displayName}
                    {c.hint ? <span className="ml-1 text-[10px] opacity-70">{c.hint}</span> : null}
                    <span className="ml-1 font-mono text-[10px] opacity-70">{c.email ?? c.principalRef}</span>
                    <span className="ml-1 rounded bg-black/20 px-1 text-[9px] uppercase">{c.channelType}</span>
                  </Button>
                ))}
              </div>
            )}
            {s.partial && <p className="text-[11px] text-[color:var(--fg-muted)]">{t('chatPersonPartial')}</p>}
          </div>
        );
      })}
    </div>
  );
}
