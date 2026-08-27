'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  getAgentTeamsIdentity,
  isTerminalTeamsProvisioningState,
  parseTeamsIdentityErrorCode,
  parseTeamsIdentityLastErrorDetail,
  provisionAgentTeamsIdentity,
  type TeamsIdentityStatusDto,
} from '../../../../_lib/agents';
import {
  formatTeamsBotsConfig,
  parseTeamsIdentityEnvelope,
} from '../../../../_lib/teamsIdentity';
import { humanizeApiError } from '../../_components/AgentsDashboard';
import {
  Fact,
  formatTimestamp,
  LastError,
  StateBadge,
  StateChain,
  TextField,
} from './AgentTeamsIdentityParts';

/**
 * Epic #860, wave W2a — the Teams bot identity of ONE orchestrator: create
 * it, kick off provisioning, and watch the state machine advance live.
 *
 * Two endpoints, both already on main (`routes/operatorAgents.ts`):
 * `POST .../teams-identity` is create-if-absent plus a fire-and-forget run
 * (202), `GET .../teams-identity` is the status projection this panel polls.
 *
 * FOUR NON-ERRORS the panel must not alarm about, because each is a normal
 * deployment posture rather than a failure:
 *   - 404 `teams_identity_not_found` — no row yet; that IS the create form's
 *     trigger, so it renders the form instead of an alert.
 *   - 503 `teams_identity_unavailable` — the identity store / job runner did
 *     not register (no DATABASE_URL, or the factory boot wiring never ran).
 *   - 503 `teams_provisioner_unavailable` — `teamsProvisioner@1` is missing;
 *     install the M365 connector (>= 0.3.1). An install step, not a fault.
 *   - a `last_error` on a NON-terminal state — the runner parked the run and
 *     will resume; polling continues.
 *
 * POLLING. Only `installed` and `failed` end a run
 * ({@link isTerminalTeamsProvisioningState}), so the interval is keyed on the
 * current non-terminal state: it survives repeated polls that return the same
 * state, restarts cleanly on a transition, and is torn down both on reaching a
 * terminal state and on unmount. `aliveRef` keeps an in-flight poll that
 * resolves after unmount from writing into a dead component.
 *
 * ERROR COPY. `last_error` is a full English sentence written by the job
 * runner. It is NOT parsed here: the middleware classifies it server-side,
 * next to the code that writes it, and emits `identity.last_error_detail`.
 * This panel renders that structured code through i18n with ICU arguments and
 * keeps the raw sentence behind a "technical detail" disclosure — an
 * English-sentence parser in web-ui would degrade silently in production the
 * day a message is reworded, while a colocated classifier breaks a unit test.
 * Route failures follow the AgentDetail pattern: machine codes narrow onto a
 * `teamsIdentity.routeErrors.*` catalogue, unknown ones hit the localized
 * fallback with the technical detail as an ICU argument (web-ui i18n hard
 * rule). `teamsIdentity.errors.*` is a DIFFERENT catalogue — the long-form
 * explanations `_lib/teamsIdentityErrors.ts` emits for a provisioning failure —
 * so the two never share a key.
 *
 * THE `teams_bots` BLOCK. The last mile of provisioning is not automated: the
 * operator pastes the block into the channel-teams `teams_bots` setup field by
 * hand. {@link TeamsBotConfigBlock} renders it and says so plainly instead of
 * letting anyone assume a sync that does not exist. Automatic config sync is
 * out of scope here and documented as a follow-up.
 */

const POLL_INTERVAL_MS = 3000;

type BlockedCode =
  | 'teams_identity_unavailable'
  | 'teams_provisioner_unavailable';

type PanelView =
  | { readonly kind: 'loading' }
  /** No identity row yet — the create form is the whole panel. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly status: TeamsIdentityStatusDto }
  /** A capability the deployment has not wired up yet. Informational. */
  | { readonly kind: 'blocked'; readonly code: BlockedCode }
  | { readonly kind: 'error'; readonly message: string };

interface AgentTeamsIdentityProps {
  /** Slug of the orchestrator whose Teams identity is managed. */
  readonly slug: string;
}

