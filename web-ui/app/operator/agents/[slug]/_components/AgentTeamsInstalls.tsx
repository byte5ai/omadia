'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import {
  getAgentTeams,
  installAgentTeam,
  parseTeamsAssignmentCapabilities,
  parseTeamsAssignmentErrorCode,
  uninstallAgentTeam,
  type AgentTeamsDto,
  type InstalledTeamDto,
  type TeamsAssignmentCapabilityKey,
} from '../../../../_lib/agents';
import { ApiError } from '../../../../_lib/api';

/**
 * Team↔agent assignment panel (issue #866, epic #860, wave W2a).
 *
 * Reads `GET /v1/operator/agents/:slug/teams` — the DERIVED install read
 * model — and drives the two write paths the route publishes: install into a
 * team (`POST`, 202, resumes the provisioning chain) and uninstall
 * (`DELETE`).
 *
 * The panel is CAPABILITY-DRIVEN, never hard-coded to today's platform
 * limits. `teamsProvisioner@1` publishes neither an installation listing nor
 * an uninstall, and migration 0049 records ONE `team_id` per agent, so the
 * route ships those limits as `capabilities.*` plus a reason per `false`.
 * Every control here reads that block: a `false` renders a DISABLED control
 * with a localized reason instead of a button that answers 501, and the day
 * the connector contract grows an uninstall the same control lights up with
 * no change on this side. An absent or partial block is parsed fail-closed
 * (`parseTeamsAssignmentCapabilities`), so a middleware that never learned to
 * report capabilities disables everything rather than enabling a lie.
 *
 * Deliberately NOT rendered here: the provisioning state vocabulary and the
 * `last_error` remediation copy. Both belong to the Teams identity panel
 * above; this panel shows only the consent VERDICT the route derives
 * (`consent.status` + `missing_scopes`) and points at that panel for what to
 * do about it, so the wave has exactly one place with the consent copy.
 */

/** Copy for a capability the platform does not support, keyed by capability.
 *  Localized here — the route's `unsupported_reason` is an English engineering
 *  sentence and may only appear as a secondary technical detail. */
function useUnsupportedReason(): (
  data: AgentTeamsDto,
  key: TeamsAssignmentCapabilityKey,
) => { readonly text: string; readonly detail: string | null } {
  const t = useTranslations('operatorAgents.teamsInstalls');
  return useCallback(
    (data, key) => ({
      text: t(`unsupported.${key}`),
      detail: data.capabilities.unsupported_reason[key] ?? null,
    }),
    [t],
  );
}

/**
 * Render-boundary guard.
 *
 * `getAgentTeams` already normalizes at the network boundary; this repeats it
 * at the point of USE because the panel indexes into both fields on every
 * render and must not depend on a caller having done it. The parse is
 * idempotent, so this is a guard, not a second policy.
 */
function normalize(dto: AgentTeamsDto): AgentTeamsDto {
  return {
    ...dto,
    teams: Array.isArray(dto.teams) ? dto.teams : [],
    capabilities: parseTeamsAssignmentCapabilities(dto.capabilities),
  };
}

function CapabilityNote({
  text,
  detail,
}: {
  readonly text: string;
  readonly detail: string | null;
}): React.ReactElement {
  const t = useTranslations('operatorAgents.teamsInstalls');
  return (
    <div className="flex flex-col gap-0.5 text-[11px] text-[color:var(--fg-muted)]">
      <span>{text}</span>
      {detail !== null ? (
        <span className="font-mono text-[10px] opacity-70">
          {t('unsupportedTechnical', { detail })}
        </span>
      ) : null}
    </div>
  );
}

