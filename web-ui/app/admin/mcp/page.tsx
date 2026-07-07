'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '../../_lib/api';
import { ConfirmDialog } from '../../_components/ConfirmDialog';
import { SkillVerdictBadge } from '../../_components/admin/SkillVerdictBadge';
import { McpAuthSection } from '../../_components/mcp/McpAuthSection';
import { McpConnectModal } from '../../_components/mcp/McpConnectModal';
import {
  ackMcpToolVerdict,
  addMcpRegistry,
  createMcpServer,
  rescanAllMcpServers,
  testCallMcpTool,
  deleteGraphEdge,
  deleteMcpRegistry,
  deleteMcpServer,
  discoverMcpTools,
  importMcpServerFromRegistry,
  grantMcpToolToOrchestrator,
  grantPluginMcpServer,
  listMcpCallLog,
  listMcpGrants,
  listMcpOrchestrators,
  listMcpPluginCandidates,
  listMcpRegistries,
  listMcpServers,
  revokeMcpGrant,
  revokePluginMcpServer,
  searchMcpCatalog,
  setMcpServerStatus,
  setMcpServerPrivacyBypass,
  setMcpServerKgIngest,
  type McpCallLogEntry,
  type McpCatalogEntry,
  type McpGrantMatrixRow,
  type McpOrchestrator,
  type McpPluginCandidate,
  type McpRegistryInfo,
  type McpServerNode,
  type McpTransport,
  type SkillVerdictSeverity,
} from '../../_lib/agentBuilder';

