'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import { ApiError, listRetiredTurns, unretireTurn, type RetiredTurn } from '../../../_lib/api';

/**
 * Reasons an operator may lift. `no_person_owner` and `hygiene` would only be
 * retired again by the next run, so they get no button.
 */
const ALLOWABLE_REASONS: ReadonlySet<string> = new Set(['memory_deleted', 'discretion']);

/** Codes the un-retire route answers with; others fall back to `failed`. */
const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  'bulk.unretire_not_found',
  'bulk.unretire_no_person_owner',
  'bulk.unretire_unsupported',
  'audit_write_failed',
]);

function errorKey(err: unknown): string {
  if (err instanceof ApiError && err.code !== null && KNOWN_ERRORS.has(err.code)) {
    return err.code.replace(/\./g, '_');
  }
  return 'failed';
}

/**
 * #2295 — turns retired from promotion (ADR-0190) and the operator's way
 * back: "allow again" drops the mark, so the next bulk run may promote the
 * turn. Ids and reasons only; the turn's text is never shown here.
 */
export function RetiredTurns(): React.ReactElement {
  const t = useTranslations('adminBulkPromote.retired');
  const format = useFormatter();
  const [turns, setTurns] = useState<RetiredTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setTurns(await listRetiredTurns());
      setError(null);
    } catch (err) {
      setError(t(`errors.${errorKey(err)}`));
    }
  }, [t]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const allow = useCallback(
    async (turnId: string): Promise<void> => {
      setBusy(turnId);
      try {
        await unretireTurn(turnId);
        setTurns((prev) => (prev ?? []).filter((r) => r.turnId !== turnId));
        setError(null);
      } catch (err) {
        setError(t(`errors.${errorKey(err)}`));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  return (
    <section className="mt-8 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <h2 className="mb-1 text-lg font-medium">{t('title')}</h2>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>
      {error && (
        <div role="alert" className="mb-3 text-sm text-[color:var(--danger)]">
          {error}
        </div>
      )}
      {turns === null && !error && <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>}
      {turns !== null && turns.length === 0 && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      )}
      {turns !== null && turns.length > 0 && (
        <ul className="flex flex-col gap-2">
          {turns.map((r) => (
            <li
              key={r.turnId}
              className="flex flex-wrap items-center gap-3 rounded border border-[color:var(--border)]/60 p-2 text-sm"
            >
              <span className="font-mono text-xs">{r.turnId}</span>
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('reason', { reason: r.reason })}
                {r.agentSlug ? ` · ${r.agentSlug}` : ''}
                {r.retiredAt ? ` · ${format.dateTime(new Date(r.retiredAt), { dateStyle: 'medium' })}` : ''}
              </span>
              {ALLOWABLE_REASONS.has(r.reason) && (
                <Button
                  size="sm"
                  busy={busy === r.turnId}
                  busyLabel={t('allowing')}
                  disabled={busy !== null}
                  onClick={() => void allow(r.turnId)}
                  aria-label={t('allowAria', { turnId: r.turnId })}
                >
                  {t('allow')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
