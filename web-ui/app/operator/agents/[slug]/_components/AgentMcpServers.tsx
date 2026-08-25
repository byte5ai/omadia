'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import { SkillVerdictBadge } from '@/app/_components/admin/SkillVerdictBadge';
import { McpAuthSection } from '@/app/_components/mcp/McpAuthSection';
import {
  ackMcpToolVerdict,
  listMcpServers,
  parseMcpGrantErrorCode,
  replaceMcpToolAllowlist,
  type McpDiscoveredTool,
  type McpServerNode,
} from '../../../../_lib/agentBuilder';
import { getAgentGrants, type AgentGrantsDto } from '../../../../_lib/agents';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Verdict severities that require an operator ack before a grant may pass
 *  (mirrors the middleware's MCP_SEVERITIES_NEEDING_ACK — issue #454). */
const SEVERITIES_NEEDING_ACK = ['high_risk', 'scan_failed', 'too_large_to_scan'];

/** True when the scan gate demands an ack that is missing or stale. */
function needsAck(tool: McpDiscoveredTool): boolean {
  const v = tool.verdict;
  return (
    v?.severity != null &&
    SEVERITIES_NEEDING_ACK.includes(v.severity) &&
    (!v.acked || v.ackStale)
  );
}

/**
 * Fail-closed UI mirror of the middleware's verdict gate (`assertMcpToolAllowed`
 * rejects blocked and unscanned tools as 409 `config_validation`): a tool with
 * a missing verdict, a not-yet-run scan, or an un-acked high-risk verdict is
 * not grantable here either — the backend would refuse it regardless.
 */
function isGrantable(tool: McpDiscoveredTool): boolean {
  const v = tool.verdict;
  if (!v || v.notYetScanned) return false;
  return !needsAck(tool);
}

/** The agent's granted MCP tool names, keyed by server id. */
function grantedByServer(grants: AgentGrantsDto | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const g of grants?.tool_grants ?? []) {
    if (g.tool_kind !== 'mcp' || g.mcp_server_id === null) continue;
    const set = map.get(g.mcp_server_id) ?? new Set<string>();
    set.add(g.tool_ref);
    map.set(g.mcp_server_id, set);
  }
  return map;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Per-agent MCP server assignment + tool allowlist editor (issue #862, epic
 * #860). Assignment IS the set of `agent_tool_grants` rows for the (agent,
 * server) pair — there is no separate assignment storage — so this component
 * edits the allowlist as a draft selection over `server.discoveredTools` and
 * saves it in one `PUT /mcp-grants` bulk replace ({@link replaceMcpToolAllowlist}).
 * Mounted into the agent detail page by the wave's wiring unit.
 */
export function AgentMcpServers({ slug }: { slug: string }): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [servers, setServers] = useState<McpServerNode[] | null>(null);
  const [grants, setGrants] = useState<AgentGrantsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** Draft allowlist per server id; absent ⇒ mirror the saved grant set. */
  const [draft, setDraft] = useState<Record<string, readonly string[]>>({});
  const [saved, setSaved] = useState<{ id: string; granted: number; revoked: number } | null>(null);
  const [ackArm, setAckArm] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [confirmUnassign, setConfirmUnassign] = useState<McpServerNode | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([listMcpServers(), getAgentGrants(slug)]);
      setServers(s.servers);
      setGrants(g);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grantErrorText = useCallback(
    (err: unknown): string => {
      const code = parseMcpGrantErrorCode(err);
      return code !== null
        ? t(`mcp.errors.${code}`)
        : t('mcp.errors.unknown', { detail: errText(err) });
    },
    [t],
  );

  const grantedMap = grantedByServer(grants);
  const selectionFor = (serverId: string): Set<string> =>
    new Set(draft[serverId] ?? [...(grantedMap.get(serverId) ?? [])]);

  const toggleOpen = (serverId: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  const toggleTool = (serverId: string, toolName: string): void => {
    const sel = selectionFor(serverId);
    if (sel.has(toolName)) sel.delete(toolName);
    else sel.add(toolName);
    setDraft((prev) => ({ ...prev, [serverId]: [...sel] }));
  };

  const clearDraft = (serverId: string): void => {
    setDraft((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([k]) => k !== serverId)),
    );
  };

  async function saveAllowlist(server: McpServerNode, toolNames: string[]): Promise<void> {
    setBusy(server.id);
    setError(null);
    setSaved(null);
    try {
      const res = await replaceMcpToolAllowlist(slug, server.id, [...toolNames].sort());
      setSaved({ id: server.id, granted: res.granted.length, revoked: res.revoked.length });
      await refresh();
      clearDraft(server.id);
    } catch (err) {
      setError(grantErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function ack(server: McpServerNode, toolName: string): Promise<void> {
    const key = `${server.id} ${toolName}`;
    setAckBusy(key);
    setError(null);
    try {
      await ackMcpToolVerdict(server.id, toolName);
      setAckArm(null);
      await refresh();
    } catch (err) {
      setError(grantErrorText(err));
    } finally {
      setAckBusy(null);
    }
  }

  // Assignable servers plus any (even disabled) server the agent still holds
  // grants on — revocation must stay reachable after a server is disabled.
  const visible = (servers ?? []).filter(
    (s) => s.status === 'enabled' || (grantedMap.get(s.id)?.size ?? 0) > 0,
  );

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-medium text-[color:var(--fg-strong)]">{t('mcp.heading')}</h2>
        <p className="mt-1 text-sm leading-[1.55] text-[color:var(--fg-muted)]">{t('mcp.hint')}</p>
      </div>
      {loadError !== null ? (
        <div className="text-sm text-[color:var(--danger)]">
          {t('mcp.loadError', { detail: loadError })}
        </div>
      ) : null}
      {servers === null && loadError === null ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('mcp.loading')}</div>
      ) : null}
      {servers !== null && visible.length === 0 ? (
        <div className="text-sm text-[color:var(--fg-muted)]">{t('mcp.empty')}</div>
      ) : null}
      {visible.map((server) => {
        const grantedSet = grantedMap.get(server.id) ?? new Set<string>();
        const sel = selectionFor(server.id);
        const dirty = !sameSet(sel, grantedSet);
        const isOpen = open.has(server.id);
        return (
          <div
            key={server.id}
            className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40"
          >
            {/* eslint-disable-next-line no-restricted-syntax -- chevron/expander (aria-expanded) */}
            <button
              type="button"
              onClick={() => toggleOpen(server.id)}
              aria-expanded={isOpen}
              className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2.5 text-left hover:bg-[color:var(--accent)]/6"
            >
              <span
                aria-hidden
                className="text-[color:var(--fg-muted)] transition-transform"
                style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}
              >
                ▸
              </span>
              <span className="text-sm font-medium text-[color:var(--fg-strong)]">{server.name}</span>
              {server.status === 'disabled' ? (
                <span className="rounded-full border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[color:var(--fg-muted)]">
                  {t('statusDisabled')}
                </span>
              ) : null}
              <span className="ml-auto text-[11px] text-[color:var(--fg-muted)]">
                {grantedSet.size > 0
                  ? t('mcp.toolsGranted', {
                      granted: grantedSet.size,
                      total: server.discoveredTools.length,
                    })
                  : t('mcp.notAssigned')}
              </span>
            </button>
            {isOpen ? (
              <div className="flex flex-col gap-2 border-t border-[color:var(--border)]/60 p-3">
                <McpAuthSection serverId={server.id} />
                {server.discoveredTools.length === 0 ? (
                  <div className="text-sm text-[color:var(--fg-muted)]">{t('mcp.noTools')}</div>
                ) : (
                  <>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
                      {t('mcp.discoveredTools', { count: server.discoveredTools.length })}
                    </div>
                    {server.discoveredTools.map((tool) => {
                      const v = tool.verdict;
                      const ackNeeded = needsAck(tool);
                      const unscanned = !v || v.notYetScanned;
                      const checked = sel.has(tool.name);
                      // A blocked tool must stay ungrantable (fail-closed),
                      // but un-checking an already granted one must always work.
                      const disabled = !isGrantable(tool) && !checked;
                      const ackKey = `${server.id} ${tool.name}`;
                      return (
                        <div
                          key={tool.name}
                          className="flex flex-col gap-1 rounded-md border border-[color:var(--border)] px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-sm text-[color:var(--fg-strong)]">
                              <input
                                type="checkbox"
                                aria-label={t('mcp.toolAria', { tool: tool.name })}
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggleTool(server.id, tool.name)}
                              />
                              {tool.name}
                            </label>
                            <div className="flex shrink-0 items-center gap-2">
                              {v?.acked && !v.ackStale ? (
                                <span className="text-[11px] text-[color:var(--fg-muted)]">
                                  {t('mcp.acked')}
                                </span>
                              ) : null}
                              <SkillVerdictBadge severity={v?.severity ?? 'not_yet_scanned'} />
                            </div>
                          </div>
                          {tool.description !== undefined && tool.description !== '' ? (
                            <div className="text-sm leading-[1.5] text-[color:var(--fg-muted)]">
                              {tool.description}
                            </div>
                          ) : null}
                          {v !== undefined && v.riskCodes.length > 0 ? (
                            <div className="text-[11px] text-[color:var(--fg-muted)]">
                              {v.riskCodes.join(', ')}
                            </div>
                          ) : null}
                          {ackNeeded ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[11px] text-[color:var(--warning)]">
                                {t('mcp.needsAckHint')}
                              </span>
                              <Button
                                size="sm"
                                variant="danger"
                                busy={ackBusy === ackKey}
                                onClick={() => {
                                  if (ackArm !== ackKey) {
                                    setAckArm(ackKey);
                                    return;
                                  }
                                  void ack(server, tool.name);
                                }}
                              >
                                {ackArm === ackKey ? t('mcp.ackConfirm') : t('mcp.ack')}
                              </Button>
                            </div>
                          ) : null}
                          {unscanned ? (
                            <div className="text-[11px] text-[color:var(--warning)]">
                              {t('mcp.unscannedHint')}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        busy={busy === server.id}
                        disabled={!dirty}
                        onClick={() => void saveAllowlist(server, [...sel])}
                      >
                        {t('mcp.save')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            [server.id]: server.discoveredTools
                              .filter((tool) => isGrantable(tool) || sel.has(tool.name))
                              .map((tool) => tool.name),
                          }))
                        }
                      >
                        {t('mcp.selectAllGrantable')}
                      </Button>
                      {dirty ? (
                        <Button size="sm" variant="ghost" onClick={() => clearDraft(server.id)}>
                          {t('mcp.discardDraft')}
                        </Button>
                      ) : null}
                      {grantedSet.size > 0 ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setConfirmUnassign(server)}
                        >
                          {t('mcp.unassign')}
                        </Button>
                      ) : null}
                      {saved !== null && saved.id === server.id && !dirty ? (
                        <span className="text-[11px] text-[color:var(--success)]">
                          {t('mcp.savedSummary', {
                            granted: saved.granted,
                            revoked: saved.revoked,
                          })}
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      {error !== null ? <div className="text-sm text-[color:var(--danger)]">{error}</div> : null}
      <ConfirmDialog
        open={confirmUnassign !== null}
        title={t('mcp.unassignTitle')}
        body={
          confirmUnassign !== null
            ? t('mcp.unassignBody', {
                server: confirmUnassign.name,
                count: grantedMap.get(confirmUnassign.id)?.size ?? 0,
              })
            : undefined
        }
        confirmLabel={t('mcp.unassignConfirm')}
        cancelLabel={t('mcp.cancel')}
        tone="danger"
        onCancel={() => setConfirmUnassign(null)}
        onConfirm={() => {
          const target = confirmUnassign;
          setConfirmUnassign(null);
          if (target !== null) void saveAllowlist(target, []);
        }}
      />
    </section>
  );
}