type Tab = 'servers' | 'marketplace' | 'grants' | 'plugins' | 'audit';

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
    <div className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-8 lg:py-16">
      <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
        {t('title')}
      </h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
        {t('intro')}
      </p>
      <div className="mt-8 flex flex-wrap gap-2">
        {(['servers', 'marketplace', 'grants', 'plugins', 'audit'] as const).map((k) => (
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
      <div className="mt-6">
        {tab === 'servers' ? <ServersPane /> : null}
        {tab === 'marketplace' ? <MarketplacePane /> : null}
        {tab === 'grants' ? <GrantsPane /> : null}
        {tab === 'plugins' ? <PluginGrantsPane /> : null}
        {tab === 'audit' ? <AuditPane /> : null}
      </div>
    </div>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Detect the discover route's 409 "needs authorization" response so the UI can
 *  prompt Connect instead of showing a raw 502/error (issue #459). */
function parseNeedsAuth(
  err: unknown,
): { serverId: string; serverName: string; issuerHost: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const b = JSON.parse(err.body) as {
      error?: string;
      serverId?: string;
      serverName?: string;
      issuerHost?: string;
    };
    if (b.error === 'mcp_needs_auth' && b.serverId) {
      return {
        serverId: b.serverId,
        serverName: b.serverName ?? '',
        issuerHost: b.issuerHost ?? '',
      };
    }
  } catch {
    /* not a needs-auth body */
  }
  return null;
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
  const [authNotice, setAuthNotice] = useState<{ name: string; host: string } | null>(null);
  const [connectModal, setConnectModal] = useState<{ serverId: string; name: string } | null>(null);
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
    setAuthNotice(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      const na = parseNeedsAuth(err);
      if (na) {
        // Discover failed because the server needs OAuth — open the same Connect
        // login modal as the chat UI directly, instead of a raw 502.
        setConnectModal({ serverId: na.serverId, name: na.serverName });
        setAuthNotice({ name: na.serverName, host: na.issuerHost });
      } else {
        setError(errText(err));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/8 px-3 py-2 text-xs text-[color:var(--fg-muted)]">
        {t('servers.flowHint')}
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <label className="flex flex-col gap-1 text-xs">
          {t('servers.name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t('servers.transport')}
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as McpTransport)}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
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
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
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
        <Button
          size="sm"
          variant="ghost"
          busy={busy === 'rescan'}
          onClick={() => void act('rescan', () => rescanAllMcpServers())}
        >
          {t('servers.rescanAll')}
        </Button>
      </div>

      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {authNotice ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-2 text-sm text-[color:var(--fg-default)]">
          <span>🔒 {t('servers.needsAuth', { name: authNotice.name, host: authNotice.host || '?' })}</span>
        </div>
      ) : null}
      {connectModal ? (
        <McpConnectModal
          serverId={connectModal.serverId}
          serverName={connectModal.name}
          onClose={() => setConnectModal(null)}
        />
      ) : null}
      {!servers ? <div className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</div> : null}

      {servers && servers.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('servers.empty')}</div>
      ) : null}

      {servers && servers.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[color:var(--border)]">
                <th className={thCls}>{t('servers.name')}</th>
                <th className={thCls}>{t('servers.transport')}</th>
                <th className={thCls}>{t('servers.status')}</th>
                <th className={thCls}>{t('servers.tools')}</th>
                <th className={thCls}>{t('servers.worstVerdict')}</th>
                <th className={thCls} colSpan={5}>{t('servers.actions')}</th>
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
                  onTogglePrivacy={() =>
                    void act(`privacy:${s.id}`, () =>
                      setMcpServerPrivacyBypass(s.id, !s.privacyBypass),
                    )
                  }
                  onToggleKg={() =>
                    void act(`kg:${s.id}`, () => setMcpServerKgIngest(s.id, !s.kgIngest))
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
  onTogglePrivacy,
  onToggleKg,
  onDelete,
  onAcked,
}: {
  server: McpServerNode;
  expanded: boolean;
  onToggle: () => void;
  busy: string | null;
  onDiscover: () => void;
  onToggleStatus: () => void;
  onTogglePrivacy: () => void;
  onToggleKg: () => void;
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
        {/* Each action is its own table column so they align across rows. */}
        <td className={`${tdCls} whitespace-nowrap`}>
          <Button size="sm" variant="secondary" busy={busy === `discover:${server.id}`} onClick={onDiscover}>
            {t('servers.discover')}
          </Button>
        </td>
        <td className={`${tdCls} whitespace-nowrap`}>
          <Button size="sm" variant="ghost" busy={busy === `status:${server.id}`} onClick={onToggleStatus}>
            {server.status === 'enabled' ? t('servers.disable') : t('servers.enable')}
          </Button>
        </td>
        <td className={`${tdCls} whitespace-nowrap`}>
          <Button
            size="sm"
            variant="ghost"
            busy={busy === `privacy:${server.id}`}
            onClick={onTogglePrivacy}
            title={
              server.privacyBypass
                ? t('servers.privacy.bypassedHint')
                : t('servers.privacy.maskedHint')
            }
          >
            {server.privacyBypass
              ? `🔓 ${t('servers.privacy.bypassed')}`
              : `🛡️ ${t('servers.privacy.masked')}`}
          </Button>
        </td>
        <td className={`${tdCls} whitespace-nowrap`}>
          <Button
            size="sm"
            variant="ghost"
            busy={busy === `kg:${server.id}`}
            onClick={onToggleKg}
            title={server.kgIngest ? t('servers.kg.onHint') : t('servers.kg.offHint')}
          >
            {server.kgIngest ? `🧠 ${t('servers.kg.on')}` : `🧠 ${t('servers.kg.off')}`}
          </Button>
        </td>
        <td className={`${tdCls} whitespace-nowrap`}>
          <Button size="sm" variant="danger" onClick={onDelete}>
            {t('servers.delete')}
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-[color:var(--border)]/60 bg-[color:var(--bg-soft)]/40">
          <td className={tdCls} colSpan={10}>
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
  const [testTool, setTestTool] = useState<string | null>(null);
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
      <McpAuthSection serverId={server.id} />
      {server.source === 'marketplace' ? (
        <div className="flex flex-wrap gap-2 text-[10px]">
          <span className="text-[color:var(--accent)]">{t('servers.marketplaceSource')}</span>
          {server.license ? (
            <span className="text-[color:var(--fg-muted)]">{server.license}</span>
          ) : (
            <span className="text-[color:var(--warning)]">{t('marketplace.unlicensed')}</span>
          )}
          {server.author ? <span className="text-[color:var(--fg-muted)]">@{server.author}</span> : null}
          {server.sourceUrl ? (
            <a
              href={server.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[color:var(--fg-muted)] underline underline-offset-2"
            >
              {t('servers.sourceLink')}
            </a>
          ) : null}
        </div>
      ) : null}
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
            className="flex flex-col gap-1.5 rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 px-3 py-2.5"
          >
            {/* Badge sits inline next to the name; nothing is right-anchored, so
                the row never needs horizontal scrolling regardless of width. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-[color:var(--fg-strong)]">{tool.name}</span>
              <SkillVerdictBadge severity={v?.severity ?? 'not_yet_scanned'} />
              {v?.acked && !v.ackStale ? (
                <span className="text-[11px] text-[color:var(--fg-muted)]">{t('servers.acked')}</span>
              ) : null}
            </div>
            {tool.description ? (
              <div className="text-sm leading-[1.5] text-[color:var(--fg-muted)]">{tool.description}</div>
            ) : null}
            {v && v.riskCodes.length > 0 ? (
              <div className="text-[11px] text-[color:var(--fg-muted)]">{v.riskCodes.join(', ')}</div>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTestTool(testTool === tool.name ? null : tool.name)}
              >
                {t('sandbox.toggle')}
              </Button>
            </div>
            {testTool === tool.name ? (
              <ToolTestForm serverId={server.id} tool={tool} />
            ) : null}
          </div>
        );
      })}
      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
    </div>
  );
}


// ── Test-call sandbox (issue #463) ───────────────────────────────────────────

interface SchemaProp {
  name: string;
  type: string;
  description: string | null;
  required: boolean;
}

function schemaProps(inputSchema: Record<string, unknown> | undefined): SchemaProp[] {
  const properties = inputSchema?.['properties'];
  if (!properties || typeof properties !== 'object') return [];
  const required = new Set(
    Array.isArray(inputSchema?.['required']) ? (inputSchema['required'] as string[]) : [],
  );
  return Object.entries(properties as Record<string, unknown>).map(([name, def]) => {
    const d = (def ?? {}) as Record<string, unknown>;
    return {
      name,
      type: typeof d['type'] === 'string' ? (d['type'] as string) : 'string',
      description: typeof d['description'] === 'string' ? (d['description'] as string) : null,
      required: required.has(name),
    };
  });
}

/** Auto-generated form from a tool's inputSchema (epic item 4): primitive
 *  top-level properties render as typed inputs, everything else falls back to
 *  a JSON textarea per field. The call runs through the guarded + audited
 *  manager server-side. */
function ToolTestForm({
  serverId,
  tool,
}: {
  serverId: string;
  tool: { name: string; inputSchema?: Record<string, unknown> };
}): React.ReactElement {
  const t = useTranslations('adminMcp');
  const props = schemaProps(tool.inputSchema);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; result: string; durationMs: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  function buildArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const p of props) {
      const raw = values[p.name];
      if (raw === undefined || raw === '') continue;
      if (p.type === 'number' || p.type === 'integer') {
        const n = Number(raw);
        if (Number.isFinite(n)) args[p.name] = n;
      } else if (p.type === 'boolean') {
        args[p.name] = raw === 'true';
      } else if (p.type === 'string') {
        args[p.name] = raw;
      } else {
        try {
          args[p.name] = JSON.parse(raw);
        } catch {
          args[p.name] = raw;
        }
      }
    }
    return args;
  }

  async function run(): Promise<void> {
    setPending(true);
    setError(null);
    setOutcome(null);
    try {
      setOutcome(await testCallMcpTool(serverId, tool.name, buildArgs()));
    } catch (err) {
      setError(errText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded border border-[color:var(--border)]/60 bg-[color:var(--bg-soft)]/40 p-2">
      {props.length === 0 ? (
        <div className="text-xs text-[color:var(--fg-muted)]">{t('sandbox.noParams')}</div>
      ) : (
        props.map((p) => (
          <label key={p.name} className="flex flex-col gap-0.5 text-xs">
            <span>
              {p.name}
              {p.required ? ' *' : ''}
              {p.description ? (
                <span className="text-[color:var(--fg-muted)]"> · {p.description}</span>
              ) : null}
            </span>
            {p.type === 'boolean' ? (
              <select
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2.5 py-1.5 outline-none focus:border-[color:var(--accent)]"
              >
                <option value="">–</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : p.type === 'object' || p.type === 'array' ? (
              <textarea
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                rows={2}
                placeholder="{ }"
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2.5 py-1.5 font-mono outline-none focus:border-[color:var(--accent)]"
              />
            ) : (
              <input
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2.5 py-1.5 outline-none focus:border-[color:var(--accent)]"
              />
            )}
          </label>
        ))
      )}
      <div>
        <Button size="sm" variant="secondary" busy={pending} onClick={() => void run()}>
          {t('sandbox.run')}
        </Button>
      </div>
      {outcome ? (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] text-[color:var(--fg-muted)]">
            {outcome.ok ? (
              <span className="text-[color:var(--success)]">{t('sandbox.ok')}</span>
            ) : (
              <span className="text-[color:var(--danger)]">{t('sandbox.failed')}</span>
            )}{' '}
            · {outcome.durationMs} ms
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-[color:var(--border)] p-2 text-[11px]">
            {outcome.result}
          </pre>
        </div>
      ) : null}
      {error ? <div className="text-xs text-[color:var(--danger)]">{error}</div> : null}
    </div>
  );
}

// ── Marketplace (issue #455) ─────────────────────────────────────────────────

function MarketplacePane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [registries, setRegistries] = useState<McpRegistryInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [regName, setRegName] = useState('');
  const [regUrl, setRegUrl] = useState('');
  const [regToken, setRegToken] = useState('');

  const refreshRegistries = useCallback(async () => {
    try {
      const list = (await listMcpRegistries()).registries;
      setRegistries(list);
      setSelected((prev) => prev ?? list[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refreshRegistries();
  }, [refreshRegistries]);

  async function browse(): Promise<void> {
    if (!selected) return;
    setBusy('browse');
    setError(null);
    setConnected(null);
    try {
      setEntries((await searchMcpCatalog(selected, query)).entries);
    } catch (err) {
      setError(errText(err));
      setEntries(null);
    } finally {
      setBusy(null);
    }
  }

  async function connect(entry: McpCatalogEntry): Promise<void> {
    if (!selected) return;
    setBusy(`connect:${entry.id}`);
    setError(null);
    try {
      const server = await importMcpServerFromRegistry(selected, entry.id);
      setConnected(server.name);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <label className="flex flex-col gap-1 text-xs">
          {t('marketplace.registry')}
          <select
            value={selected ?? ''}
            onChange={(e) => {
              setSelected(e.target.value || null);
              setEntries(null);
            }}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          >
            {(registries ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex grow flex-col gap-1 text-xs">
          {t('marketplace.search')}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void browse();
            }}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          />
        </label>
        <Button size="sm" busy={busy === 'browse'} onClick={() => void browse()}>
          {t('marketplace.browse')}
        </Button>
        {selected && registries && registries.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void deleteMcpRegistry(selected).then(() => {
                setSelected(null);
                setEntries(null);
                return refreshRegistries();
              })
            }
          >
            {t('marketplace.removeRegistry')}
          </Button>
        ) : null}
      </div>

      <details className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <summary className="cursor-pointer text-xs text-[color:var(--fg-muted)]">
          {t('marketplace.addRegistry')}
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            {t('marketplace.registryName')}
            <input
              value={regName}
              onChange={(e) => setRegName(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex grow flex-col gap-1 text-xs">
            {t('marketplace.registryUrl')}
            <input
              value={regUrl}
              onChange={(e) => setRegUrl(e.target.value)}
              placeholder="https://…"
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t('marketplace.registryToken')}
            <input
              type="password"
              value={regToken}
              onChange={(e) => setRegToken(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <Button
            size="sm"
            busy={busy === 'addRegistry'}
            onClick={() => {
              setBusy('addRegistry');
              setError(null);
              void addMcpRegistry({
                name: regName.trim(),
                url: regUrl.trim(),
                ...(regToken.trim() !== ''
                  ? { authKind: 'bearer' as const, token: regToken.trim() }
                  : {}),
              })
                .then(() => {
                  setRegName('');
                  setRegUrl('');
                  setRegToken('');
                  return refreshRegistries();
                })
                .catch((err: unknown) => setError(errText(err)))
                .finally(() => setBusy(null));
            }}
          >
            {t('marketplace.addRegistryConfirm')}
          </Button>
        </div>
      </details>

      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {connected ? (
        <div className="rounded-md border border-[color:var(--success)]/50 bg-[color:var(--success)]/8 px-3 py-2 text-sm">
          {t('marketplace.connected', { name: connected })}
        </div>
      ) : null}

      {entries ? (
        entries.length === 0 ? (
          <div className="text-sm text-[color:var(--fg-muted)]">{t('marketplace.noResults')}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-md border border-[color:var(--border)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm">
                    {entry.name}
                    {entry.version ? (
                      <span className="text-xs text-[color:var(--fg-muted)]"> · v{entry.version}</span>
                    ) : null}
                  </div>
                  {entry.description ? (
                    <div className="text-xs text-[color:var(--fg-muted)]">{entry.description}</div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
                    {entry.license ? (
                      <span className="text-[color:var(--fg-muted)]">{entry.license}</span>
                    ) : (
                      <span className="text-[color:var(--warning)]">{t('marketplace.unlicensed')}</span>
                    )}
                    {entry.author ? (
                      <span className="text-[color:var(--fg-muted)]">@{entry.author}</span>
                    ) : null}
                    {entry.transport ? (
                      <span className="text-[color:var(--fg-muted)]">{entry.transport}</span>
                    ) : (
                      <span className="text-[color:var(--fg-muted)]">{t('marketplace.browseOnly')}</span>
                    )}
                    {entry.transport === 'http' || entry.transport === 'sse' ? (
                      <span className="text-[color:var(--warning)]">{t('marketplace.authHintRemote')}</span>
                    ) : entry.transport === 'stdio' ? (
                      <span className="text-[color:var(--fg-muted)]">{t('marketplace.authHintLocal')}</span>
                    ) : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  busy={busy === `connect:${entry.id}`}
                  disabled={!entry.transport}
                  onClick={() => void connect(entry)}
                >
                  {t('marketplace.connect')}
                </Button>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('marketplace.hint')}</div>
      )}
    </div>
  );
}

// ── Grants (read-only matrix, issue #461) ────────────────────────────────────

function GrantsPane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [rows, setRows] = useState<McpGrantMatrixRow[] | null>(null);
  const [orchestrators, setOrchestrators] = useState<McpOrchestrator[]>([]);
  const [servers, setServers] = useState<McpServerNode[]>([]);
  const [pickAgent, setPickAgent] = useState('');
  const [pickServer, setPickServer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<McpGrantMatrixRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, o, s] = await Promise.all([listMcpGrants(), listMcpOrchestrators(), listMcpServers()]);
      setRows(g.grants);
      setOrchestrators(o.orchestrators);
      setServers(s.servers.filter((sv) => sv.status === 'enabled'));
      setPickAgent((prev) => prev || o.orchestrators[0]?.slug || '');
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(row: McpGrantMatrixRow): Promise<void> {
    try {
      await revokeMcpGrant(row.grantId);
      await refresh();
    } catch (err) {
      setError(errText(err));
    }
  }

  const chosenServer = servers.find((s) => s.id === pickServer);
  const grantedSet = new Set(
    (rows ?? [])
      .filter((r) => r.holderKind === 'agent' && r.agentSlug === pickAgent && r.serverId === pickServer)
      .map((r) => r.toolName),
  );

  async function grant(toolName: string): Promise<void> {
    if (!pickAgent || !pickServer) return;
    setBusy(toolName);
    setError(null);
    try {
      await grantMcpToolToOrchestrator(pickAgent, pickServer, toolName);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function grantAll(): Promise<void> {
    if (!chosenServer) return;
    setBusy('all');
    setError(null);
    try {
      for (const tool of chosenServer.discoveredTools) {
        if (!grantedSet.has(tool.name)) {
          await grantMcpToolToOrchestrator(pickAgent, pickServer, tool.name);
        }
      }
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Grant surface (W8): the step that makes a scanned server usable — pick
          an orchestrator + server, then grant its tools. No Builder canvas. */}
      <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('grants.grantHeading')}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            {t('grants.orchestrator')}
            <select
              value={pickAgent}
              onChange={(e) => setPickAgent(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            >
              {orchestrators.map((o) => (
                <option key={o.id} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t('grants.server')}
            <select
              value={pickServer}
              onChange={(e) => setPickServer(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            >
              <option value="">{t('grants.pickServer')}</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {chosenServer && chosenServer.discoveredTools.length > 0 ? (
            <Button size="sm" busy={busy === 'all'} onClick={() => void grantAll()}>
              {t('grants.grantAll')}
            </Button>
          ) : null}
        </div>
        {pickServer === '' ? (
          <div className="text-xs text-[color:var(--fg-muted)]">{t('grants.grantHint')}</div>
        ) : chosenServer && chosenServer.discoveredTools.length === 0 ? (
          <div className="text-xs text-[color:var(--warning)]">{t('grants.noToolsDiscover')}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {chosenServer?.discoveredTools.map((tool) => {
              const granted = grantedSet.has(tool.name);
              return (
                <Button
                  key={tool.name}
                  size="sm"
                  variant={granted ? 'primary' : 'ghost'}
                  busy={busy === tool.name}
                  disabled={granted}
                  onClick={() => void grant(tool.name)}
                  title={tool.description ?? tool.name}
                >
                  {granted ? `✓ ${tool.name}` : tool.name}
                </Button>
              );
            })}
          </div>
        )}
      </div>
      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {!rows ? <div className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</div> : null}
      {rows && rows.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('grants.empty')}</div>
      ) : null}
      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40">
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
                    <span className="mr-1.5 rounded-full border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[color:var(--fg-muted)]">
                      {t(`grants.kind.${r.holderKind}`)}
                    </span>
                    {r.agentName ?? r.agentSlug ?? '?'}
                    {(r.holderKind === 'subagent' || r.holderKind === 'skill') && r.subAgentName ? (
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
                    {r.holderKind === 'agent' || r.holderKind === 'subagent' ? (
                      <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(r)}>
                        {t('grants.revoke')}
                      </Button>
                    ) : (
                      <span className="text-[10px] text-[color:var(--fg-muted)]">
                        {t(`grants.manageHint.${r.holderKind}`)}
                      </span>
                    )}
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

// ── Plugin grants (issue #458 UX / W7) ───────────────────────────────────────

function PluginGrantsPane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [data, setData] = useState<{
    servers: { id: string; name: string; status: 'enabled' | 'disabled' }[];
    plugins: McpPluginCandidate[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await listMcpPluginCandidates());
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(pluginId: string, serverId: string, granted: boolean): Promise<void> {
    setBusy(`${pluginId} ${serverId}`);
    setError(null);
    try {
      if (granted) await revokePluginMcpServer(pluginId, serverId);
      else await grantPluginMcpServer(pluginId, serverId);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[color:var(--fg-muted)]">{t('plugins.intro')}</p>
      {error ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      {!data ? <div className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</div> : null}
      {data && data.plugins.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('plugins.empty')}</div>
      ) : null}
      {data
        ? data.plugins.map((p) => (
            <div
              key={p.pluginId}
              className="flex flex-col gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
            >
              <div>
                <div className="text-sm">{p.name}</div>
                <div className="text-[10px] text-[color:var(--fg-muted)]">{p.pluginId}</div>
                {p.serversHint.length > 0 ? (
                  <div className="mt-0.5 text-[10px] text-[color:var(--fg-muted)]">
                    {t('plugins.hint', { hint: p.serversHint.join(', ') })}
                  </div>
                ) : null}
              </div>
              {data.servers.length === 0 ? (
                <div className="text-xs text-[color:var(--warning)]">{t('plugins.noServers')}</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.servers.map((s) => {
                    const granted = p.grantedServerIds.includes(s.id);
                    return (
                      <Button
                        key={s.id}
                        size="sm"
                        variant={granted ? 'primary' : 'ghost'}
                        busy={busy === `${p.pluginId} ${s.id}`}
                        onClick={() => void toggle(p.pluginId, s.id, granted)}
                      >
                        {granted ? `✓ ${s.name}` : s.name}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        : null}
    </div>
  );
}

// ── Audit (issue #462) ───────────────────────────────────────────────────────

function AuditPane(): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [entries, setEntries] = useState<McpCallLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = (await listMcpCallLog({ limit: 100 })).entries;
      setEntries(page);
      setHasMore(page.length === 100);
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
      const more = (await listMcpCallLog({ limit: 100, beforeId: last?.id })).entries;
      setEntries((prev) => [...(prev ?? []), ...more]);
      setHasMore(more.length === 100);
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
        <div className="overflow-x-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40">
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
      {hasMore ? (
        <Button size="sm" variant="ghost" busy={loadingMore} onClick={() => void loadMore()}>
          {t('audit.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