export function AgentTeamsIdentity(
  props: AgentTeamsIdentityProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const format = useFormatter();
  const [view, setView] = useState<PanelView>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [botSlug, setBotSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [teamId, setTeamId] = useState('');
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseTeamsIdentityErrorCode(err);
      return code !== null
        ? t(`teamsIdentity.routeErrors.${code}`)
        : t('teamsIdentity.routeErrors.unknown', {
            detail: humanizeApiError(err),
          });
    },
    [t],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const status = await getAgentTeamsIdentity(props.slug);
      if (aliveRef.current) setView({ kind: 'ready', status });
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      const code = parseTeamsIdentityErrorCode(err);
      if (code === 'teams_identity_not_found') {
        setView({ kind: 'absent' });
      } else if (
        code === 'teams_identity_unavailable' ||
        code === 'teams_provisioner_unavailable'
      ) {
        setView({ kind: 'blocked', code });
      } else {
        setView({ kind: 'error', message: localizeError(err) });
      }
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keyed on the state itself, not on the status object: a poll that returns
  // an unchanged state must not tear down and rebuild the interval.
  const pollingState =
    view.kind === 'ready' && !isTerminalTeamsProvisioningState(view.status.state)
      ? view.status.state
      : null;

  useEffect(() => {
    if (pollingState === null) return undefined;
    const id = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pollingState, load]);

  async function provision(input: {
    bot_slug?: string;
    display_name?: string;
    team_id: string;
  }): Promise<void> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await provisionAgentTeamsIdentity(props.slug, input);
      if (!aliveRef.current) return;
      setNotice(t('teamsIdentity.started', { botSlug: res.bot_slug }));
      await load();
    } catch (err: unknown) {
      if (aliveRef.current) setActionError(localizeError(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // `team_id` is required by the server (TeamsIdentityProvisionSchema), so it
  // is required here too: omitting it produced a guaranteed 400 `invalid_body`
  // and the primary acceptance path never reached 202.
  const teamIdReady = teamId.trim().length > 0;

  function submitCreate(event: React.FormEvent): void {
    event.preventDefault();
    if (!teamIdReady) return;
    void provision({
      ...(botSlug.trim() ? { bot_slug: botSlug.trim() } : {}),
      ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      team_id: teamId.trim(),
    });
  }

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t('teamsIdentity.heading')}</h2>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" busy={busy} onClick={() => void load()}>
            {t('teamsIdentity.refresh')}
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
        {t('teamsIdentity.hint')}
      </p>

      {actionError && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {actionError}
        </div>
      )}
      {notice && (
        <p className="mb-3 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-2 text-xs text-[color:var(--accent)]">
          {notice}
        </p>
      )}

      {view.kind === 'loading' && (
        <p className="text-sm text-[color:var(--fg-muted)]">
          {t('teamsIdentity.loading')}
        </p>
      )}

      {view.kind === 'error' && (
        <div
          role="alert"
          className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {view.message}
        </div>
      )}

      {/* Not an error: a capability this deployment has not wired up yet. */}
      {view.kind === 'blocked' && (
        <p
          role="status"
          className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3 text-sm text-[color:var(--fg-muted)]"
        >
          {t(`teamsIdentity.notice.${view.code}`)}
        </p>
      )}

      {view.kind === 'absent' && (
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={submitCreate}>
          <p className="text-xs text-[color:var(--fg-muted)] sm:col-span-3">
            {t('teamsIdentity.createHint')}
          </p>
          <TextField
            label={t('teamsIdentity.fieldBotSlug')}
            hint={t('teamsIdentity.fieldBotSlugHint')}
            value={botSlug}
            onChange={setBotSlug}
            pattern="^[a-z0-9][a-z0-9-]*$"
          />
          <TextField
            label={t('teamsIdentity.fieldDisplayName')}
            hint={t('teamsIdentity.fieldDisplayNameHint')}
            value={displayName}
            onChange={setDisplayName}
          />
          <TextField
            label={t('teamsIdentity.fieldTeamId')}
            hint={t('teamsIdentity.fieldTeamIdHint')}
            value={teamId}
            onChange={setTeamId}
            required
          />
          <div className="sm:col-span-3">
            <Button
              type="submit"
              size="sm"
              busy={busy}
              disabled={!teamIdReady}
              busyLabel={t('teamsIdentity.submitBusy')}
            >
              {t('teamsIdentity.submit')}
            </Button>
          </div>
        </form>
      )}

      {view.kind === 'ready' && (
        <ReadyPanel
          status={view.status}
          busy={busy}
          // The server has no "as recorded" re-run: `ensureForAgent` refreshes
          // the stored team from the request and the route hands `team_id`
          // straight to the runner, so an empty body is a guaranteed 400. The
          // recorded target comes back on the status projection and is
          // resent verbatim; without one the affordance is disabled instead
          // of offered and rejected.
          onRerun={(recordedTeamId) => void provision({ team_id: recordedTeamId })}
          formatDate={(iso) => formatTimestamp(iso, format)}
        />
      )}
    </section>
  );
}

