'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '../../_components/ConfirmDialog';
import { SkillVerdictBadge } from '../../_components/admin/SkillVerdictBadge';
import {
  ackMcpToolVerdict,
  createMcpServer,
  deleteGraphEdge,
  deleteMcpServer,
  discoverMcpTools,
  listMcpCallLog,
  listMcpGrants,
  listMcpServers,
  setMcpServerStatus,
  type McpCallLogEntry,
  type McpGrantMatrixRow,
  type McpServerNode,
  type McpTransport,
  type SkillVerdictSeverity,
} from '../../_lib/agentBuilder';

type Tab = 'servers' | 'grants' | 'audit';

/**
 * MCP Control Center v1 (epic #459 W2, issues #460/#461/#462): the standalone
 * management surface for MCP servers, discovered-tool verdicts, acks, the
 * read-only grant matrix, and the call audit log. The Builder canvas stays the
 * graph-wiring view; this page is where servers are operated.
 */
export default function AdminMcpPage(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [tab, setTab] = useState<Tab>('servers');
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">{t('title')}</h1>
      <p className="text-sm text-[color:var(--fg-muted)]">{t('intro')}</p>
      <div className="flex gap-2">
        {(['servers', 'grants', 'audit'] as const).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={tab === k ? 'primary' : 'ghost'}
            onClick={() => setTab(k)}
          >
            {t(`tabs.${k}`)}
          </Button>
        ))}
      </div>
      {tab === 'servers' ? <ServersPane /> : null}
      {tab === 'grants' ? <GrantsPane /> : null}
      {tab === 'audit' ? <AuditPane /> : null}
    </div>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const thCls =
  'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--fg-muted)]';
const tdCls = 'px-2 py-1.5 text-sm align-top';

// ── Servers ──────────────────────────────────────────────────────────────────

function worstSeverityOf(server: McpServerNode): SkillVerdictSeverity {
  const rank: Record<string, number> = {
    no_signals: 0,
    pending: 1,
    scan_failed: 2,
    too_large_to_scan: 3,
    flagged: 4,
    high_risk: 5,
  };
  let worst: SkillVerdictSeverity = 'no_signals';
  for (const tool of server.discoveredTools) {
    const s = tool.verdict?.severity ?? 'no_signals';
    if ((rank[s] ?? 0) > (rank[worst] ?? 0)) worst = s;
  }
  return worst;
}

function ServersPane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [servers, setServers] = useState<McpServerNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServerNode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('http');
  const [endpoint, setEndpoint] = useState('');

  const refresh = useCallback(async () => {
    try {
      setServers((await listMcpServers()).servers);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-[color:var(--border)] p-3">
        <label className="flex flex-col gap-1 text-xs">
          {t('servers.name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t('servers.transport')}
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as McpTransport)}
            className="rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
          >
            <option value="http">http</option>
            <option value="sse">sse</option>
            <option value="stdio">stdio</option>
          </select>
        </label>
        <label className="flex grow flex-col gap-1 text-xs">
          {t('servers.endpoint')}
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
          />
        </label>
        <Button
          size="sm"
          busy={busy === 'create'}
          onClick={() =>
            void act('create', async () => {
              await createMcpServer({ name: name.trim(), transport, endpoint: endpoint.trim() || null });
              setName('');
              setEndpoint('');
            })
          }
        >
          {t('servers.add')}
        </Button>
      </div>

      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {!servers ? <div className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</div> : null}

      {servers && servers.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('servers.empty')}</div>
      ) : null}

      {servers && servers.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[color:var(--border)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[color:var(--border)]">
                <th className={thCls}>{t('servers.name')}</th>
                <th className={thCls}>{t('servers.transport')}</th>
                <th className={thCls}>{t('servers.status')}</th>
                <th className={thCls}>{t('servers.tools')}</th>
                <th className={thCls}>{t('servers.worstVerdict')}</th>
                <th className={thCls}>{t('servers.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => (
                <ServerRows
                  key={s.id}
                  server={s}
                  expanded={expanded === s.id}
                  onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                  busy={busy}
                  onDiscover={() => void act(`discover:${s.id}`, () => discoverMcpTools(s.id))}
                  onToggleStatus={() =>
                    void act(`status:${s.id}`, () =>
                      setMcpServerStatus(s.id, s.status === 'enabled' ? 'disabled' : 'enabled'),
                    )
                  }
                  onDelete={() => setConfirmDelete(s)}
                  onAcked={() => void refresh()}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('servers.deleteTitle')}
        body={confirmDelete ? t('servers.deleteBody', { name: confirmDelete.name }) : undefined}
        confirmLabel={t('servers.deleteConfirm')}
        cancelLabel={t('cancel')}
        tone="danger"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (target) void act(`delete:${target.id}`, () => deleteMcpServer(target.id));
        }}
      />
    </div>
  );
}

