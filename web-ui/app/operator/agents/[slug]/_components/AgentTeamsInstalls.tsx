'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import {
  classifyKnownTeamsTarget,
  isSubmittableTarget,
  type KnownTeamsTarget,
} from '../../../../_lib/teamsInstallTarget';
import {
  getAgentTeams,
  installAgentTeam,
  parseInstalledTargetKind,
  parseInstalledTeamName,
  parseTeamsAssignmentCapabilities,
  parseTeamsAssignmentErrorCode,
  uninstallAgentTeam,
  type AgentTeamsDto,
  type InstalledTeamDto,
  type TeamsAssignmentCapabilityKey,
  getAgentTeamsTargets,
  type AgentTeamsTargetsDto,
} from '../../../../_lib/agents';
import { TeamsTargetField } from './TeamsTargetField';
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
 * limits. `teamsProvisioner@1` publishes no installation listing, and
 * migration 0049 records ONE `team_id` per agent, so the route ships those
 * limits as `capabilities.*` plus a reason per `false`. Every control here
 * reads that block: a `false` renders a DISABLED control with a localized
 * reason instead of a button that answers 501. An absent or partial block is
 * parsed fail-closed (`parseTeamsAssignmentCapabilities`), so a middleware
 * that never learned to report capabilities disables everything rather than
 * enabling a lie.
 *
 * That design is what made the uninstall of byte5ai/omadia#900 a no-op here:
 * the control was already wired and already read `capabilities.uninstall`,
 * so a connector that publishes `uninstallFromTeam` (>= 0.4.0) lights it up
 * on its own. `capabilities.uninstall` is now a RUNTIME verdict about the
 * INSTALLED connector rather than a constant, so the disabled state means
 * "your connector is too old" — an upgrade the operator can perform — and
 * the copy says so.
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
  // What the tenant listing said `teamId` is, while `teamId` is still exactly
  // what was picked. Cleared by any edit — see `TeamsTargetField`.
  const [known, setKnown] = useState<KnownTeamsTarget | undefined>(undefined);
  /**
   * What the operator can pick instead of type.
   *
   * `null` covers BOTH "not loaded yet" and "the directory endpoint failed",
   * and deliberately so: the picker is a convenience over a field that still
   * works, so a failure to enumerate must degrade to the field rather than to
   * an error the operator has to dismiss. The one thing never done here is
   * storing an empty list on failure — see `TeamsTargetPicker`.
   */
  const [targets, setTargets] = useState<AgentTeamsTargetsDto | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(true);
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

  /**
   * What the operator has typed, read as an install target on every keystroke.
   *
   * THE POINT OF DOING IT HERE. The field test that produced this panel ended
   * with `404 No team found with Group Id` after five provisioning steps had
   * already succeeded. Every answer arrived after the fact. Classifying while
   * they type turns the whole failure into a label under the input — and the
   * two cases that cannot be submitted (a channel id, a bare 32-hex string)
   * get told what to do instead of being allowed through.
   *
   * The server re-decides regardless; this is guidance, never authority.
   */
  // Loaded ONCE per agent, not on every poll of the panel: a tenant's teams
  // and chats do not change while somebody fills in a form, and re-enumerating
  // on each refresh would spend the connector's Graph throttling budget on a
  // list nobody is looking at any more.
  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    void getAgentTeamsTargets(slug)
      .then((dto) => {
        if (!cancelled) setTargets(dto);
      })
      .catch(() => {
        // Swallowed on purpose. The text field below is fully functional
        // without a directory, and an error banner for a failed convenience
        // would read as though the install itself were broken.
        if (!cancelled) setTargets(null);
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const target = classifyKnownTeamsTarget(teamId, known);
  const targetSubmittable = isSubmittableTarget(target);

  const installed = data?.teams ?? [];
  /**
   * A run that has not reached `installed` publishes NO team (the read model
   * only reports an install once the chain finished), so `installed.length`
   * alone leaves the whole in-flight and stalled window wide open: the
   * operator could type a second team, the route would take the
   * not-yet-installed branch, overwrite the only `team_id` column and enqueue
   * a second run — while run #1 still installs into the ORIGINAL team, which
   * nothing then records and no uninstall can remove. `pending_team_id` is the
   * field that closes it, and the panel already has it in hand.
   */
  const pendingTeamId = data?.pending_team_id ?? null;
  const canInstall =
    data !== null &&
    data.capabilities.install &&
    data.provisioner_installed &&
    pendingTeamId === null &&
    !data.running &&
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
              installed.map((team) => {
                // The NAME is the identity an operator recognises; the GUID is
                // the address. So the name leads and the id resolves beneath
                // it — and when no name was ever resolved the id takes the
                // lead line rather than being paired with an empty label.
                const name = parseInstalledTeamName(team);
                // A chat listed under a heading that says "team" is exactly
                // the confusion this feature removes — so every entry names
                // its own kind.
                const kind = parseInstalledTargetKind(team);
                return (
                  <div
                    key={team.team_id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[color:var(--border)] px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {name !== null ? (
                        <>
                          <span className="truncate text-sm font-medium text-[color:var(--fg-strong)]">
                            {name}
                          </span>
                          <span className="font-mono text-[11px] text-[color:var(--fg-muted)]">
                            {team.team_id}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-sm text-[color:var(--fg-strong)]">
                            {team.team_id}
                          </span>
                          {/* Says why there is no name, so a bare id does not
                              read as a rendering bug. The reason differs by
                              kind: a team COULD have been resolved and was
                              not, while the connector publishes no name
                              lookup for chats at all — reporting the team
                              sentence for a chat would send an operator
                              chasing a connector bug that does not exist. */}
                          <span className="text-[11px] text-[color:var(--fg-muted)]">
                            {kind === 'team'
                              ? t('teamNameUnresolved')
                              : t('chatNameUnavailable')}
                          </span>
                        </>
                      )}
                    </div>
                    <span className="rounded border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[color:var(--fg-muted)]">
                      {t(`targetKind.${kind}`)}
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
                );
              })
            )}
            {!data.capabilities.uninstall ? (
              <CapabilityNote {...unsupportedReason(data, 'uninstall')} />
            ) : null}
          </div>

          {/* `pending_team_id` is set for EVERY non-installed state, terminal
              failures included, so it alone cannot claim a run is under way.
              `running` is what separates "still working on it" from "stopped
              here" — asserting the first about the second leaves an operator
              waiting for a run that already failed. */}
          {data.pending_team_id !== null ? (
            <div className="rounded-md border border-[color:var(--border)] px-3 py-2 text-[11px] text-[color:var(--fg-muted)]">
              {data.running
                ? t('pendingHintTyped', {
                    kind: t(
                      `targetKind.${data.pending_target_kind ?? 'team'}`,
                    ),
                    teamId: data.pending_team_id,
                  })
                : t('pendingStoppedHint', { teamId: data.pending_team_id })}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border)] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
              {t('installHeading')}
            </div>
            {/* Pick or type, plus the live verdict — shared verbatim with the
                Teams identity panel, which asks the same question when a
                target-less identity needs one before a run can start. */}
            <TeamsTargetField
              targets={targets}
              targetsLoading={targetsLoading}
              value={teamId}
              onChange={(next, knownKind) => {
                setTeamId(next);
                setKnown(
                  knownKind === undefined
                    ? undefined
                    : { id: next, kind: knownKind },
                );
              }}
              disabled={!canInstall || inFlight}
              known={known}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!canInstall || inFlight || !targetSubmittable}
                busy={busy === 'install'}
                busyLabel={t('installBusy')}
                onClick={() =>
                  void run('install', async () => {
                    const res = await installAgentTeam(
                      slug,
                      teamId.trim(),
                      known?.kind,
                    );
                    setTeamId('');
                    setKnown(undefined);
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
            {/* Only once a CHAT is actually typed: a deployment that installs
                into teams all day has no reason to be told about a connector
                version it does not need. */}
            {!data.capabilities.chat_install &&
            (target.kind === 'group-chat' || target.kind === 'one-on-one-chat') ? (
              <CapabilityNote {...unsupportedReason(data, 'chat_install')} />
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
          // Confirming a destructive action against a GUID asks the operator
          // to verify something they cannot read. Name it when we have one,
          // and keep the id in the copy either way — it is what identifies
          // the team unambiguously.
          confirmUninstall !== null
            ? parseInstalledTeamName(confirmUninstall) !== null
              ? t('uninstallBodyNamed', {
                  teamName: parseInstalledTeamName(confirmUninstall) as string,
                  teamId: confirmUninstall.team_id,
                })
              : t('uninstallBody', { teamId: confirmUninstall.team_id })
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
            const res = await uninstallAgentTeam(slug, target.team_id);
            // 'already-absent' is success, but a different truth: the app was
            // not in the team, so saying "removed" would claim an action that
            // did not happen. The record is cleared either way.
            return res.already_absent
              ? t('uninstallAlreadyAbsent', { teamId: target.team_id })
              : t('uninstalled', { teamId: target.team_id });
          });
        }}
      />
    </section>
  );
}