function ReadyPanel(props: {
  readonly status: TeamsIdentityStatusDto;
  readonly busy: boolean;
  readonly onRerun: (teamId: string) => void;
  readonly formatDate: (iso: string) => string;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const { status } = props;
  const detail = useMemo(
    () =>
      parseTeamsIdentityLastErrorDetail(
        status.identity.last_error_detail,
        status.identity.last_error,
      ),
    [status.identity.last_error_detail, status.identity.last_error],
  );
  // A re-run must resend the install target the server already recorded —
  // it requires `team_id` on every POST.
  const recordedTeamId =
    status.identity.team_id !== null && status.identity.team_id !== ''
      ? status.identity.team_id
      : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StateBadge state={status.state} />
        <span className="text-xs text-[color:var(--fg-muted)]">
          {status.running
            ? t('teamsIdentity.running')
            : t('teamsIdentity.idle')}
        </span>
        {isTerminalTeamsProvisioningState(status.state) && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {recordedTeamId === null && (
              <span className="text-[11px] text-[color:var(--fg-muted)]">
                {t('teamsIdentity.rerunNeedsTeam')}
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              busy={props.busy}
              disabled={recordedTeamId === null}
              busyLabel={t('teamsIdentity.submitBusy')}
              onClick={() => {
                if (recordedTeamId !== null) props.onRerun(recordedTeamId);
              }}
            >
              {t('teamsIdentity.rerun')}
            </Button>
          </div>
        )}
      </div>

      <StateChain state={status.state} />

      {detail && <LastError detail={detail} />}

      {!status.provisioner_installed && (
        <p role="status" className="text-xs text-[color:var(--fg-muted)]">
          {t('teamsIdentity.notice.teams_provisioner_unavailable')}
        </p>
      )}

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Fact label={t('teamsIdentity.botSlug')} value={status.identity.bot_slug} />
        <Fact
          label={t('teamsIdentity.displayName')}
          value={status.identity.display_name}
        />
        <Fact label={t('teamsIdentity.appId')} value={status.identity.app_id} />
        <Fact label={t('teamsIdentity.tenantId')} value={status.identity.tenant_id} />
        <Fact
          label={t('teamsIdentity.teamsAppId')}
          value={status.identity.teams_app_id}
        />
        <Fact
          label={t('teamsIdentity.teamsAppExternalId')}
          value={status.identity.teams_app_external_id}
        />
      </dl>

      <TeamsBotConfigBlock status={status} />

      {status.identity.updated_at && (
        <p className="text-[11px] text-[color:var(--fg-muted)]">
          {t('teamsIdentity.updatedAt', {
            date: props.formatDate(status.identity.updated_at),
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The `teams_bots` entry to paste into the channel-teams setup field.
 *
 * The route already emits `teams_bot` shaped EXACTLY like a
 * `parseTeamsBotsConfig` entry, so nothing is reshaped here: the payload goes
 * through {@link parseTeamsIdentityEnvelope} (which also drops a value whose
 * `appPasswordSecretRef` is not ref-shaped) and straight into
 * {@link formatTeamsBotsConfig}, key order and all. Reordering or renaming a
 * key would produce a block the plugin rejects on paste.
 *
 * `teams_bot` is `null` until `app_id` AND `tenant_id` exist — i.e. before the
 * `app_registered` step. That is a normal early state, not missing data, so it
 * gets an explanatory line rather than an empty box.
 *
 * `appPasswordSecretRef` is the opaque vault ref `teams_bot_password:<appId>`,
 * never the password. Nothing here fetches or reveals a secret value, and the
 * ref is never logged.
 */
function TeamsBotConfigBlock(props: {
  readonly status: TeamsIdentityStatusDto;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [copied, setCopied] = useState(false);

  const view = useMemo(
    () => parseTeamsIdentityEnvelope(props.status),
    [props.status],
  );
  const teamsBot = view?.teamsBot ?? null;
  const block = useMemo(
    () => (teamsBot ? formatTeamsBotsConfig([teamsBot]) : null),
    [teamsBot],
  );

  const onCopy = useCallback(async (): Promise<void> => {
    if (block === null) return;
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
    } catch {
      // Soft failure (permissions, insecure context). The block stays visible
      // and selectable right below, so it can still be copied by hand — not
      // worth an error banner.
      setCopied(false);
    }
  }, [block]);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('teamsIdentity.teamsBot.heading')}</h3>

      {teamsBot === null || block === null ? (
        <p className="text-xs text-[color:var(--fg-muted)]">
          {t('teamsIdentity.teamsBot.notReady')}
        </p>
      ) : (
        <>
          <p className="text-xs font-medium text-[color:var(--fg-strong)]">
            {t('teamsIdentity.teamsBot.manualStep')}
          </p>
          <p className="text-xs text-[color:var(--fg-muted)]">
            {t('teamsIdentity.teamsBot.instructions', { field: 'teams_bots' })}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => void onCopy()}>
              {copied
                ? t('teamsIdentity.teamsBot.copied')
                : t('teamsIdentity.teamsBot.copy')}
            </Button>
          </div>
          <pre
            aria-label={t('teamsIdentity.teamsBot.blockLabel', {
              botSlug: teamsBot.botSlug,
            })}
            className="overflow-x-auto rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3 font-mono text-[11px] text-[color:var(--fg-strong)]"
          >
            {block}
          </pre>
          <p className="text-xs text-[color:var(--fg-muted)]">
            {t('teamsIdentity.teamsBot.secretRefNote')}
          </p>
          <p className="text-xs text-[color:var(--fg-muted)]">
            {t('teamsIdentity.teamsBot.followUp')}
          </p>
        </>
      )}
    </div>
  );
}