function ServerRows({
  server,
  expanded,
  onToggle,
  busy,
  onDiscover,
  onToggleStatus,
  onDelete,
  onAcked,
}: {
  server: McpServerNode;
  expanded: boolean;
  onToggle: () => void;
  busy: string | null;
  onDiscover: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  onAcked: () => void;
}): React.ReactElement {
  const t = useTranslations('adminMcp');
  const worst = worstSeverityOf(server);
  return (
    <>
      <tr className="border-b border-[color:var(--border)]/60">
        <td className={tdCls}>
          <button className="text-left underline-offset-2 hover:underline" onClick={onToggle}>
            {server.name}
          </button>
        </td>
        <td className={tdCls}>{server.transport}</td>
        <td className={tdCls}>
          <span
            className={
              server.status === 'enabled'
                ? 'text-[color:var(--success)]'
                : 'text-[color:var(--fg-muted)]'
            }
          >
            {t(`servers.state.${server.status}`)}
          </span>
        </td>
        <td className={tdCls}>{server.discoveredTools.length}</td>
        <td className={tdCls}>
          {server.discoveredTools.length > 0 ? (
            <SkillVerdictBadge severity={worst} />
          ) : (
            <span className="text-xs text-[color:var(--fg-muted)]">–</span>
          )}
        </td>
        <td className={`${tdCls} whitespace-nowrap`}>
          <span className="inline-flex gap-1.5">
            <Button size="sm" variant="secondary" busy={busy === `discover:${server.id}`} onClick={onDiscover}>
              {t('servers.discover')}
            </Button>
            <Button size="sm" variant="ghost" busy={busy === `status:${server.id}`} onClick={onToggleStatus}>
              {server.status === 'enabled' ? t('servers.disable') : t('servers.enable')}
            </Button>
            <Button size="sm" variant="danger" onClick={onDelete}>
              {t('servers.delete')}
            </Button>
          </span>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-[color:var(--border)]/60 bg-[color:var(--bg-soft)]/40">
          <td className={tdCls} colSpan={6}>
            <ServerDetail server={server} onAcked={onAcked} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ServerDetail({
  server,
  onAcked,
}: {
  server: McpServerNode;
  onAcked: () => void;
}): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [ackArm, setAckArm] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (server.discoveredTools.length === 0) {
    return <div className="text-sm text-[color:var(--fg-muted)]">{t('servers.noTools')}</div>;
  }

  async function ack(toolName: string): Promise<void> {
    setAckBusy(toolName);
    setError(null);
    try {
      await ackMcpToolVerdict(server.id, toolName);
      setAckArm(null);
      onAcked();
    } catch (err) {
      setError(errText(err));
    } finally {
      setAckBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-[color:var(--fg-muted)]">
        {server.endpoint ?? ''} {server.lastDiscoveredAt ? `· ${server.lastDiscoveredAt}` : ''}
      </div>
      {server.discoveredTools.map((tool) => {
        const v = tool.verdict;
        const needsAck =
          v?.severity !== undefined &&
          v.severity !== null &&
          ['high_risk', 'scan_failed', 'too_large_to_scan'].includes(v.severity) &&
          (!v.acked || v.ackStale);
        return (
          <div
            key={tool.name}
            className="flex items-start justify-between gap-3 rounded border border-[color:var(--border)] px-2 py-1.5"
          >
            <div className="min-w-0">
              <div className="text-sm">{tool.name}</div>
              {tool.description ? (
                <div className="truncate text-xs text-[color:var(--fg-muted)]">{tool.description}</div>
              ) : null}
              {v && v.riskCodes.length > 0 ? (
                <div className="text-[10px] text-[color:var(--fg-muted)]">{v.riskCodes.join(', ')}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <SkillVerdictBadge severity={v?.severity ?? 'not_yet_scanned'} />
              {v?.acked && !v.ackStale ? (
                <span className="text-[10px] text-[color:var(--fg-muted)]">{t('servers.acked')}</span>
              ) : null}
              {needsAck ? (
                <Button
                  size="sm"
                  variant="danger"
                  busy={ackBusy === tool.name}
                  onClick={() => {
                    if (ackArm !== tool.name) {
                      setAckArm(tool.name);
                      return;
                    }
                    void ack(tool.name);
                  }}
                >
                  {ackArm === tool.name ? t('servers.ackConfirm') : t('servers.ack')}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
    </div>
  );
}

// ── Grants (read-only matrix, issue #461) ────────────────────────────────────

function GrantsPane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [rows, setRows] = useState<McpGrantMatrixRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<McpGrantMatrixRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows((await listMcpGrants()).grants);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(row: McpGrantMatrixRow): Promise<void> {
    if (!row.agentSlug) return;
    try {
      await deleteGraphEdge(row.agentSlug, `tool_grant:${row.grantId}`, 'tool_grant');
      await refresh();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {!rows ? <div className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</div> : null}
      {rows && rows.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('grants.empty')}</div>
      ) : null}
      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[color:var(--border)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[color:var(--border)]">
                <th className={thCls}>{t('grants.holder')}</th>
                <th className={thCls}>{t('grants.server')}</th>
                <th className={thCls}>{t('grants.tool')}</th>
                <th className={thCls}>{t('grants.verdict')}</th>
                <th className={thCls}>{t('grants.state')}</th>
                <th className={thCls}>{t('grants.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.grantId} className="border-b border-[color:var(--border)]/60">
                  <td className={tdCls}>
                    {r.agentName ?? r.agentSlug ?? '?'}
                    {r.holderKind === 'subagent' && r.subAgentName ? (
                      <span className="text-xs text-[color:var(--fg-muted)]"> → {r.subAgentName}</span>
                    ) : null}
                  </td>
                  <td className={tdCls}>{r.serverName ?? r.serverId ?? '?'}</td>
                  <td className={tdCls}>{r.toolName}</td>
                  <td className={tdCls}>
                    <SkillVerdictBadge severity={r.severity ?? 'not_yet_scanned'} />
                  </td>
                  <td className={tdCls}>
                    {r.blocked ? (
                      <span className="text-[color:var(--danger)]">{t('grants.blocked')}</span>
                    ) : r.notYetScanned ? (
                      <span className="text-[color:var(--warning)]">{t('grants.unscanned')}</span>
                    ) : (
                      <span className="text-[color:var(--success)]">{t('grants.active')}</span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(r)}>
                      {t('grants.revoke')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmRevoke !== null}
        title={t('grants.revokeTitle')}
        body={
          confirmRevoke
            ? t('grants.revokeBody', {
                tool: confirmRevoke.toolName,
                holder: confirmRevoke.subAgentName ?? confirmRevoke.agentName ?? '?',
              })
            : undefined
        }
        confirmLabel={t('grants.revokeConfirm')}
        cancelLabel={t('cancel')}
        tone="danger"
        onCancel={() => setConfirmRevoke(null)}
        onConfirm={() => {
          const target = confirmRevoke;
          setConfirmRevoke(null);
          if (target) void revoke(target);
        }}
      />
    </div>
  );
}

// ── Audit (issue #462) ───────────────────────────────────────────────────────

function AuditPane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [entries, setEntries] = useState<McpCallLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries((await listMcpCallLog({ limit: 100 })).entries);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!entries || entries.length === 0) return;
    setLoadingMore(true);
    try {
      const last = entries[entries.length - 1];
      const more = await listMcpCallLog({ limit: 100, beforeId: last?.id });
      setEntries([...entries, ...more.entries]);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {!entries ? <div className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</div> : null}
      {entries && entries.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('audit.empty')}</div>
      ) : null}
      {entries && entries.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[color:var(--border)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[color:var(--border)]">
                <th className={thCls}>{t('audit.time')}</th>
                <th className={thCls}>{t('audit.server')}</th>
                <th className={thCls}>{t('audit.tool')}</th>
                <th className={thCls}>{t('audit.caller')}</th>
                <th className={thCls}>{t('audit.outcome')}</th>
                <th className={thCls}>{t('audit.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-[color:var(--border)]/60">
                  <td className={`${tdCls} whitespace-nowrap text-xs`}>{e.calledAt}</td>
                  <td className={tdCls}>{e.serverName}</td>
                  <td className={tdCls}>{e.toolName}</td>
                  <td className={tdCls}>
                    {t(`audit.kind.${e.callerKind}`)}
                    {e.callerAgent ? (
                      <span className="text-xs text-[color:var(--fg-muted)]"> · {e.callerAgent}</span>
                    ) : null}
                  </td>
                  <td className={tdCls}>
                    {e.ok ? (
                      <span className="text-[color:var(--success)]">{t('audit.ok')}</span>
                    ) : (
                      <span className="text-[color:var(--danger)]" title={e.error ?? undefined}>
                        {t('audit.failed')}
                      </span>
                    )}
                  </td>
                  <td className={`${tdCls} text-xs`}>{e.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {entries && entries.length >= 100 ? (
        <Button size="sm" variant="ghost" busy={loadingMore} onClick={() => void loadMore()}>
          {t('audit.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
