'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  FIELD_CLASSIFICATION_STATUSES,
  type FieldBulkBatch,
  type FieldBulkFilter,
  type FieldBulkItem,
  type FieldBulkResult,
  type FieldBulkUndoResult,
  type FieldClassificationAction,
  type FieldClassificationItem,
  type FieldClassificationList,
  type FieldClassificationStatus,
  decideFieldClassification,
  getLatestFieldBulk,
  listFieldClassifications,
  recomputeFieldClassifications,
} from '../../../_lib/api';
import { serverErrorMessage } from '../../../_lib/apiErrorMessage';
import { BulkAcceptDialog, BulkResultSummary, UndoBulk, UndoResultSummary } from './BulkAccept';
import { type CardNotice, ErrorLine, FieldCard, LEGACY_VIEW_HREF } from './FieldCard';
import { formatWhen } from './fieldText';

/**
 * `/admin/privacy-fields` (#1556 follow-up) — suggestions for the Privacy
 * Guard's `non_personal_fields`. Fields the guard can prove non-personal are
 * auto-approved (`auto_approved`, revertible); every other field stays masked
 * until an admin confirms it — one by one or in bulk ("Accept suggestions",
 * undoable as the latest bulk action).
 * The filter lives in the URL (`?status=`, `?tool=`) so the banner and nav
 * badge can deep-link into it.
 */

export const PRIVACY_FIELDS_PATH = '/admin/privacy-fields';

export function privacyFieldsHref(status: FieldClassificationStatus, tool: string | null): string {
  const params = new URLSearchParams({ status });
  if (tool) params.set('tool', tool);
  return `${PRIVACY_FIELDS_PATH}?${params.toString()}`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: FieldClassificationList }
  | { kind: 'error'; detail: string | null };

interface ItemNotice {
  itemId: string;
  notice: CardNotice;
}

/** `entry` from a 409 body (`covered_by_legacy`, `legacy_entry_not_found`). */
export function conflictEntry(err: ApiError): string {
  try {
    const body = JSON.parse(err.body) as { entry?: unknown } | null;
    return typeof body?.entry === 'string' ? body.entry : '';
  } catch {
    return '';
  }
}

