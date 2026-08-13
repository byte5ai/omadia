'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError, emitConductorEvent, type ConductorEmitResult } from '@/app/_lib/api';

/**
 * "Emit a domain event" test bench — split out of conductor/page.tsx to keep
 * the page within the repo's 500-line rule. Owns the form + result state; the
 * page's shared double-fire guard rides along via `guardAction` so one intent
 * still never triggers two actions across run/respond/emit.
 */
export function ConductorEmitSection({
  guardAction,
  onEmitted,
}: {
  /** the page's shared double-fired-click swallower: false = drop this click. */
  guardAction: () => boolean;
  /** refetch the page's lists after a successful emit. */
  onEmitted: () => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const [eventId, setEventId] = useState('github.pull_request.merged');
  const [eventPayload, setEventPayload] = useState('{ "base": "main" }');
  const [emitting, setEmitting] = useState(false);
  const [emitResult, setEmitResult] = useState<ConductorEmitResult | null>(null);
  const [emitError, setEmitError] = useState<string | null>(null);

  const handleEmit = useCallback(async () => {
    if (!guardAction()) return;
    setEmitting(true);
    setEmitError(null);
    setEmitResult(null);
    let payload: unknown;
    try {
      payload = eventPayload.trim() ? JSON.parse(eventPayload) : {};
    } catch {
      setEmitError('Payload is not valid JSON');
      setEmitting(false);
      return;
    }
    try {
      const res = await emitConductorEvent(eventId, payload);
      setEmitResult(res);
      onEmitted();
    } catch (err) {
      setEmitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setEmitting(false);
    }
  }, [guardAction, eventId, eventPayload, onEmitted]);

  const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
        {t('emitHeading')}
      </h2>
      <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('emitHint')}</p>
      <div className={`${card} grid gap-3`}>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
            {t('eventIdLabel')}
            <input
              className="w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-[14px] text-[color:var(--fg-strong)]"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
            {t('payloadLabel')}
            <input
              className="w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 font-mono text-[12px] text-[color:var(--fg-strong)]"
              value={eventPayload}
              onChange={(e) => setEventPayload(e.target.value)}
            />
          </label>
          <Button variant="primary" busy={emitting} disabled={emitting} onClick={() => void handleEmit()}>
            {t('emitButton')}
          </Button>
        </div>
        {emitError && <p className="text-[14px] text-[color:var(--danger)]">{emitError}</p>}
        {emitResult && (
          <p className="text-[13px] text-[color:var(--fg-muted)]">
            {t('emitResult', { matched: emitResult.matchedWorkflows, started: emitResult.startedRuns.length })}
          </p>
        )}
      </div>
    </section>
  );
}
