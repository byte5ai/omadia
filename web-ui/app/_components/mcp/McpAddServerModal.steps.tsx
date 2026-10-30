'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '@/app/_lib/api';
import { Button } from '@/app/_components/ui/Button';
import {
  createMcpServer,
  importMcpServerFromRegistry,
  listMcpRegistries,
  searchMcpCatalog,
  type McpCatalogEntry,
  type McpRegistryInfo,
  type McpServerNode,
  type McpTransport,
  setMcpServerDelegation,
  listMcpServers,
} from '@/app/_lib/agentBuilder';

import { useMcpAddErrorText } from './McpAddServerModal.errors';

type FindTab = 'existing' | 'registry' | 'manual';

interface FindStepProps {
  initialQuery: string;
  onServerCreated: (server: McpServerNode) => void;
}

function useMountedRef(): React.MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

/** http/sse endpoints: absolute http(s) URL, or a `{placeholder}` template the config fills in. */
export function isAcceptableEndpoint(raw: string): boolean {
  const v = raw.trim();
  if (v.length === 0) return false;
  if (v.includes('{')) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function McpAddFindStep({ initialQuery, onServerCreated }: FindStepProps): React.ReactElement {
  const t = useTranslations('adminMcp');
  const errorText = useMcpAddErrorText();
  const mountedRef = useMountedRef();
  const [tab, setTab] = useState<FindTab>('registry');
  // Already configured servers (live finding 2026-10-30: operators do not want to re-create a
  // server for every missing tool). Becomes the default tab as soon as one exists.
  const [existing, setExisting] = useState<McpServerNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listMcpServers()
      .then(({ servers }) => {
        if (cancelled) return;
        setExisting(servers);
        if (servers.length > 0) setTab('existing');
      })
      .catch(() => {
        if (!cancelled) setExisting([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [registries, setRegistries] = useState<McpRegistryInfo[] | null>(null);
  const [registryId, setRegistryId] = useState('');
  const [query, setQuery] = useState(initialQuery);
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listMcpRegistries()
      .then(({ registries: found }) => {
        if (cancelled || !mountedRef.current) return;
        setRegistries(found);
        setRegistryId(found[0]?.id ?? '');
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled && mountedRef.current) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [errorText, mountedRef]);

  useEffect(() => {
    if (tab !== 'registry' || !registryId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchMcpCatalog(registryId, query.trim(), { signal: controller.signal })
        .then(({ entries: found }) => {
          if (!controller.signal.aborted && mountedRef.current) setEntries(found);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted && mountedRef.current) {
            setEntries(null);
            setError(errorText(err));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && mountedRef.current) setLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [errorText, mountedRef, query, registryId, tab]);

  const importEntry = useCallback(
    async (entry: McpCatalogEntry): Promise<void> => {
      if (!registryId || entry.transport === null) return;
      setBusyEntry(entry.id);
      setError(null);
      try {
        const server = await importMcpServerFromRegistry(registryId, entry.id);
        if (mountedRef.current) onServerCreated(server);
      } catch (err) {
        if (mountedRef.current) setError(errorText(err));
      } finally {
        if (mountedRef.current) setBusyEntry(null);
      }
    },
    [errorText, mountedRef, onServerCreated, registryId],
  );

  return (
    <div className="mt-4">
      <div role="tablist" aria-label={t('addModal.find.tabList')} className="flex gap-2 border-b border-[color:var(--border)] pb-2">
        {/* eslint-disable-next-line no-restricted-syntax -- semantic tab control */}
        <button type="button" role="tab" aria-selected={tab === 'existing'} data-testid="mcp-add-tab-existing" onClick={() => setTab('existing')} className={tab === 'existing' ? 'text-sm font-medium text-[color:var(--accent)]' : 'text-sm text-[color:var(--fg-muted)]'}>
          {t('addModal.find.existingTab', { count: existing?.length ?? 0 })}
        </button>
        {/* eslint-disable-next-line no-restricted-syntax -- tab control */}
        <button type="button" role="tab" aria-selected={tab === 'registry'} data-testid="mcp-add-tab-registry" onClick={() => setTab('registry')} className={tab === 'registry' ? 'text-sm font-medium text-[color:var(--accent)]' : 'text-sm text-[color:var(--fg-muted)]'}>
          {t('addModal.find.registryTab')}
        </button>
        {/* eslint-disable-next-line no-restricted-syntax -- semantic tab control */}
        <button type="button" role="tab" aria-selected={tab === 'manual'} data-testid="mcp-add-tab-manual" onClick={() => setTab('manual')} className={tab === 'manual' ? 'text-sm font-medium text-[color:var(--accent)]' : 'text-sm text-[color:var(--fg-muted)]'}>
          {t('addModal.find.manualTab')}
        </button>
      </div>
      {tab === 'existing' ? (
        <ExistingPane servers={existing} onPick={onServerCreated} onRegistry={() => setTab('registry')} />
      ) : tab === 'registry' ? (
        <RegistryPane registries={registries} registryId={registryId} query={query} entries={entries} loading={loading} error={error} busyEntry={busyEntry} onRegistryChange={(id) => { setRegistryId(id); setEntries(null); setError(null); }} onQueryChange={setQuery} onImport={importEntry} onManual={() => setTab('manual')} />
      ) : (
        <ManualPane error={error} setError={setError} onServerCreated={onServerCreated} mountedRef={mountedRef} />
      )}
    </div>
  );
}

interface RegistryPaneProps {
  registries: McpRegistryInfo[] | null;
  registryId: string;
  query: string;
  entries: McpCatalogEntry[] | null;
  loading: boolean;
  error: string | null;
  busyEntry: string | null;
  onRegistryChange: (id: string) => void;
  onQueryChange: (query: string) => void;
  onImport: (entry: McpCatalogEntry) => void;
  onManual: () => void;
}

function RegistryPane(props: RegistryPaneProps): React.ReactElement {
  const t = useTranslations('adminMcp');
  if (props.registries === null) {
    return <p className={props.error ? 'mt-4 text-sm text-[color:var(--danger)]' : 'mt-4 text-sm text-[color:var(--fg-muted)]'}>{props.error ?? t('addModal.find.loadingRegistries')}</p>;
  }
  if (props.registries.length === 0) {
    return <div className="mt-4 text-sm text-[color:var(--fg-muted)]"><p>{t('addModal.find.noRegistries')}</p><Button variant="ghost" size="sm" onClick={props.onManual}>{t('addModal.find.useManual')}</Button></div>;
  }
  return (
    <div className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-[color:var(--fg-muted)]">
        {t('addModal.find.registryLabel')}
        <select data-testid="mcp-add-registry-select" value={props.registryId} onChange={(e) => props.onRegistryChange(e.target.value)} className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-3 py-2 text-sm text-[color:var(--fg)]">
          {props.registries.map((registry) => <option key={registry.id} value={registry.id}>{registry.name}</option>)}
        </select>
      </label>
      <input type="search" data-testid="mcp-add-search" value={props.query} onChange={(e) => props.onQueryChange(e.target.value)} aria-label={t('addModal.find.searchLabel')} placeholder={t('addModal.find.searchPlaceholder')} className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]" />
      {props.loading ? <p className="text-sm text-[color:var(--fg-muted)]">{t('addModal.find.searching')}</p> : null}
      {props.error ? <p className="text-sm text-[color:var(--danger)]">{props.error}</p> : null}
      {!props.loading && !props.error && props.entries?.length === 0 ? <p className="text-sm text-[color:var(--fg-muted)]">{t('addModal.find.noEntries')}</p> : null}
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {(props.entries ?? []).map((entry) => <CatalogEntryRow key={entry.id} entry={entry} busy={props.busyEntry !== null} onImport={props.onImport} />)}
      </div>
    </div>
  );
}

function CatalogEntryRow({ entry, busy, onImport }: { entry: McpCatalogEntry; busy: boolean; onImport: (entry: McpCatalogEntry) => void }): React.ReactElement {
  const t = useTranslations('adminMcp');
  const disabled = entry.transport === null || busy;
  return (
    /* eslint-disable-next-line no-restricted-syntax -- catalog suggestion row */
    <button type="button" data-testid="mcp-add-entry" data-entry-id={entry.id} disabled={disabled} onClick={() => onImport(entry)} className="rounded-md border border-[color:var(--border)] p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 hover:border-[color:var(--accent)]">
      <span className="flex items-center gap-2"><span className="font-medium text-[color:var(--fg-strong)]">{entry.name}</span>{entry.transportDeprecated ? <span className="rounded-full border border-[color:var(--warning)] px-1.5 py-0.5 text-[10px] text-[color:var(--warning)]">{t('addModal.find.deprecated')}</span> : null}</span>
      <span className="mt-1 block text-xs text-[color:var(--fg-muted)]">{entry.description ?? t('addModal.find.noDescription')}</span>
      <span className="mt-1 block text-[11px] text-[color:var(--fg-muted)]">{entry.transport === null ? t('addModal.find.browseOnly') : t('addModal.find.transport', { transport: entry.transport })}</span>
    </button>
  );
}

interface ManualPaneProps {
  error: string | null;
  setError: (error: string | null) => void;
  onServerCreated: (server: McpServerNode) => void;
  mountedRef: React.MutableRefObject<boolean>;
}

function ExistingPane({ servers, onPick, onRegistry }: { servers: McpServerNode[] | null; onPick: (server: McpServerNode) => void; onRegistry: () => void }): React.ReactElement {
  const t = useTranslations('adminMcp');
  if (servers === null) return <p className="mt-4 text-sm text-[color:var(--fg-muted)]">{t('addModal.find.loadingExisting')}</p>;
  if (servers.length === 0) {
    return <div className="mt-4 flex flex-col gap-2"><p className="text-sm text-[color:var(--fg-muted)]">{t('addModal.find.noExisting')}</p><div><Button variant="secondary" size="sm" onClick={onRegistry}>{t('addModal.find.registryTab')}</Button></div></div>;
  }
  return <div data-testid="mcp-add-existing" className="mt-4 flex max-h-80 flex-col gap-2 overflow-y-auto">{servers.map((srv) => (
    /* eslint-disable-next-line no-restricted-syntax -- selectable server row */
    <button key={srv.id} type="button" data-testid="mcp-add-existing-server" data-server-id={srv.id} onClick={() => onPick(srv)} className="rounded-md border border-[color:var(--border)] p-3 text-left hover:border-[color:var(--accent)]">
      <span className="flex items-center gap-2"><span className="font-medium text-[color:var(--fg-strong)]">{srv.name}</span><span className="rounded-full border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] text-[color:var(--fg-muted)]">{srv.status === 'enabled' ? t('addModal.find.statusEnabled') : t('addModal.find.statusDisabled')}</span>{srv.delegation === 'service' ? <span className="rounded-full border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] text-[color:var(--fg-muted)]">{t('addModal.find.serviceBadge')}</span> : null}</span>
      <span className="mt-1 block text-xs text-[color:var(--fg-muted)]">{srv.endpoint ?? srv.transport} · {t('addModal.find.toolCount', { count: srv.discoveredTools.length })}</span>
    </button>
  ))}</div>;
}

function ManualPane({ error, setError, onServerCreated, mountedRef }: ManualPaneProps): React.ReactElement {
  const t = useTranslations('adminMcp');
  const errorText = useMcpAddErrorText();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('http');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  // A server with this name already exists (409 config_validation). The modal only creates, so
  // without this the operator is stuck: offer to continue with the existing row instead
  // (live finding 2026-10-30 — second attempt after a typo'd first server).
  const [existing, setExisting] = useState<McpServerNode | null>(null);
  async function continueWithExisting(): Promise<void> {
    if (existing) onServerCreated(existing);
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim() || busy) return;
    // Live finding 2026-10-30: `mcp.pleo.io` (no scheme) was accepted and discovery then hung on
    // an unreachable host. http/sse endpoints must be absolute URLs; `{placeholder}` templates
    // (resolved from config later) are the one legitimate non-URL shape, mirroring the server.
    if (transport !== 'stdio' && !isAcceptableEndpoint(endpoint)) {
      setError(t('addModal.manual.endpointInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const server = await createMcpServer({ name: name.trim(), transport, endpoint: endpoint.trim() || null });
      if (mountedRef.current) onServerCreated(server);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorText(err));
      if (err instanceof ApiError && err.status === 409) {
        const wanted = name.trim().toLowerCase();
        const match = (await listMcpServers().catch(() => ({ servers: [] }))).servers.find((srv) => srv.name.trim().toLowerCase() === wanted);
        if (mountedRef.current && match) setExisting(match);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-[color:var(--fg-muted)]">{t('addModal.manual.nameLabel')}<input data-testid="mcp-add-manual-name" value={name} onChange={(e) => setName(e.target.value)} required className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm" /></label>
      <label className="flex flex-col gap-1 text-xs text-[color:var(--fg-muted)]">{t('addModal.manual.transportLabel')}<select data-testid="mcp-add-manual-transport" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)} className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-3 py-2 text-sm"><option value="http">{t('addModal.manual.transportHttp')}</option><option value="sse">{t('addModal.manual.transportSse')}</option><option value="stdio">{t('addModal.manual.transportStdio')}</option></select></label>
      {transport === 'sse' ? <p className="text-xs text-[color:var(--fg-muted)]">{t('addModal.manual.sseDeprecated')}</p> : null}
      <label className="flex flex-col gap-1 text-xs text-[color:var(--fg-muted)]">{t('addModal.manual.endpointLabel')}<input data-testid="mcp-add-manual-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={t('addModal.manual.endpointPlaceholder')} className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm" /></label>
      {error ? <p className="text-sm text-[color:var(--danger)]">{error}</p> : null}
      {existing ? <div data-testid="mcp-add-use-existing" className="rounded-md border border-[color:var(--border)] p-3 text-sm"><p className="text-[color:var(--fg-muted)]">{t('addModal.manual.existingHint', { name: existing.name, endpoint: existing.endpoint ?? '—' })}</p><div className="mt-2"><Button variant="primary" size="sm" onClick={() => void continueWithExisting()}>{t('addModal.manual.useExisting')}</Button></div></div> : null}
      <div><Button type="submit" data-testid="mcp-add-manual-submit" size="sm" busy={busy} busyLabel={t('addModal.manual.creating')} disabled={!name.trim()}>{t('addModal.manual.create')}</Button></div>
    </form>
  );
}

export function McpAddPickStep({ server, missingTool, onPick, onClose, onServerChange }: { server: McpServerNode; missingTool: string; onPick: (toolName: string) => void; onClose: () => void; onServerChange: (server: McpServerNode) => void }): React.ReactElement {
  const t = useTranslations('adminMcp');
  const errorText = useMcpAddErrorText();
  const [delegationBusy, setDelegationBusy] = useState(false);
  const [delegationError, setDelegationError] = useState<string | null>(null);
  // A Conductor run has no acting user, so its MCP action steps only call servers under
  // SERVICE delegation. New servers default to per_user — picking a tool here would produce a
  // step that can never run, so the switch is an explicit, visible operator action.
  const serviceReady = server.delegation === 'service';
  const tools = [...server.discoveredTools].sort((a, b) => Number(b.name.toLowerCase() === missingTool) - Number(a.name.toLowerCase() === missingTool));
  if (tools.length === 0) {
    return <div className="mt-4"><p data-testid="mcp-add-empty-tools" className="text-sm text-[color:var(--fg-muted)]">{t('addModal.pick.empty')}</p><div className="mt-3"><Button variant="secondary" size="sm" onClick={onClose}>{t('addModal.close')}</Button></div></div>;
  }
  async function enableServiceDelegation(): Promise<void> {
    setDelegationBusy(true);
    setDelegationError(null);
    try {
      const res = await setMcpServerDelegation(server.id, 'service');
      onServerChange({ ...server, delegation: res.delegation });
    } catch (err) {
      setDelegationError(errorText(err));
    } finally {
      setDelegationBusy(false);
    }
  }
  return <div className="mt-4 flex flex-col gap-3">
    {!serviceReady ? <div data-testid="mcp-add-delegation" className="rounded-md border border-[color:var(--warning)]/50 p-3 text-sm">
      <p className="text-[color:var(--fg-muted)]">{t('addModal.pick.delegationNotice')}</p>
      <div className="mt-2"><Button variant="primary" size="sm" busy={delegationBusy} onClick={() => void enableServiceDelegation()}>{t('addModal.pick.delegationButton')}</Button></div>
      {delegationError ? <p className="mt-2 text-[color:var(--danger)]">{delegationError}</p> : null}
    </div> : null}
    <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">{tools.map((tool) => { const highlighted = tool.name.toLowerCase() === missingTool; return (
      /* eslint-disable-next-line no-restricted-syntax -- selectable tool suggestion row */
      <button key={tool.name} type="button" data-testid="mcp-add-tool" data-tool-name={tool.name} data-highlighted={highlighted ? 'true' : undefined} disabled={!serviceReady} onClick={() => onPick(tool.name)} className={(highlighted ? 'rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/8 p-3 text-left' : 'rounded-md border border-[color:var(--border)] p-3 text-left hover:border-[color:var(--accent)]') + (serviceReady ? '' : ' cursor-not-allowed opacity-50')}><span className="flex items-center gap-2"><span className="font-medium text-[color:var(--fg-strong)]">{tool.name}</span>{highlighted ? <span className="rounded-full bg-[color:var(--accent)] px-1.5 py-0.5 text-[10px] text-[color:var(--fg-on-dark)]">{t('addModal.pick.match')}</span> : null}</span><span className="mt-1 block text-xs text-[color:var(--fg-muted)]">{tool.description ?? t('addModal.pick.noDescription')}</span></button>
    ); })}</div>
  </div>;
}
