'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  type DirectoryListResponse,
  type DirectoryPerson,
  type DirectoryPersonDetail,
  getDirectoryPerson,
  listDirectory,
  revokeDirectoryConnection,
  syncDirectory,
  unlinkDirectoryIdentity,
} from '../../_lib/api';

type Formatter = ReturnType<typeof useFormatter>;
type StatusFilter = 'all' | 'active' | 'deprovisioned';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: DirectoryListResponse }
  | { kind: 'error' };

/**
 * ADR-0300 — the colleagues of the Entra tenant (not accounts): sync state,
 * the people list, and per person their linked channel accounts and MCP
 * connections, which an operator can remove.
 */
export default function AdminDirectoryPage(): React.ReactElement {
  const t = useTranslations('adminDirectory');
  const format = useFormatter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const data = await listDirectory({
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(status !== 'all' ? { status } : {}),
      });
      setState({ kind: 'ready', data });
    } catch {
      setState({ kind: 'error' });
    }
  }, [search, status]);

  useEffect(() => {
    // Fetch-on-mount and on filter change: state is set only after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  async function handleSync(tenantId: string): Promise<void> {
    setActionError(null);
    try {
      await syncDirectory(tenantId);
      await reload();
    } catch {
      setActionError(t('errors.sync'));
    }
  }

  return (
    <main className="mx-auto max-w-[1080px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">{t('intro')}</p>
      </header>

      {actionError && <p className="mb-4 text-sm text-[color:var(--danger)]">{actionError}</p>}

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">{t('errors.load')}</p>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('sources.heading')}
            </h2>
            {state.data.sources.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('sources.none')}</p>
            ) : (
              <ul className="space-y-2">
                {state.data.sources.map((s) => (
                  <li
                    key={`${s.source}:${s.tenantId}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color:var(--border)] px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-medium text-[color:var(--fg-strong)]">
                        {t('sources.tenant', { tenantId: s.tenantId })}
                      </div>
                      <div className="text-xs text-[color:var(--fg-muted)]">
                        {s.running
                          ? t('sources.running')
                          : s.lastCompletedAt
                            ? t('sources.lastSync', { at: formatDate(s.lastCompletedAt, format) })
                            : t('sources.neverSynced')}
                      </div>
                      {s.lastError && (
                        <div className="text-xs text-[color:var(--danger)]">
                          {t('sources.lastError', { error: s.lastError })}
                        </div>
                      )}
                      {!s.registered && (
                        <div className="text-xs text-[color:var(--warning)]">{t('sources.notRegistered')}</div>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      disabled={!s.registered || s.running}
                      onClick={() => void handleSync(s.tenantId)}
                    >
                      {t('sources.syncNow')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('filters.search')}</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('filters.searchPlaceholder')}
                  className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('filters.status')}</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as StatusFilter)}
                  className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm"
                >
                  <option value="all">{t('filters.all')}</option>
                  <option value="active">{t('status.active')}</option>
                  <option value="deprovisioned">{t('status.deprovisioned')}</option>
                </select>
              </label>
              <span className="pb-2 text-xs text-[color:var(--fg-muted)]">
                {t('total', { count: state.data.total })}
              </span>
            </div>
            {state.data.people.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
            ) : (
              <ul className="divide-y divide-[color:var(--border)]/50 rounded-lg border border-[color:var(--border)]">
                {state.data.people.map((p) => (
                  <PersonRow
                    key={p.id}
                    person={p}
                    open={openId === p.id}
                    onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                    format={format}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

interface PersonRowProps {
  person: DirectoryPerson;
  open: boolean;
  onToggle: () => void;
  format: Formatter;
}

function PersonRow({ person, open, onToggle, format }: PersonRowProps): React.ReactElement {
  const t = useTranslations('adminDirectory');
  return (
    <li className="px-4 py-3 text-sm">
      {/* eslint-disable-next-line no-restricted-syntax -- a disclosure row toggle, not a §4.2 action */}
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full flex-wrap items-center justify-between gap-3 text-left">
        <span>
          <span className="block font-medium text-[color:var(--fg-strong)]">
            {person.displayName || person.upn || person.objectId}
          </span>
          <span className="block text-xs text-[color:var(--fg-muted)]">{person.mail ?? person.upn ?? person.objectId}</span>
        </span>
        <span
          className={[
            'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
            person.status === 'active'
              ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
              : 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
          ].join(' ')}
        >
          {t(`status.${person.status}`)}
        </span>
      </button>
      {open && <PersonDetail id={person.id} format={format} />}
    </li>
  );
}

function PersonDetail({ id, format }: { id: string; format: Formatter }): React.ReactElement {
  const t = useTranslations('adminDirectory');
  const [detail, setDetail] = useState<DirectoryPersonDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await getDirectoryPerson(id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function act(run: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await run();
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <p className="mt-3 text-xs text-[color:var(--danger)]">{t('errors.detail')}</p>;
  if (!detail) return <p className="mt-3 text-xs opacity-70">{t('loading')}</p>;
  const { person } = detail;
  return (
    <div className="mt-3 space-y-3 rounded-md bg-[color:var(--card)]/40 p-3 text-xs">
      <p className="text-[color:var(--fg-muted)]">
        {t('detail.synced', { at: formatDate(person.syncedAt, format) })}
        {person.deprovisionedAt ? ` · ${t('detail.deprovisioned', { at: formatDate(person.deprovisionedAt, format) })}` : ''}
      </p>
      <p>{detail.webLogin ? t('detail.webLogin', { email: detail.webLogin.email }) : t('detail.noWebLogin')}</p>
      <div>
        <h3 className="mb-1 font-medium">{t('detail.linkedHeading')}</h3>
        {detail.linkedIdentities.length === 0 ? (
          <p className="text-[color:var(--fg-muted)]">{t('detail.noLinks')}</p>
        ) : (
          <ul className="space-y-1">
            {detail.linkedIdentities.map((identity) => (
              <li key={`${identity.channelType}:${identity.channelUserId}`} className="flex items-center justify-between gap-3">
                <span>{t('detail.identity', { channel: identity.channelType, id: identity.channelUserId })}</span>
                <Button variant="secondary" disabled={busy} onClick={() => void act(() => unlinkDirectoryIdentity(id, identity))}>
                  {t('detail.unlink')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-1 font-medium">{t('detail.connectionsHeading')}</h3>
        {detail.connections.length === 0 ? (
          <p className="text-[color:var(--fg-muted)]">{t('detail.noConnections')}</p>
        ) : (
          <ul className="space-y-1">
            {detail.connections.map((c) => (
              <li key={c.serverId} className="flex items-center justify-between gap-3">
                <span>{c.serverName}</span>
                <Button variant="secondary" disabled={busy} onClick={() => void act(() => revokeDirectoryConnection(id, c.serverId))}>
                  {t('detail.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {person.status === 'deprovisioned' && <p className="text-[color:var(--fg-muted)]">{t('detail.purgeHint')}</p>}
    </div>
  );
}

function formatDate(iso: string, format: Formatter): string {
  try {
    return format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
