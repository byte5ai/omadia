'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  bindSkillContract,
  listMcpServers,
  listSkillToolBindings,
  unbindSkillContract,
  type McpServerNode,
  type SkillContractBinding,
} from '../../_lib/agentBuilder';
import { ApiError } from '../../_lib/api';
import { Button } from '@/app/_components/ui/Button';

/**
 * Capability contracts of a skill (epic #459 W4, issue #456): shows every
 * `requires_tools` contract the skill declares and lets the operator bind it
 * to one of THEIR trusted servers' tools. Binding is the point where trust is
 * applied — a two-click confirm whose copy covers W8 auto-selection, gated
 * server-side against the scan-verdict policy. Unbound contracts fail closed
 * at runtime (skill text attaches, capability absent).
 */
export function SkillCapabilityBindings({ skillId }: { skillId: string }): React.ReactElement | null {
  const t = useTranslations('skills.capabilities');
  const [contracts, setContracts] = useState<SkillContractBinding[] | null>(null);
  const [servers, setServers] = useState<McpServerNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [pickServer, setPickServer] = useState<Record<string, string>>({});
  const [pickTool, setPickTool] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [bindings, serverList] = await Promise.all([
        listSkillToolBindings(skillId),
        listMcpServers(),
      ]);
      setContracts(bindings.contracts);
      setServers(serverList.servers.filter((s) => s.status === 'enabled'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    }
  }, [skillId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!contracts || contracts.length === 0) return null;

  async function bind(contract: string): Promise<void> {
    const serverId = pickServer[contract];
    const toolName = pickTool[contract];
    if (!serverId || !toolName) return;
    setBusy(contract);
    setError(null);
    try {
      await bindSkillContract(skillId, contract, { mcpServerId: serverId, toolName });
      setArmed(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function unbind(contract: string): Promise<void> {
    setBusy(contract);
    setError(null);
    try {
      await unbindSkillContract(skillId, contract);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border)] p-2.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--fg-muted)]">
        {t('heading')}
      </div>
      {contracts.map((c) => {
        const selectedServer = servers.find((s) => s.id === pickServer[c.contract]);
        const serverName = selectedServer?.name ?? '';
        return (
          <div key={c.contract} className="flex flex-col gap-1.5">
            <div className="text-sm">
              {c.contract}
              {c.description ? (
                <span className="text-xs text-[color:var(--fg-muted)]"> · {c.description}</span>
              ) : null}
            </div>
            {c.binding ? (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span>
                  {t('boundTo', {
                    server: c.binding.serverName ?? c.binding.mcpServerId,
                    tool: c.binding.toolName,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy === c.contract}
                  onClick={() => void unbind(c.contract)}
                >
                  {t('unbind')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={pickServer[c.contract] ?? ''}
                  onChange={(e) => {
                    setPickServer((p) => ({ ...p, [c.contract]: e.target.value }));
                    setPickTool((p) => ({ ...p, [c.contract]: '' }));
                    setArmed(null);
                  }}
                  className="rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">{t('pickServer')}</option>
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  value={pickTool[c.contract] ?? ''}
                  onChange={(e) => {
                    setPickTool((p) => ({ ...p, [c.contract]: e.target.value }));
                    setArmed(null);
                  }}
                  disabled={!selectedServer}
                  className="rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">{t('pickTool')}</option>
                  {(selectedServer?.discoveredTools ?? []).map((tool) => (
                    <option key={tool.name} value={tool.name}>
                      {tool.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant={armed === c.contract ? 'danger' : 'secondary'}
                  busy={busy === c.contract}
                  disabled={!pickServer[c.contract] || !pickTool[c.contract]}
                  onClick={() => {
                    if (armed !== c.contract) {
                      setArmed(c.contract);
                      return;
                    }
                    void bind(c.contract);
                  }}
                >
                  {armed === c.contract ? t('bindConfirm') : t('bind')}
                </Button>
              </div>
            )}
            {armed === c.contract && serverName !== '' ? (
              <p className="rounded-md border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 px-2 py-1.5 text-xs text-[color:var(--warning)]">
                {t('bindWarning', { server: serverName })}
              </p>
            ) : null}
          </div>
        );
      })}
      {error ? <p className="text-xs text-[color:var(--danger)]">{error}</p> : null}
    </div>
  );
}