export function AgentTeamsInstalls({
  slug,
}: {
  readonly slug: string;
}): React.ReactElement {
  const t = useTranslations('operatorAgents.teamsInstalls');
  const format = useFormatter();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const unsupportedReason = useUnsupportedReason();

  const [data, setData] = useState<AgentTeamsDto | null>(null);
  /** 404 `teams_identity_not_found` — an empty state, not a failure. */
  const [noIdentity, setNoIdentity] = useState(false);
  /** 503 capability gate; informational, not an error. */
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [teamId, setTeamId] = useState('');
  const [confirmUninstall, setConfirmUninstall] =
    useState<InstalledTeamDto | null>(null);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseTeamsAssignmentErrorCode(err);
      return code !== null
        ? t(`errors.${code}`)
        : t('errors.unknown', {
            detail: err instanceof Error ? err.message : String(err),
          });
    },
    [t],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await getAgentTeams(slug);
      setData(normalize(res));
      setNoIdentity(false);
      setNotice(null);
      setLoadError(null);
    } catch (err) {
      const code = parseTeamsAssignmentErrorCode(err);
      const status = err instanceof ApiError ? err.status : 0;
      setData(null);
      if (status === 404 && code === 'teams_identity_not_found') {
        setNoIdentity(true);
        setNotice(null);
        setLoadError(null);
        return;
      }
      if (
        status === 503 &&
        (code === 'teams_identity_unavailable' ||
          code === 'teams_provisioner_unavailable')
      ) {
        setNoIdentity(false);
        setNotice(t(`notice.${code}`));
        setLoadError(null);
        return;
      }
      setNoIdentity(false);
      setNotice(null);
      setLoadError(localizeError(err));
    }
  }, [slug, t, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** One write path: run it, refresh THIS panel, then let the rest of the
   *  detail page re-fetch through the page's `router.refresh()` convention. */
  const run = useCallback(
    async (label: string, op: () => Promise<string | null>): Promise<void> => {
      setBusy(label);
      setError(null);
      setResult(null);
      try {
        const message = await op();
        setResult(message);
        await refresh();
        startTransition(() => router.refresh());
      } catch (err) {
        setError(localizeError(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh, router, localizeError],
  );

  const installed = data?.teams ?? [];
  const canInstall =
    data !== null &&
    data.capabilities.install &&
    data.provisioner_installed &&
    (installed.length === 0 || data.capabilities.multi_team);
  const inFlight = busy !== null;

  function renderConsent(view: AgentTeamsDto): React.ReactElement {
    const { consent } = view;
    const tone =
      consent.status === 'granted'
        ? 'text-[color:var(--success)]'
        : consent.status === 'missing'
          ? 'text-[color:var(--danger)]'
          : 'text-[color:var(--fg-muted)]';
    return (
      <div className="flex flex-col gap-1 rounded-md border border-[color:var(--border)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
            {t('consentHeading')}
          </span>
          <span className={`text-sm font-medium ${tone}`}>
            {t(`consentStatus.${consent.status}`)}
          </span>
        </div>
        {consent.status === 'missing' && consent.missing_scopes.length > 0 ? (
          <div className="text-[11px] text-[color:var(--fg-muted)]">
            {t('consentScopes', {
              count: consent.missing_scopes.length,
              scopes: consent.missing_scopes.join(', '),
            })}
          </div>
        ) : null}
        <div className="text-[11px] text-[color:var(--fg-muted)]">
          {t(`consentSource.${consent.source}`)}
        </div>
        {consent.status !== 'granted' ? (
          <div className="text-[11px] text-[color:var(--fg-muted)]">
            {t('consentPointer')}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-medium text-[color:var(--fg-strong)]">
          {t('heading')}
        </h2>
        <p className="mt-1 text-sm leading-[1.55] text-[color:var(--fg-muted)]">
          {t('hint')}
        </p>
      </div>

      {loadError !== null ? (
        <div role="alert" className="text-sm text-[color:var(--danger)]">
          {loadError}
        </div>
      ) : null}
      {notice !== null ? (
        <div className="rounded-md border border-[color:var(--border)] px-3 py-2 text-sm text-[color:var(--fg-muted)]">
          {notice}
        </div>
      ) : null}
      {noIdentity ? (
        <div className="text-sm text-[color:var(--fg-muted)]">
          {t('noIdentity')}
        </div>
      ) : null}
      {data === null && !noIdentity && notice === null && loadError === null ? (
        <div className="text-sm text-[color:var(--fg-muted)]">
          {t('loading')}
        </div>
      ) : null}

      {data !== null ? (
        <>
          {renderConsent(data)}

          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
              {t('installedHeading')}
            </div>
            {/* The list is DERIVED from the provisioning record. Saying so is
                capability-driven, not a constant: a connector that grows a
                listing method makes the caveat wrong, and the note goes with
                the flag that made it true. */}
            {!data.capabilities.enumerate ? (
              <CapabilityNote {...unsupportedReason(data, 'enumerate')} />
            ) : null}
            {installed.length === 0 ? (
              <div className="text-sm text-[color:var(--fg-muted)]">
                {t('installedEmpty')}
              </div>
            ) : (
              installed.map((team) => (
                <div
                  key={team.team_id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[color:var(--border)] px-3 py-2"
                >
                  <span className="font-mono text-sm text-[color:var(--fg-strong)]">
                    {team.team_id}
                  </span>
                  <span className="text-[11px] text-[color:var(--fg-muted)]">
                    {t('appIdLabel', {
                      appId: team.teams_app_id ?? t('appIdNone'),
                    })}
                  </span>
                  <span className="text-[11px] text-[color:var(--fg-muted)]">
                    {team.installed_at !== null
                      ? t('installedAt', {
                          date: format.dateTime(new Date(team.installed_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                        })
                      : t('installedAtUnknown')}
                  </span>
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="danger"
                    disabled={!data.capabilities.uninstall || inFlight}
                    busy={busy === `uninstall:${team.team_id}`}
                    busyLabel={t('uninstallBusy')}
                    onClick={() => setConfirmUninstall(team)}
                  >
                    {t('uninstall')}
                  </Button>
                </div>
              ))
            )}
            {!data.capabilities.uninstall ? (
              <CapabilityNote {...unsupportedReason(data, 'uninstall')} />
            ) : null}
          </div>

          {data.pending_team_id !== null ? (
            <div className="rounded-md border border-[color:var(--border)] px-3 py-2 text-[11px] text-[color:var(--fg-muted)]">
              {t('pendingHint', { teamId: data.pending_team_id })}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border)] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
              {t('installHeading')}
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-[color:var(--fg-muted)]">
              {t('fieldTeamId')}
              <input
                type="text"
                value={teamId}
                disabled={!canInstall || inFlight}
                onChange={(e) => setTeamId(e.target.value)}
                aria-label={t('fieldTeamId')}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 font-mono text-sm text-[color:var(--fg-strong)]"
              />
              <span>{t('fieldTeamIdHint')}</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!canInstall || inFlight || teamId.trim() === ''}
                busy={busy === 'install'}
                busyLabel={t('installBusy')}
                onClick={() =>
                  void run('install', async () => {
                    const res = await installAgentTeam(slug, teamId.trim());
                    setTeamId('');
                    return res.already_installed
                      ? t('alreadyInstalled', { teamId: res.team_id })
                      : t('installStarted', { teamId: res.team_id });
                  })
                }
              >
                {t('install')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={inFlight}
                onClick={() => void refresh()}
              >
                {t('refresh')}
              </Button>
            </div>
            {!data.provisioner_installed ? (
              <div className="text-[11px] text-[color:var(--fg-muted)]">
                {t('provisionerMissing')}
              </div>
            ) : null}
            {!data.capabilities.install ? (
              <CapabilityNote {...unsupportedReason(data, 'install')} />
            ) : null}
            {!data.capabilities.multi_team && installed.length > 0 ? (
              <CapabilityNote {...unsupportedReason(data, 'multi_team')} />
            ) : null}
          </div>
        </>
      ) : null}

      {result !== null ? (
        <div className="text-[11px] text-[color:var(--success)]">{result}</div>
      ) : null}
      {error !== null ? (
        <div role="alert" className="text-sm text-[color:var(--danger)]">
          {error}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmUninstall !== null}
        title={t('uninstallTitle')}
        body={
          confirmUninstall !== null
            ? t('uninstallBody', { teamId: confirmUninstall.team_id })
            : undefined
        }
        confirmLabel={t('uninstallConfirm')}
        cancelLabel={t('cancel')}
        tone="danger"
        onCancel={() => setConfirmUninstall(null)}
        onConfirm={() => {
          const target = confirmUninstall;
          setConfirmUninstall(null);
          if (target === null) return;
          void run(`uninstall:${target.team_id}`, async () => {
            await uninstallAgentTeam(slug, target.team_id);
            return t('uninstalled', { teamId: target.team_id });
          });
        }}
      />
    </section>
  );
}
