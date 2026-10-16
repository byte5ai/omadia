'use client';

import { useEffect, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  type AdminAuditListResponse,
  ApiError,
  type AuditEntryDto,
  listAdminAudit,
} from '../../_lib/api';

/**
 * Admin → Audit log (#1315). Read-only, newest first, offset-paged.
 *
 * The middleware filters `action` by exact match or by a prefix ending in
 * `.`; the dropdown only offers prefixes. Filter values are machine data
 * (they match the server's action names), the labels come from the catalog.
 */

const AUDIT_PAGE_SIZE = 50;

/** i18n key → action prefix sent to the server (`''` = no filter). */
const ACTION_FILTERS = [
  { key: 'all', prefix: '' },
  { key: 'user', prefix: 'user.' },
  { key: 'auth', prefix: 'auth.' },
  { key: 'plugin', prefix: 'plugin.' },
  { key: 'apikey', prefix: 'api_key.' },
  { key: 'memory', prefix: 'memory.' },
  { key: 'conductor', prefix: 'conductor.' },
  { key: 'profileSnapshot', prefix: 'profile_snapshot.' },
  { key: 'channel', prefix: 'channel.' },
] as const;

type Formatter = ReturnType<typeof useFormatter>;
type TFn = ReturnType<typeof useTranslations>;

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; page: AdminAuditListResponse }
  | { kind: 'error'; error: unknown };

export default function AdminAuditPage(): React.ReactElement {
  const t = useTranslations('adminAudit');
  const format = useFormatter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');

  useEffect(() => {
    let cancelled = false;
    // Fetch-on-change: state is touched only after the awaited round-trip.
    void (async () => {
      try {
        const page = await listAdminAudit({
          limit: AUDIT_PAGE_SIZE,
          offset,
          ...(action.length > 0 ? { action } : {}),
        });
        if (!cancelled) setState({ kind: 'ready', page });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offset, action]);

  function goTo(nextOffset: number): void {
    setState({ kind: 'loading' });
    setOffset(Math.max(0, nextOffset));
  }

  function changeFilter(next: string): void {
    setState({ kind: 'loading' });
    setAction(next);
    setOffset(0);
  }

  const page = state.kind === 'ready' ? state.page : null;
  const hasNewer = offset > 0;
  const hasOlder = page?.has_more ?? false;

  return (
    <main className="mx-auto max-w-[1080px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('filter.label')}</span>
          <select
            value={action}
            onChange={(e) => changeFilter(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          >
            {ACTION_FILTERS.map((f) => (
              <option key={f.key} value={f.prefix}>
                {t(`filter.options.${f.key}`)}
              </option>
            ))}
          </select>
        </label>
        <Pager
          t={t}
          offset={offset}
          count={page?.entries.length ?? 0}
          hasNewer={hasNewer}
          hasOlder={hasOlder}
          onNewer={() => goTo(offset - AUDIT_PAGE_SIZE)}
          onOlder={() => goTo(offset + AUDIT_PAGE_SIZE)}
        />
      </div>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p
          role="alert"
          className="rounded-md border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/5 px-3 py-2 text-sm text-[color:var(--danger)]"
        >
          {toFriendlyError(state.error, t)}
        </p>
      ) : state.page.entries.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">
          {action.length > 0 || offset > 0 ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <AuditTable entries={state.page.entries} t={t} format={format} />
      )}
    </main>
  );
}

function Pager({
  t,
  offset,
  count,
  hasNewer,
  hasOlder,
  onNewer,
  onOlder,
}: {
  t: TFn;
  offset: number;
  count: number;
  hasNewer: boolean;
  hasOlder: boolean;
  onNewer: () => void;
  onOlder: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      {count > 0 && (
        <span className="text-xs text-[color:var(--fg-muted)]">
          {t('paging.range', { from: offset + 1, to: offset + count })}
        </span>
      )}
      <Button variant="secondary" size="sm" disabled={!hasNewer} onClick={onNewer}>
        {t('paging.newer')}
      </Button>
      <Button variant="secondary" size="sm" disabled={!hasOlder} onClick={onOlder}>
        {t('paging.older')}
      </Button>
    </div>
  );
}

function AuditTable({
  entries,
  t,
  format,
}: {
  entries: AuditEntryDto[];
  t: TFn;
  format: Formatter;
}): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-[color:var(--border)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[color:var(--card)]/40 text-[12px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          <tr>
            <th className="px-4 py-3">{t('table.time')}</th>
            <th className="px-4 py-3">{t('table.actor')}</th>
            <th className="px-4 py-3">{t('table.action')}</th>
            <th className="px-4 py-3">{t('table.target')}</th>
            <th className="px-4 py-3">{t('table.changes')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-t border-[color:var(--border)]/50 align-top">
              <td className="whitespace-nowrap px-4 py-3 text-xs text-[color:var(--fg-muted)]">
                {formatDate(entry.created_at, format)}
              </td>
              <td className="px-4 py-3">{actorLabel(entry, t)}</td>
              <td className="px-4 py-3">
                <span className="type-mono-data text-xs">{entry.action}</span>
              </td>
              <td className="px-4 py-3">
                <span className="type-mono-data break-all text-xs text-[color:var(--fg-muted)]">
                  {entry.target}
                </span>
              </td>
              <td className="px-4 py-3">
                <details>
                  <summary className="cursor-pointer text-xs text-[color:var(--accent)]">
                    {t('details.show')}
                  </summary>
                  <div className="mt-2 grid gap-2">
                    <JsonBlock label={t('details.before')} value={entry.before} t={t} />
                    <JsonBlock label={t('details.after')} value={entry.after} t={t} />
                  </div>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonBlock({
  label,
  value,
  t,
}: {
  label: string;
  value: unknown;
  t: TFn;
}): React.ReactElement {
  const pretty = prettyJson(value);
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
        {label}
      </div>
      {pretty === null ? (
        <div className="text-xs text-[color:var(--fg-muted)]">{t('details.empty')}</div>
      ) : (
        <pre className="max-h-64 max-w-[28rem] overflow-auto rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 p-2 text-[11px] leading-[1.45]">
          {pretty}
        </pre>
      )}
    </div>
  );
}

/** Email when known, else the raw actor id; both null = system action. */
function actorLabel(entry: AuditEntryDto, t: TFn): React.ReactNode {
  if (entry.actor_email !== null) return entry.actor_email;
  if (entry.actor_id !== null) {
    return <span className="type-mono-data text-xs">{entry.actor_id}</span>;
  }
  return <span className="italic text-[color:var(--fg-muted)]">{t('actorSystem')}</span>;
}

/** Pretty-printed JSON, or null for an absent value (nothing to show). */
function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2) ?? null;
  } catch {
    return String(value);
  }
}

function formatDate(iso: string, format: Formatter): string {
  try {
    return format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
}

function toFriendlyError(err: unknown, t: TFn): string {
  if (err instanceof ApiError) {
    if (err.code === 'admin_audit.invalid_query') return t('errors.invalidQuery');
    return t('errors.generic', { status: err.status });
  }
  return t('errors.network');
}
