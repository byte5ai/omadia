'use client';

import { useTranslations } from 'next-intl';

import type { CaptureDisclosure as CaptureDisclosureData } from '../../_lib/chatSessions';

interface CaptureDisclosureProps {
  disclosure: CaptureDisclosureData;
  className?: string;
}

type TFn = (key: string, values?: Record<string, string | number>) => string;

/**
 * Per-turn audit row showing what the orchestrator persisted into the
 * Palaia / knowledge-graph layer. Native `<details>` element — same
 * disclosure pattern as `<ToolTrace>` in the inline chat (`page.tsx`),
 * collapsed by default.
 *
 * Renders nothing extra when the capture-pipeline did nothing observable
 * (no persist, no strip, no hint, no significance). That keeps the chat
 * surface quiet for pass-through turns where the disclosure would just be
 * noise.
 */
export function CaptureDisclosure({
  disclosure,
  className,
}: CaptureDisclosureProps): React.ReactElement | null {
  const t = useTranslations('chat.captureDisclosure');
  const summary = summarise(disclosure, t);
  if (summary === null) return null;

  const facts = collectFacts(disclosure, t);

  return (
    <details
      className={[
        'mt-2 rounded bg-[color:var(--success)]/10 text-xs ring-1 ring-[color:var(--success)]',
        '',
        className ?? '',
      ].join(' ')}
    >
      <summary className="cursor-pointer select-none px-2 py-1 font-medium text-[color:var(--success)]">
        🧠 {t('heading')} · {summary}
      </summary>
      <div className="space-y-2 px-2 pb-2 pt-1 text-[color:var(--success)]">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {facts.map((fact) => (
            <div key={fact.title} className="contents">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--success)]/80">
                {fact.title}
              </dt>
              <dd className="font-mono-num tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>
        {disclosure.reasons.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--success)]/80">
              {t('reasonsHeading')}
            </div>
            <ul className="mt-1 space-y-0.5">
              {disclosure.reasons.map((reason, i) => (
                <li
                  key={`${reason}-${String(i)}`}
                  className="font-mono text-[11px] text-[color:var(--success)]/80"
                >
                  • {reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {disclosure.graphRefs && disclosure.graphRefs.entityNodeIds.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--success)]/80">
              {t('linkedEntities', {
                count: disclosure.graphRefs.entityNodeIds.length,
              })}
            </div>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
              {disclosure.graphRefs.entityNodeIds.map((id) => (
                <li
                  key={id}
                  className="font-mono text-[11px] text-[color:var(--success)]/80"
                >
                  • {id}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

interface Fact {
  title: string;
  value: string;
}

function summarise(d: CaptureDisclosureData, t: TFn): string | null {
  if (!d.persisted) {
    if (d.significance !== null) {
      return t('summaryDiscardedScore', { score: d.significance.toFixed(2) });
    }
    return t('summaryDiscarded');
  }
  const parts: string[] = [t('summaryPersisted')];
  if (d.entryType) parts.push(d.entryType);
  if (d.significance !== null) parts.push(d.significance.toFixed(2));
  if (d.privacyBlocksStripped > 0) {
    parts.push(t('summaryPrivateStripped', { count: d.privacyBlocksStripped }));
  }
  // Quiet fall-through: pre-OB-71 stub disclosures with no actionable data
  // (default-persist, no strip, no score) collapse to just "persistiert" —
  // we still render the row so the user knows the turn did land. Returning
  // null here would suppress the disclosure entirely and that's harder to
  // discover for an operator validating Track A.
  return parts.join(' · ');
}

function collectFacts(d: CaptureDisclosureData, t: TFn): Fact[] {
  const facts: Fact[] = [
    {
      title: t('factPersisted'),
      value: d.persisted ? t('factPersistedYes') : t('factPersistedNo'),
    },
  ];
  if (d.entryType) {
    facts.push({ title: t('factEntryType'), value: d.entryType });
  }
  if (d.visibility) {
    facts.push({ title: t('factVisibility'), value: d.visibility });
  }
  if (d.significance !== null) {
    facts.push({ title: 'Significance', value: d.significance.toFixed(2) });
  }
  facts.push({
    title: 'Embedding',
    value: d.embedded ? t('factEmbedded') : t('factNotEmbedded'),
  });
  if (d.privacyBlocksStripped > 0) {
    facts.push({
      title: t('factPrivateBlocks'),
      value: String(d.privacyBlocksStripped),
    });
  }
  if (d.hintTagsProcessed > 0) {
    facts.push({
      title: t('factHintTags'),
      value: String(d.hintTagsProcessed),
    });
  }
  return facts;
}
