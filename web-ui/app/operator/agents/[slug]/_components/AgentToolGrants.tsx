'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  getAgentGrants,
  parseOperatorAgentErrorCode,
  type AgentGrantsDto,
  type AgentToolGrantRowDto,
} from '../../../../_lib/agents';
import { humanizeApiError } from '../../_components/AgentsDashboard';

type Formatter = ReturnType<typeof useFormatter>;

interface AgentToolGrantsProps {
  /** Slug of the orchestrator whose grants are listed. */
  readonly slug: string;
}

/**
 * Issue #861 (epic #860) — per-agent tool-grant list with grant-epoch
 * display, detail-page slice.
 *
 * Read-only on purpose: it renders the per-agent read model from
 * `GET /v1/operator/agents/:slug/grants` (`getAgentGrants`) — the agent's
 * own `agent_tool_grants` rows plus the `plugin_mcp_grants` of every plugin
 * assigned to it. Grant WRITES stay on the existing surfaces (`/admin/mcp`
 * grants tab and the per-agent MCP assignment editor) — spec says extend,
 * not duplicate.
 *
 * The grant epoch is NOT a column: `bumpMcpGrantEpoch` stamps
 * `config.verdictEpoch` (a `now()::text` timestamp) into the grant's JSONB
 * when a server's tool surface or verdict state changes, and agents rebuild
 * against it. A `null` epoch therefore means "never bumped", not "missing
 * data" — it renders as its own localized state instead of a dash.
 *
 * Error copy: the routes emit machine codes as `{ error: '<code>' }`.
 * `parseOperatorAgentErrorCode` narrows them and each code maps to a
 * `grants.errors.*` catalogue key; unknown failures render the localized
 * fallback sentence with the technical detail as an ICU argument — raw
 * bodies never reach the UI (web-ui i18n hard rule).
 */
export function AgentToolGrants(props: AgentToolGrantsProps): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const format = useFormatter();
  const [grants, setGrants] = useState<AgentGrantsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseOperatorAgentErrorCode(err);
      return code !== null
        ? t(`grants.errors.${code}`)
        : t('grants.errors.unknown', { detail: humanizeApiError(err) });
    },
    [t],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await getAgentGrants(props.slug);
      setGrants(res);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setBusy(false);
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t('grants.heading')}</h2>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {t('grants.epochSummary', {
            epoch:
              grants?.grant_epoch != null
                ? formatEpoch(grants.grant_epoch, format)
                : t('grants.epochNever'),
          })}
        </span>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" busy={busy} onClick={() => void refresh()}>
            {t('grants.refresh')}
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('grants.hint')}</p>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      {!grants && !error && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('grants.loading')}</p>
      )}

      {grants && (
        <>
          {grants.tool_grants.length === 0 ? (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('grants.empty')}</p>
          ) : (
            <ul className="flex flex-col">
              {grants.tool_grants.map((row) => (
                <ToolGrantRow key={row.id} row={row} format={format} />
              ))}
            </ul>
          )}

          <h3 className="mb-1 mt-4 text-sm font-medium">{t('grants.pluginHeading')}</h3>
          {grants.plugin_mcp_grants.length === 0 ? (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('grants.pluginEmpty')}</p>
          ) : (
            <ul className="flex flex-col">
              {grants.plugin_mcp_grants.map((row) => (
                <li
                  key={`${row.plugin_id}|${row.mcp_server_id}`}
                  className="flex flex-wrap items-center gap-2 border-b border-[color:var(--border)]/40 px-1 py-1.5 text-sm last:border-b-0"
                >
                  <code className="font-mono text-xs text-[color:var(--fg-strong)]">
                    {row.plugin_id}
                  </code>
                  <span aria-hidden className="text-[color:var(--fg-muted)]">
                    →
                  </span>
                  <span className="text-[color:var(--fg-strong)]">
                    {row.server_name ?? t('grants.serverRemoved')}
                  </span>
                  <span className="ml-auto text-[11px] text-[color:var(--fg-muted)]">
                    {t('grants.grantedMeta', {
                      who: row.granted_by,
                      date: formatEpoch(row.granted_at, format),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ToolGrantRow({
  row,
  format,
}: {
  readonly row: AgentToolGrantRowDto;
  readonly format: Formatter;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-[color:var(--border)]/40 px-1 py-1.5 text-sm last:border-b-0">
      <span className="rounded-full border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[color:var(--fg-muted)]">
        {t(`grants.kind.${row.tool_kind}`)}
      </span>
      <span className="text-[color:var(--fg-strong)]">{row.tool_ref}</span>
      {row.tool_kind === 'mcp' && (
        <span className="text-xs text-[color:var(--fg-muted)]">
          {row.server_name ?? t('grants.serverRemoved')}
        </span>
      )}
      <span
        className="ml-auto text-[11px] text-[color:var(--fg-muted)]"
        title={row.grant_epoch ?? undefined}
      >
        {t('grants.epochRow', {
          epoch:
            row.grant_epoch != null
              ? formatEpoch(row.grant_epoch, format)
              : t('grants.epochNever'),
        })}
      </span>
    </li>
  );
}

/**
 * Grant epochs are Postgres `now()::text` strings
 * (`2026-08-25 18:22:04.123456+02`), not ISO — normalize the separator
 * before parsing and fall back to the raw value when the string still does
 * not parse. The raw value stays meaningful: epoch staleness is compared
 * lexicographically server-side, so showing it verbatim never lies.
 */
function formatEpoch(value: string, format: Formatter): string {
  const direct = new Date(value);
  const parsed = Number.isNaN(direct.getTime())
    ? new Date(value.replace(' ', 'T'))
    : direct;
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return format.dateTime(parsed, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return value;
  }
}