/** Items grouped by tool, tools in codepoint order (stable on server + client). */
function groupByTool(items: readonly FieldClassificationItem[]): [string, FieldClassificationItem[]][] {
  const groups = new Map<string, FieldClassificationItem[]>();
  for (const item of items) {
    groups.set(item.toolName, [...(groups.get(item.toolName) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function fetchList(
  status: FieldClassificationStatus,
  tool: string | null,
): Promise<LoadState> {
  try {
    const data = await listFieldClassifications({ status, ...(tool ? { tool } : {}) });
    return { kind: 'ready', data };
  } catch (err) {
    return { kind: 'error', detail: serverErrorMessage(err) };
  }
}

export function PrivacyFieldsView({
  status,
  tool,
}: {
  status: FieldClassificationStatus;
  tool: string | null;
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const format = useFormatter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<{ itemId: string; action: FieldClassificationAction } | null>(
    null,
  );
  const [notice, setNotice] = useState<ItemNotice | null>(null);
  const [bulkFilter, setBulkFilter] = useState<FieldBulkFilter | null>(null);
  const [bulkResult, setBulkResult] = useState<
    { result: FieldBulkResult; items: readonly FieldBulkItem[] } | null
  >(null);
  const [undoResult, setUndoResult] = useState<FieldBulkUndoResult | null>(null);
  const [latestBatch, setLatestBatch] = useState<FieldBulkBatch | null>(null);
  const [recompute, setRecompute] = useState<
    { kind: 'idle' } | { kind: 'running' } | { kind: 'done' } | { kind: 'error'; detail: string | null }
  >({ kind: 'idle' });

  const load = useCallback(
    async (): Promise<void> => setState(await fetchList(status, tool)),
    [status, tool],
  );

  // The undo offer is optional: a failed read just hides it.
  const loadLatest = useCallback(async (): Promise<void> => {
    setLatestBatch(await getLatestFieldBulk().catch(() => null));
  }, []);

  // The page remounts this view (keyed on the filter) when the URL changes.
  useEffect(() => {
    let cancelled = false;
    // Fetch-on-mount: state is touched only after the awaited round-trip.
    void (async () => {
      const [next, latest] = await Promise.all([
        fetchList(status, tool),
        getLatestFieldBulk().catch(() => null),
      ]);
      if (cancelled) return;
      setState(next);
      setLatestBatch(latest);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, tool]);

  const decide = async (
    item: FieldClassificationItem,
    action: FieldClassificationAction,
  ): Promise<void> => {
    setBusy({ itemId: item.id, action });
    setNotice(null);
    try {
      await decideFieldClassification(item.id, action, item.fingerprint);
      setNotice({ itemId: item.id, notice: { kind: 'saved', entry: item.configEntry } });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'covered_by_legacy') {
        setNotice({ itemId: item.id, notice: { kind: 'legacy', entry: conflictEntry(err) } });
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'invalid_field') {
        setNotice({ itemId: item.id, notice: { kind: 'invalid' } });
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // Stale fingerprint, or the candidate is gone: show the current state.
        setNotice({ itemId: item.id, notice: { kind: err.status === 404 ? 'gone' : 'stale' } });
        await load();
      } else {
        setNotice({
          itemId: item.id,
          notice: { kind: 'error', detail: serverErrorMessage(err) },
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const openBulk = (filter: FieldBulkFilter): void => {
    setBulkResult(null);
    setUndoResult(null);
    setBulkFilter(filter);
  };

  const bulkDone = async (result: FieldBulkResult, items: readonly FieldBulkItem[]): Promise<void> => {
    setBulkFilter(null);
    setBulkResult({ result, items });
    await Promise.all([load(), loadLatest()]);
  };

  const undone = async (result: FieldBulkUndoResult): Promise<void> => {
    setBulkResult(null);
    setUndoResult(result);
    await Promise.all([load(), loadLatest()]);
  };

  const runRecompute = async (): Promise<void> => {
    setRecompute({ kind: 'running' });
    try {
      await recomputeFieldClassifications();
      await load();
      setRecompute({ kind: 'done' });
    } catch (err) {
      setRecompute({ kind: 'error', detail: serverErrorMessage(err) });
    }
  };

  const data = state.kind === 'ready' ? state.data : null;
  const groups = useMemo(() => groupByTool(data?.items ?? []), [data]);
  const lastComputed = formatWhen(data?.computedAt, format);
  const suggestedCount = data?.counts.suggested ?? 0;
  // A notice whose item left this tab (e.g. confirmed → `confirmed`) shows on top.
  const orphanNotice =
    notice !== null && !(data?.items ?? []).some((i) => i.id === notice.itemId) ? notice : null;

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-6">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-[color:var(--fg-muted)]" data-testid="last-computed">
          {lastComputed !== null ? t('lastComputed', { when: lastComputed }) : t('neverComputed')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {latestBatch !== null ? (
            <UndoBulk batch={latestBatch} onUndone={(r) => void undone(r)} />
          ) : null}
          <Button
            size="sm"
            variant="primary"
            data-testid="bulk-accept"
            disabled={suggestedCount === 0}
            onClick={() => openBulk({ status: 'suggested', ...(tool ? { tool } : {}) })}
          >
            {t('bulk.acceptSuggestions')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            busy={recompute.kind === 'running'}
            busyLabel={t('recomputing')}
            onClick={() => void runRecompute()}
          >
            {t('recompute')}
          </Button>
        </div>
      </div>
      {bulkResult !== null ? <BulkResultSummary result={bulkResult.result} items={bulkResult.items} /> : null}
      {undoResult !== null ? <UndoResultSummary result={undoResult} /> : null}
      {bulkFilter !== null ? (
        <BulkAcceptDialog
          filter={bulkFilter}
          onCancel={() => setBulkFilter(null)}
          onDone={(r, items) => void bulkDone(r, items)}
        />
      ) : null}
      {recompute.kind === 'done' ? (
        <p role="status" className="mb-4 text-[13px] text-[color:var(--accent)]">
          {t('recomputeDone')}
        </p>
      ) : recompute.kind === 'error' ? (
        <ErrorLine message={t('errors.recompute')} detail={recompute.detail} />
      ) : null}

      <nav aria-label={t('tabsLabel')} className="mb-6 flex flex-wrap gap-2">
        {FIELD_CLASSIFICATION_STATUSES.map((s) => {
          const active = s === status;
          return (
            <Link
              key={s}
              href={privacyFieldsHref(s, tool)}
              aria-current={active ? 'page' : undefined}
              data-testid={`tab-${s}`}
              className={[
                'rounded-full border px-3 py-1 text-[13px] transition-colors',
                active
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--fg-strong)]'
                  : 'border-[color:var(--border)] text-[color:var(--fg-muted)] hover:border-[color:var(--accent)]',
              ].join(' ')}
            >
              {t(`status.${s}`)}
              {data !== null ? (
                <span className="ml-1.5 font-semibold">{format.number(data.counts[s] ?? 0)}</span>
              ) : null}
            </Link>
          );
        })}
        <Link
          href={LEGACY_VIEW_HREF}
          data-testid="tab-legacy"
          className="rounded-full border border-dashed border-[color:var(--border)] px-3 py-1 text-[13px] text-[color:var(--fg-muted)] transition-colors hover:border-[color:var(--accent)]"
        >
          {t('legacy.tab')}
        </Link>
      </nav>

      {tool ? (
        <p className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
          <span className="font-mono">{t('toolFilter', { tool })}</span>
          <Link href={privacyFieldsHref(status, null)} className="text-[color:var(--accent)] hover:underline">
            {t('clearToolFilter')}
          </Link>
        </p>
      ) : null}

      {orphanNotice !== null ? <OrphanNotice notice={orphanNotice.notice} /> : null}

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <ErrorLine message={t('errors.load')} detail={state.detail} />
      ) : groups.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(([toolName, items]) => (
            <section key={toolName} data-testid={`tool-${toolName}`}>
              <h2 className="mb-3 flex items-baseline gap-3">
                {tool ? (
                  <span className="font-mono text-[15px] font-semibold text-[color:var(--fg-strong)]">
                    {toolName}
                  </span>
                ) : (
                  <Link
                    href={privacyFieldsHref(status, toolName)}
                    className="font-mono text-[15px] font-semibold text-[color:var(--fg-strong)] hover:underline"
                  >
                    {toolName}
                  </Link>
                )}
                <span className="text-xs text-[color:var(--fg-muted)]">
                  {t('fieldCount', { count: items.length })}
                </span>
                {status === 'suggested' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    data-testid={`bulk-accept-group-${toolName}`}
                    aria-label={t('bulk.acceptGroupLabel', { tool: toolName })}
                    onClick={() => openBulk({ status: 'suggested', tool: toolName })}
                  >
                    {t('bulk.acceptGroup')}
                  </Button>
                ) : null}
              </h2>
              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <FieldCard
                    key={item.id}
                    item={item}
                    busyAction={busy?.itemId === item.id ? busy.action : null}
                    notice={notice?.itemId === item.id ? notice.notice : null}
                    onDecide={(i, a) => void decide(i, a)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function OrphanNotice({ notice }: { notice: CardNotice }): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  switch (notice.kind) {
    case 'saved':
      return (
        <p role="status" className="mb-4 text-[13px] text-[color:var(--accent)]">
          {t('saved', { entry: notice.entry })}
        </p>
      );
    case 'stale':
      return <ErrorLine message={t('errors.stale')} detail={null} />;
    case 'gone':
      return <ErrorLine message={t('errors.notFound')} detail={null} />;
    case 'legacy':
      return <ErrorLine message={t('errors.coveredByLegacy', { entry: notice.entry })} detail={null} />;
    case 'invalid':
      return <ErrorLine message={t('errors.invalidField')} detail={null} />;
    case 'error':
      return <ErrorLine message={t('errors.decision')} detail={notice.detail} />;
  }
}
