import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  attachAllPlugins,
  ConfigValidationError,
  FALLBACK_AGENT_SLUG,
  mcpToolNameFromRef,
  type AgentGraphStore,
  type ChatSessionStore,
  type ConfigStore,
  type ContextMemoryMode,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

import type { Plugin, PluginSetupField } from '../api/admin-v1.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  classifyTeamsProvisioningError,
  type TeamsProvisioningErrorDetail,
} from '../services/teamsProvisioningJob.js';

/**
 * Phase B — minimal projection of a plugin's catalog entry surfaced to the
 * operator dashboard so it can render the B3a plugin multi-select (badge
 * + memory-scope + permissions overview) without a separate /store fetch.
 *
 * Filtered server-side to `install_state === 'installed'` so the UI does
 * not have to know which plugins are actually live.
 *
 * Note: the manifest's `setup.fields[]` lands on `Plugin.setup_fields`,
 * carrying secret AND non-secret config alike. Surfaced here under the
 * same `setup_fields` key for the B3c editor.
 */
interface AgentPluginCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: Plugin['kind'];
  readonly version: string;
  readonly multi_instance: boolean;
  readonly multi_instance_justification?: string;
  readonly privacy_class: 'strict' | 'default';
  readonly memory_reads: readonly string[];
  readonly memory_writes: readonly string[];
  readonly network_outbound: readonly string[];
  readonly setup_fields: readonly PluginSetupField[];
  /** Parent plugin ids this one inherits secrets/config from. Used by the
   *  operator dashboard to indent dependants under their parent in the
   *  plugin multi-select. */
  readonly depends_on: readonly string[];
}

/**
 * Operator-UI backend for the multi-orchestrator runtime (US9 / T037).
 *
 * Read + write surface for the operator-facing Agents dashboard at
 * `web-ui/app/operator/agents/page.tsx`. Mounted under `/api/v1` so the
 * routes are:
 *
 *   GET    /api/v1/operator/agents                       list agents + bindings + plugins
 *   POST   /api/v1/operator/agents                       create agent
 *   PATCH  /api/v1/operator/agents/:slug                 update agent (name, privacy, status)
 *   DELETE /api/v1/operator/agents/:slug                 delete agent
 *   GET    /api/v1/operator/agents/:slug/plugins         read agent plugin assignment
 *   PUT    /api/v1/operator/agents/:slug/plugins         replace agent plugin set
 *   PATCH  /api/v1/operator/agents/:slug/plugins         enable/disable ONE plugin (body: { id, enabled })
 *   GET    /api/v1/operator/agents/:slug/grants          per-agent tool grants + plugin MCP grants + grant epoch
 *   GET    /api/v1/operator/agents/:slug/context-memory  read the W5 memory-ACL rollout mode (#899)
 *   PUT    /api/v1/operator/agents/:slug/context-memory  set the W5 memory-ACL rollout mode (body: { mode })
 *   POST   /api/v1/operator/agents/:slug/teams-identity   create-or-provision Teams identity (async, W1a #860)
 *   GET    /api/v1/operator/agents/:slug/teams-identity   Teams identity provisioning status
 *   GET    /api/v1/operator/agents/:slug/teams            teams the agent's app is installed in (derived, W2a #860)
 *   POST   /api/v1/operator/agents/:slug/teams            install the agent's app into a team (async)
 *   DELETE /api/v1/operator/agents/:slug/teams/:teamId    501 — the connector publishes no uninstall
 *   PUT    /api/v1/operator/agents/:slug/bindings        replace agent channel bindings
 *   PUT    /api/v1/operator/agents/fallback              set platform fallback (body: { slug | null })
 *   POST   /api/v1/operator/agents/:slug/drain           drain + clear session snapshots
 *   POST   /api/v1/operator/agents/:slug/kill            kill all sessions for the agent
 *   POST   /api/v1/operator/agents/reload                force a registry.reload() (manual hot-reload trigger)
 *
 * Auth-gated by the parent mount (`requireAuth` on `/api/v1`). All writes
 * go through `ConfigStore` — the change emits `agents_changed` via the
 * Postgres trigger, the reload bus picks it up, the registry diffs +
 * applies. The operator never has to "save & restart"; the next request
 * already sees the new config.
 */

const AgentCreateSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  privacy_profile: z.enum(['strict', 'default']).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
});

const AgentPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  privacy_profile: z.enum(['strict', 'default']).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
});

/**
 * W5 memory-ACL rollout switch (#899).
 *
 * The union is spelled out here rather than imported as a value:
 * `ContextMemoryMode` is a TYPE-only export, and the persisted column carries
 * its own CHECK constraint (migration 0050) over the same three values. Both
 * ends validating independently is the point — an operator must not be able to
 * write a mode the runtime reads back as `off`, which is exactly the failure
 * that makes a security switch look enabled while changing nothing.
 *
 * The assignment below is a compile-time pin: it stops compiling the moment
 * this runtime union drifts from the type the orchestrator actually consumes.
 */
export const CONTEXT_MEMORY_MODES = ['off', 'enforce', 'enforce-strict'] as const;

const _contextMemoryModesPin: readonly ContextMemoryMode[] = CONTEXT_MEMORY_MODES;
void _contextMemoryModesPin;

const ContextMemorySchema = z.object({
  mode: z.enum(CONTEXT_MEMORY_MODES),
});

const AgentPluginsSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string().min(1).max(200),
      config: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    }),
  ),
});

/** W0c (#861) — single-plugin toggle. The plugin id lives in the BODY, not
 *  the path: plugin ids contain `/` (`@omadia/odoo`), which an Express path
 *  segment cannot carry without double-encoding. */
const AgentPluginToggleSchema = z.object({
  id: z.string().min(1).max(200),
  enabled: z.boolean(),
});

const AgentBindingsSchema = z.object({
  bindings: z.array(
    z.object({
      channel_type: z.string().min(1).max(64),
      channel_key: z.string().min(1).max(500),
    }),
  ),
});

const FallbackSchema = z.object({
  slug: z.string().min(1).max(64).nullable(),
});

const ResolveChannelSchema = z.object({
  channel_type: z.string().min(1).max(64),
  channel_key: z.string().min(1).max(500),
});

/** W1a (#860) — create-or-provision a Teams identity. `team_id` is the Teams
 *  team (group) id the generated app is installed into. `bot_slug` /
 *  `display_name` are only honored on FIRST creation — one identity per
 *  agent (unique agent_id), later POSTs re-run provisioning on the
 *  existing row. */
const TeamsIdentityProvisionSchema = z.object({
  team_id: z.string().min(1).max(200),
  bot_slug: z
    .string()
    .regex(
      // channel-teams' BOT_SLUG_PATTERN (teamsBotsConfig.ts): 1-63 chars —
      // a 64-char slug would provision a bot the channel plugin rejects.
      /^[a-z0-9][a-z0-9-]{0,62}$/,
      'lowercase letters, digits and dashes; must start alphanumeric; max 63 chars',
    )
    .optional(),
  display_name: z.string().min(1).max(120).optional(),
});

/** W2a (#860) — assign an EXISTING Teams identity to a team: the app is
 *  installed into `team_id` by resuming the provisioning chain. Creating the
 *  identity itself stays `POST /:slug/teams-identity`. */
const TeamsInstallSchema = z.object({
  team_id: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// W1a (#860) — Teams identity ports.
//
// Structural subsets of the modules built in parallel units of this wave:
// the `agent_teams_identities` store (migration 0049) and the
// `TeamsProvisioningJobRunner` of `services/teamsProvisioningJob.ts`. The
// router consumes them late-bound (like the config store) so it stays
// testable with stubs and degrades to 503 until the boot wiring registers
// the real implementations.
// ---------------------------------------------------------------------------

/** One `agent_teams_identities` row, camelCase — mirrors the job runner's
 *  `TeamsIdentityJobRecord` plus timestamps. `state` follows the
 *  provisioning chain: pending → app_registered → bot_created →
 *  package_built → catalog_uploaded → installed (terminal: failed). */
export interface OperatorTeamsIdentityRecord {
  readonly agentId: string;
  readonly botSlug: string;
  readonly displayName: string;
  readonly state: string;
  /** Install target of the LAST provisioning request (migration 0049 keeps a
   *  single nullable `team_id`, documented as resume evidence). It is the
   *  only team the middleware knows about — see {@link projectInstalledTeams}
   *  for why the team read model can never be plural without a schema
   *  change. */
  readonly teamId: string | null;
  readonly appId: string | null;
  readonly tenantId: string | null;
  readonly teamsAppId: string | null;
  readonly teamsAppExternalId: string | null;
  readonly lastError: string | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface OperatorTeamsIdentityStore {
  getByAgentId(
    agentId: string,
  ): Promise<OperatorTeamsIdentityRecord | undefined>;
  /** Create-if-absent. The unique agent_id constraint makes this the
   *  one-identity-per-agent gate: an existing row is returned with only the
   *  install target (`teamId`) refreshed — bot_slug/display_name of the
   *  request are NOT applied to it. A bot_slug already held by ANOTHER
   *  agent throws (409 upstream; `error.code === 'bot_slug_taken'`). */
  ensureForAgent(input: {
    readonly agentId: string;
    readonly botSlug: string;
    readonly displayName: string;
    readonly teamId?: string;
  }): Promise<OperatorTeamsIdentityRecord>;
  /** Optional: persist an enqueue failure into the row's last_error so the
   *  status endpoint can distinguish 'queueing failed' from 'just created,
   *  run in flight'. Best-effort — called from the POST fire-and-forget
   *  catch. */
  recordEnqueueFailure?(agentId: string, message: string): Promise<void>;
}

/** Structural subset of `TeamsProvisioningJobRunner` — enqueue is
 *  fire-and-forget from the route's perspective; the returned promise is
 *  the run's eventual result and is deliberately not awaited. */
export interface OperatorTeamsProvisioningRunner {
  enqueue(request: {
    readonly agentId: string;
    readonly teamId: string;
  }): Promise<unknown>;
  isRunning(agentId: string): boolean;
  /** Install target of the run currently in flight, `null` when idle. The
   *  routes need it BEFORE they touch the row: a concurrent enqueue for a
   *  DIFFERENT team is refused by the runner with a RESOLVED
   *  `{ status: 'rejected' }` result rather than a rejected promise, so a
   *  fire-and-forget caller cannot learn about the refusal in time. See
   *  {@link assertTeamRetargetAllowed}. */
  runningTeamId(agentId: string): string | null;
}

export interface OperatorTeamsIdentityDeps {
  readonly store: OperatorTeamsIdentityStore;
  readonly runner: OperatorTeamsProvisioningRunner;
  /** Live check whether the M365 connector currently publishes
   *  `teamsProvisioner@1`. POST 503s without it; GET only reports it. */
  readonly isProvisionerInstalled: () => boolean;
  /** Vault ref under which the bot's app password is held — surfaced by the
   *  status endpoint INSTEAD of the secret itself. Defaults to
   *  {@link defaultTeamsBotSecretRef} (the connector's deterministic ref).
   *  Only consulted once the identity carries an `appId`. */
  readonly clientSecretRef?: (record: OperatorTeamsIdentityRecord) => string;
}

/**
 * Custody convention for the provisioned bot's app password: the
 * `agent_teams_identities` table stores NO secret material — the M365
 * connector's `createAppRegistration` keeps the generated client secret in
 * the CONNECTOR's vault and hands back only the opaque, deterministic ref
 * `teams_bot_password:<appId>` (teamsProvisioner contract v0.3.1). The
 * status endpoint re-derives that ref from `app_id` so channel-teams'
 * `teams_bots[]` sync (follow-up, out of scope for W1a) can reference it
 * without the secret ever appearing in an HTTP response or a middleware
 * table. Keyed by appId (globally unique per registration), NOT by bot
 * slug, so no two identities can ever alias one credential.
 */
export function defaultTeamsBotSecretRef(record: {
  readonly appId: string | null;
}): string {
  if (!record.appId) {
    throw new Error(
      'defaultTeamsBotSecretRef requires a provisioned appId — the secret ref is derived from it',
    );
  }
  return `teams_bot_password:${record.appId}`;
}

/**
 * One `teams_bots[]` entry of channel-teams' plugin config — shaped EXACTLY
 * like a `parseTeamsBotsConfig` entry (camelCase keys), so an operator can
 * paste it into the plugin's `teams_bots` setup field verbatim.
 */
export interface TeamsBotConfigProjection {
  readonly botSlug: string;
  readonly displayName: string;
  readonly appId: string;
  /** Literal — the epic provisions SingleTenant apps only (new MultiTenant
   *  registrations are deprecated since 07/2025). */
  readonly appType: 'SingleTenant';
  readonly tenantId: string;
  /** Opaque connector-vault ref (teamsProvisioner contract v0.3.1), NEVER
   *  the password itself. */
  readonly appPasswordSecretRef: string;
}

/**
 * THE single `teams_bot` projection of this router (W2a, epic #860).
 *
 * Every team↔agent route that surfaces a provisioned identity must project
 * through here rather than re-assembling the block: the entry is a config
 * contract with channel-teams, and a second, drifting copy of it would hand
 * operators a config that silently does not parse.
 *
 * `null` until BOTH the Entra app and its tenant are known — an incomplete
 * entry is worse than none, because channel-teams would reject the whole
 * `teams_bots[]` array over it.
 *
 * NOTE (documented follow-up, deliberately out of scope): pasting the block
 * into channel-teams is a MANUAL operator step. Nothing here syncs it into
 * the plugin's config automatically.
 */
export function projectTeamsBotConfig(
  record: OperatorTeamsIdentityRecord,
  clientSecretRef?: (record: OperatorTeamsIdentityRecord) => string,
): TeamsBotConfigProjection | null {
  if (!record.appId || !record.tenantId) return null;
  return {
    botSlug: record.botSlug,
    displayName: record.displayName,
    appId: record.appId,
    appType: 'SingleTenant',
    tenantId: record.tenantId,
    appPasswordSecretRef:
      clientSecretRef?.(record) ?? defaultTeamsBotSecretRef(record),
  };
}

/** Structured form of the identity's `last_error`, decoded by the runner's
 *  own classifier so the UI renders from a code + typed arguments instead of
 *  parsing English. `null` while the row carries no error. */
export function projectTeamsIdentityErrorDetail(
  record: OperatorTeamsIdentityRecord,
): TeamsProvisioningErrorDetail | null {
  return record.lastError ? classifyTeamsProvisioningError(record.lastError) : null;
}

// ---------------------------------------------------------------------------
// W2a (#860) — team↔agent read model.
//
// SCOPE GATE, recorded here because the shape below looks like an oversight
// until you know why it is one entry:
//
//   * migration 0049 is one-identity-per-agent (`PRIMARY KEY (agent_id)`)
//     with a SINGLE nullable `team_id` column, documented as "the install
//     target of the last provisioning request — resume evidence". An install
//     SET would need N rows, i.e. a new table — and this wave is routes-only,
//     no schema change.
//   * the `teamsProvisioner@1` accessor (platform/teamsProvisionerService.ts)
//     exposes createAppRegistration / createBot / buildAppPackage /
//     uploadToCatalog / getCatalogApp / installToTeam. There is NO
//     installation-listing method, so the set cannot be enumerated live
//     either; `getCatalogApp` proves tenant-CATALOG presence, never a team
//     install, and answering with it would assert something the connector
//     never told us.
//
// So the read model is DERIVED from the identity row and says so in every
// entry (`evidence: 'identity_row'`). It reports at most one team, and the
// route advertises that limit through `capabilities` instead of letting the
// operator UI infer it from an array that never grows.
// ---------------------------------------------------------------------------

/** One team an agent's Teams app is known to be installed in. */
export interface InstalledTeamProjection {
  /** Teams team (group) id. */
  readonly team_id: string;
  /** Catalog id of the installed app, when the upload step already ran. */
  readonly teams_app_id: string | null;
  /** Row timestamp of the write that recorded the install — NOT a Graph
   *  timestamp; the connector reports none. `null` when the store port
   *  carries no timestamps. */
  readonly installed_at: Date | null;
  /** Where the entry comes from. Derived, never enumerated — see the section
   *  comment above. */
  readonly evidence: 'identity_row';
}

/**
 * The teams an agent's app is installed in, derived from its identity row.
 *
 * Empty until the chain reaches `installed`: a recorded `team_id` on an
 * earlier state is the TARGET of a run in flight, not an install, and
 * reporting it as one would have the operator UI claim a Teams install that
 * Graph may have never performed.
 */
export function projectInstalledTeams(
  record: OperatorTeamsIdentityRecord,
): readonly InstalledTeamProjection[] {
  if (record.state !== 'installed' || !record.teamId) return [];
  return [
    {
      team_id: record.teamId,
      teams_app_id: record.teamsAppId,
      installed_at: record.updatedAt ?? null,
      evidence: 'identity_row',
    },
  ];
}

/** What the operator router can actually do with team↔agent assignment. Sent
 *  with the read model so the UI disables what the platform cannot do instead
 *  of discovering it from a failed request. */
export interface TeamsAssignmentCapabilities {
  /** Install into a team by resuming the provisioning chain. */
  readonly install: boolean;
  /** Remove an install — the connector publishes no uninstall method. */
  readonly uninstall: boolean;
  /** Enumerate installs live — the connector publishes no listing method. */
  readonly enumerate: boolean;
  /** Track more than one team per agent — migration 0049 stores one. */
  readonly multi_team: boolean;
  /** Why a `false` above is false, keyed by capability. */
  readonly unsupported_reason: Readonly<Record<string, string>>;
}

export const TEAMS_ASSIGNMENT_CAPABILITIES: TeamsAssignmentCapabilities = {
  install: true,
  uninstall: false,
  enumerate: false,
  multi_team: false,
  unsupported_reason: {
    uninstall:
      'teamsProvisioner@1 publishes no uninstall method (createAppRegistration/createBot/buildAppPackage/uploadToCatalog/getCatalogApp/installToTeam only) — removing the app from a team is a manual Teams-admin step until the connector contract gains one.',
    enumerate:
      'teamsProvisioner@1 publishes no installation-listing method — the team list is derived from the agent_teams_identities row, not enumerated from Graph.',
    multi_team:
      'agent_teams_identities stores ONE team_id per agent (migration 0049) — tracking an install set needs a schema change, which is out of scope for this wave.',
  },
};

export type TeamsConsentStatus = 'granted' | 'missing' | 'unknown';

/** Admin-consent status of the tenant the identity is provisioned in. */
export interface TeamsConsentProjection {
  readonly status: TeamsConsentStatus;
  /** Scopes still awaiting admin consent (`status === 'missing'`). */
  readonly missing_scopes: readonly string[];
  /** What the verdict rests on — no live probe exists (see the section
   *  comment above), so it is either the recorded failure or the progress
   *  the chain provably made. */
  readonly source: 'last_error' | 'provisioning_state' | 'none';
}

/** States the chain only reaches AFTER a Graph call that needs consented
 *  application permissions has succeeded — the only positive evidence the
 *  middleware has that consent was granted. */
const CONSENTED_EVIDENCE_STATES: ReadonlySet<string> = new Set([
  'catalog_uploaded',
  'installed',
]);

/**
 * Consent status of one identity.
 *
 * The connector's typed errors (`ConsentMissingError` → `missingScopes`) are
 * caught where they are thrown — inside the provisioning runner, which is the
 * single writer of `last_error` — so this projection reads them back through
 * the runner's own classifier instead of re-deriving the taxonomy. It never
 * claims `granted` without evidence: only a state the chain could not have
 * reached with missing consent counts.
 */
export function projectTeamsConsent(
  record: OperatorTeamsIdentityRecord,
): TeamsConsentProjection {
  const detail = projectTeamsIdentityErrorDetail(record);
  if (detail?.code === 'consent_missing') {
    return {
      status: 'missing',
      missing_scopes: detail.scopes ?? [],
      source: 'last_error',
    };
  }
  if (CONSENTED_EVIDENCE_STATES.has(record.state)) {
    return { status: 'granted', missing_scopes: [], source: 'provisioning_state' };
  }
  return { status: 'unknown', missing_scopes: [], source: 'none' };
}

/**
 * Refuse a team retarget that would leave the row asserting an install that
 * never happened (W2a, epic #860).
 *
 * `agent_teams_identities` keeps ONE `team_id` (migration 0049) and
 * `teamsProvisioner@1` publishes no uninstall, so two writers can corrupt the
 * team read model:
 *
 *  - an already-`installed` row — overwriting `team_id` leaves the real
 *    install in the old team with nothing recording it, and
 *    {@link projectInstalledTeams} would then publish the NEW team as
 *    installed on the strength of that column alone;
 *  - a run in flight toward another team — `installToTeam` uses the teamId
 *    captured at enqueue, so the app lands in the OLD team while the row
 *    claims the new one. The runner does refuse the second enqueue, but as a
 *    RESOLVED `{ status: 'rejected' }` result, which a fire-and-forget caller
 *    cannot observe before it answers 202.
 *
 * Both are refused with 409 BEFORE any store write. Returns `true` when the
 * response has been sent — the caller must return immediately.
 */
export function refuseConflictingTeamRetarget(
  res: Response,
  deps: OperatorTeamsIdentityDeps,
  agent: { readonly id: string; readonly slug: string },
  row: OperatorTeamsIdentityRecord,
  requestedTeamId: string | undefined,
): boolean {
  if (requestedTeamId === undefined) return false;

  if (
    row.state === 'installed' &&
    row.teamId !== null &&
    row.teamId !== requestedTeamId
  ) {
    res.status(409).json({
      error: 'team_install_conflict',
      message: `agent '${agent.slug}' is already installed in team '${row.teamId}' — one team per agent is all migration 0049 records, and the connector publishes no uninstall, so switching teams would leave an untracked install behind.`,
      installed_team_id: row.teamId,
      requested_team_id: requestedTeamId,
    });
    return true;
  }

  const inFlightTeamId = deps.runner.runningTeamId(agent.id);
  if (inFlightTeamId !== null && inFlightTeamId !== requestedTeamId) {
    res.status(409).json({
      error: 'team_install_conflict',
      message: `a provisioning run targeting team '${inFlightTeamId}' is already in flight for agent '${agent.slug}' — wait for it to finish, then re-run for team '${requestedTeamId}'.`,
      pending_team_id: inFlightTeamId,
      requested_team_id: requestedTeamId,
    });
    return true;
  }

  return false;
}

/** A `{ status: 'rejected' }` run result carries its reason in `detail`. The
 *  runner RESOLVES with it instead of rejecting, so a bare `.catch()` would
 *  drop it silently. */
function rejectedRunDetail(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as { status?: unknown; detail?: unknown; reason?: unknown };
  if (record.status !== 'rejected') return null;
  if (typeof record.detail === 'string') return record.detail;
  if (typeof record.reason === 'string') return `provisioning run refused: ${record.reason}`;
  return 'provisioning run refused';
}

/**
 * Start (or resume) the provisioning chain without awaiting the run.
 *
 * Fire-and-forget by design — the chain takes minutes — but NOT fire-and-
 * forget-the-outcome: a refusal arrives as a resolved `{status:'rejected'}`
 * and a stub/regression bug arrives as a rejection. Both are funnelled into
 * `recordEnqueueFailure`, so the status endpoint can say WHY nothing is
 * running instead of looking like a healthy just-enqueued row. A run that
 * merely FAILS is not recorded here — the runner already wrote `last_error`
 * with far better detail.
 */
function startProvisioningRun(
  deps: OperatorTeamsIdentityDeps,
  agent: { readonly id: string; readonly slug: string },
  teamId: string,
): void {
  void Promise.resolve(deps.runner.enqueue({ agentId: agent.id, teamId }))
    .then((result: unknown) => {
      const refused = rejectedRunDetail(result);
      if (refused === null) return;
      console.warn(
        `[operator-agents] teams provisioning for '${agent.slug}' was refused: ${refused}`,
      );
      void deps.store
        .recordEnqueueFailure?.(agent.id, refused)
        .catch(() => undefined);
    })
    .catch((err: unknown) => {
      console.error(
        `[operator-agents] teams provisioning enqueue for '${agent.slug}' failed:`,
        err,
      );
      void deps.store
        .recordEnqueueFailure?.(
          agent.id,
          err instanceof Error ? err.message : String(err),
        )
        .catch(() => undefined);
    });
}

/** Derive a URL- and Azure-safe default bot slug from an agent slug.
 *  Bounds and charset follow channel-teams' BOT_SLUG_PATTERN (max 63); the
 *  dash-trim runs AFTER the length cut so a truncation can never leave a
 *  trailing separator. */
function deriveBotSlug(agentSlug: string): string {
  const slug = agentSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'agent';
}

export interface OperatorAgentsRouterOptions {
  /** Late-bound lookups so the router survives orchestrator-plugin
   *  re-activation. Each returns undefined when the orchestratorRegistry
   *  service is not currently published (no DATABASE_URL / first boot
   *  before migrations) — routes 503 in that case. */
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly getChatSessionStore: () => ChatSessionStore | undefined;
  /** Phase B — kernel-owned plugin catalog + installed-registry pair.
   *  Used by `/plugin-catalog` (B3a multi-select), `/resolve-channel`
   *  (B3b routing tester surfaces installed channel-kind ids), and
   *  `/fallback/rehydrate` (B3d). Optional so the router stays usable
   *  in tests that build it with a bare config store. */
  readonly getPluginCatalog?: () => PluginCatalog | undefined;
  readonly getInstalledRegistry?: () => InstalledRegistry | undefined;
  /** W0c (#861) — grant read model for the agent detail page. Late-bound like
   *  the config store; `GET /:slug/grants` 503s when absent (tests / minimal
   *  mounts, or no DATABASE_URL). Read-only: this router never writes through
   *  the graph store. */
  readonly getAgentGraphStore?: () => AgentGraphStore | undefined;
  /** W1a (#860) — Teams identity provisioning dependencies (identity store +
   *  job runner + provisioner availability). Late-bound like the config
   *  store; the teams-identity routes 503 while it returns undefined (boot
   *  wiring not registered yet, tests / minimal mounts). */
  readonly getTeamsIdentity?: () => OperatorTeamsIdentityDeps | undefined;
}

export function createOperatorAgentsRouter(
  options: OperatorAgentsRouterOptions,
): Router {
  const router = Router();

  function svc(): {
    store: ConfigStore;
    registry: OrchestratorRegistry;
  } | undefined {
    const store = options.getConfigStore();
    const registry = options.getRegistry();
    if (!store || !registry) return undefined;
    return { store, registry };
  }

  function unavailable(res: Response): void {
    res.status(503).json({
      error: 'multi_orchestrator_unavailable',
      message:
        'orchestratorRegistry@1 is not published — DATABASE_URL must be set and the orchestrator plugin must be active.',
    });
  }

  function slugParam(req: Request, res: Response): string | undefined {
    const raw = req.params['slug'];
    if (typeof raw !== 'string' || raw.length === 0) {
      res.status(400).json({ error: 'invalid_slug' });
      return undefined;
    }
    return raw;
  }

  function badRequest(res: Response, err: unknown): void {
    if (err instanceof ConfigValidationError) {
      res.status(409).json({ error: 'config_validation', message: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'invalid_body',
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    console.error('[operator-agents]', err);
    res.status(500).json({ error: 'internal', message: (err as Error).message });
  }

  // ── enabled list (chat-picker surface) ──────────────────────────────
  // Phase A — minimal-metadata list of enabled Agents for the chat
  // picker. Does NOT reveal plugin/binding internals; if a future role
  // split lands, this endpoint stays available to authenticated
  // operators while `GET /` becomes admin-only.
  router.get('/enabled', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const [agents, settings] = await Promise.all([
        live.store.listAgents(),
        live.store.getPlatformSettings(),
      ]);
      res.json({
        agents: agents
          .filter((a) => a.status === 'enabled')
          .map((a) => ({
            slug: a.slug,
            name: a.name,
            description: a.description,
            privacy_profile: a.privacyProfile,
            is_fallback: a.id === settings.fallbackAgentId,
          })),
        fallback_slug:
          agents.find((a) => a.id === settings.fallbackAgentId)?.slug ?? null,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── list ────────────────────────────────────────────────────────────
  router.get('/', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const [agents, plugins, bindings, settings] = await Promise.all([
        live.store.listAgents(),
        live.store.listAllAgentPlugins(),
        live.store.listChannelBindings(),
        live.store.getPlatformSettings(),
      ]);
      const pluginsByAgent = groupBy(plugins, (p) => p.agentId);
      const bindingsByAgent = groupBy(bindings, (b) => b.agentId);
      const active = new Set(live.registry.list().map((a) => a.agent.id));
      res.json({
        agents: agents.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          privacy_profile: a.privacyProfile,
          status: a.status,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
          active: active.has(a.id),
          memory_scope:
            live.registry.get(a.slug)?.memoryScope.slice() ?? [],
          plugins: (pluginsByAgent.get(a.id) ?? []).map((p) => ({
            id: p.pluginId,
            config: p.config,
            enabled: p.enabled,
          })),
          bindings: (bindingsByAgent.get(a.id) ?? []).map((b) => ({
            channel_type: b.channelType,
            channel_key: b.channelKey,
          })),
        })),
        fallback_agent_id: settings.fallbackAgentId,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── create ──────────────────────────────────────────────────────────
  router.post('/', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentCreateSchema.parse(req.body);
      const created = await live.store.createAgent({
        slug: body.slug,
        name: body.name,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.privacy_profile
          ? { privacyProfile: body.privacy_profile }
          : {}),
        ...(body.status ? { status: body.status } : {}),
      });
      await live.registry.reload();
      res.status(201).json({ id: created.id, slug: created.slug });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── update ──────────────────────────────────────────────────────────
  router.patch('/:slug', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentPatchSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // The fallback orchestrator (the auto-seeded `fallback` slug, and/or
      // whatever the platform currently points at) must stay enabled — it is
      // the catch-all for unbound channel traffic. Disabling it would strand
      // every un-routed turn.
      if (body.status === 'disabled') {
        const settings = await live.store.getPlatformSettings();
        if (
          existing.slug === FALLBACK_AGENT_SLUG ||
          existing.id === settings.fallbackAgentId
        ) {
          res.status(409).json({ error: 'fallback_protected' });
          return;
        }
      }
      await live.store.updateAgent(existing.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.privacy_profile
          ? { privacyProfile: body.privacy_profile }
          : {}),
        ...(body.status ? { status: body.status } : {}),
      });
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── delete ──────────────────────────────────────────────────────────
  router.delete('/:slug', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Refuse to delete the fallback orchestrator (auto-seeded `fallback`
      // slug, and/or the active platform fallback). It is the safety net for
      // unbound channel traffic; deleting it would hard-reject those turns.
      const settings = await live.store.getPlatformSettings();
      if (
        existing.slug === FALLBACK_AGENT_SLUG ||
        existing.id === settings.fallbackAgentId
      ) {
        res.status(409).json({ error: 'fallback_protected' });
        return;
      }
      await live.store.deleteAgent(existing.id);
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── context-memory rollout switch (W5 memory-ACL, #899) ─────────────
  // `agents.context_memory` (migration 0050) shipped as a bare column: the
  // only way to enable the ACL was a hand-written UPDATE. These two routes
  // are the supported path.
  //
  // Read and write are separate endpoints rather than fields on
  // `PATCH /:slug` on purpose. That handler is the dashboard's rename/enable
  // surface and sends whatever the form holds; folding a security switch into
  // it would let an unrelated edit carry a memory-scope change along with it.
  router.get('/:slug/context-memory', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Deny-default read: the store already narrows an unknown/NULL column to
      // `'off'`, and repeating it here keeps the UI from rendering a mode the
      // runtime would not honour.
      const mode: ContextMemoryMode = normalizeContextMemoryMode(
        agent.contextMemory,
      );
      res.json({ slug: agent.slug, mode, modes: CONTEXT_MEMORY_MODES });
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.put('/:slug/context-memory', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = ContextMemorySchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const previous = normalizeContextMemoryMode(agent.contextMemory);
      await live.store.updateAgent(agent.id, { contextMemory: body.mode });
      // Same reload contract as every other write on this router: the running
      // registry rebuilds the agent's `MemoryBinder` with the new mode, so the
      // next turn is already scoped. Without it the switch would only take
      // effect on the next process restart.
      await live.registry.reload();
      if (previous !== body.mode) {
        // Memory-scope changes are the kind of change an incident review wants
        // to find in the log, so it gets the shared security-audit prefix.
        console.warn(
          `[security-audit] context_memory ${previous} -> ${body.mode} for agent ${agent.slug}`,
        );
      }
      res.json({ ok: true, mode: body.mode });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── read plugin assignment (W0c, #861) ──────────────────────────────
  // Per-agent read so the agent detail page can render the assignment
  // without filtering the full GET / dashboard payload. Same row shape as
  // the `plugins` array on GET /.
  router.get('/:slug/plugins', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [settings, plugins] = await Promise.all([
        live.store.getPlatformSettings(),
        live.store.listAgentPlugins(existing.id),
      ]);
      res.json({
        slug: existing.slug,
        fallback: settings.fallbackAgentId === existing.id,
        plugins: plugins.map((p) => ({
          id: p.pluginId,
          config: p.config,
          enabled: p.enabled,
        })),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── toggle ONE plugin (W0c, #861) ───────────────────────────────────
  // Single-flag flip so the UI does not have to PUT the whole replace-set
  // just to enable/disable one plugin (a stale PUT would silently drop
  // assignments made in another tab). Body: { id, enabled }.
  //
  //   row exists          → upsert with the CURRENT config, new enabled flag
  //   missing + enabled   → assign (empty config, like a fresh multi-select add)
  //   missing + disabled  → 404 plugin_not_assigned (nothing to disable)
  router.patch('/:slug/plugins', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentPluginToggleSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Phase B contract (same invariant as PUT /:slug/plugins): the fallback
      // Agent always runs plugins with the global store config — per-Agent
      // config overrides are reserved for named Agents.
      const settings = await live.store.getPlatformSettings();
      const isFallback = settings.fallbackAgentId === existing.id;
      const current = await live.store.listAgentPlugins(existing.id);
      const row = current.find((p) => p.pluginId === body.id);
      if (!row && !body.enabled) {
        res.status(404).json({ error: 'plugin_not_assigned' });
        return;
      }
      // upsertAgentPlugin overwrites config on conflict — pass the existing
      // config through so a toggle never wipes a per-Agent configuration.
      const config = isFallback ? {} : (row?.config ?? {});
      await live.store.upsertAgentPlugin(existing.id, {
        pluginId: body.id,
        config,
        enabled: body.enabled,
      });
      await live.registry.reload();
      res.json({
        ok: true,
        fallback: isFallback,
        plugin: { id: body.id, enabled: body.enabled },
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── per-agent grant read model (W0c, #861) ──────────────────────────
  // One response for the agent detail page: the agent's `agent_tool_grants`
  // rows — held directly OR by one of its sub-agents, matching the graph
  // reads' attribution rule; `sub_agent_id` tells the rows apart — (grant
  // epoch included — bumpMcpGrantEpoch stamps config.verdictEpoch, surfaced
  // as `grant_epoch`) plus the `plugin_mcp_grants` of every plugin assigned
  // to the agent. `tool_ref` is normalized via `mcpToolNameFromRef` (the
  // stored ref may carry a '<serverName>:' prefix; every other reader
  // normalizes too) so clients can compare it against discovered tool names
  // verbatim. Read-only; grant WRITES stay on the agent-builder router
  // (/api/v1/operator/mcp-grants).
  router.get('/:slug/grants', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const graph = options.getAgentGraphStore?.();
    if (!graph) {
      res.status(503).json({
        error: 'agent_graph_store_unavailable',
        message:
          'agentGraphStore not wired into the operator-agents router.',
      });
      return;
    }
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [toolGrants, plugins, servers] = await Promise.all([
        graph.listToolGrantsForAgent(existing.id),
        live.store.listAgentPlugins(existing.id),
        graph.listMcpServers(),
      ]);
      const pluginGrants = await graph.listPluginMcpGrantsForPlugins(
        plugins.map((p) => p.pluginId),
      );
      const serverById = new Map(servers.map((s) => [s.id, s]));
      // Latest verdict-epoch bump across the agent's grants. Epochs are
      // `now()::text` timestamps — lexicographic max IS the latest.
      const epochs = toolGrants
        .map((g) => g.grantEpoch)
        .filter((e): e is string => typeof e === 'string');
      res.json({
        slug: existing.slug,
        grant_epoch:
          epochs.length > 0 ? epochs.reduce((a, b) => (a > b ? a : b)) : null,
        tool_grants: toolGrants.map((g) => ({
          id: g.id,
          tool_kind: g.toolKind,
          tool_ref:
            g.toolKind === 'mcp' && g.mcpServerId
              ? mcpToolNameFromRef(
                  g.toolRef,
                  serverById.get(g.mcpServerId)?.name ?? '',
                )
              : g.toolRef,
          sub_agent_id: g.subAgentId,
          mcp_server_id: g.mcpServerId,
          server_name: g.mcpServerId
            ? (serverById.get(g.mcpServerId)?.name ?? null)
            : null,
          grant_epoch: g.grantEpoch ?? null,
          created_at: g.createdAt,
        })),
        plugin_mcp_grants: pluginGrants.map((g) => ({
          plugin_id: g.pluginId,
          mcp_server_id: g.mcpServerId,
          server_name: serverById.get(g.mcpServerId)?.name ?? null,
          granted_by: g.grantedBy,
          granted_at: g.grantedAt,
        })),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── Teams identity: create-or-provision + status (W1a, #860) ────────
  // POST is ASYNC by contract: it ensures the identity row (one per agent,
  // unique agent_id) and hands the chain off to the provisioning job
  // runner, returning immediately — it never blocks on Graph/ARM. GET
  // projects the store row, including everything channel-teams'
  // `teams_bots[]` needs; the bot app password is surfaced as a
  // credential-store REF, never as secret material. Automatic sync into
  // the channel-teams plugin config is a documented follow-up, not part
  // of this wave.

  function teamsIdentity(res: Response): OperatorTeamsIdentityDeps | undefined {
    const deps = options.getTeamsIdentity?.();
    if (!deps) {
      res.status(503).json({
        error: 'teams_identity_unavailable',
        message:
          'Teams identity provisioning is not wired — the identity store and job runner register once DATABASE_URL is set and the agent-factory boot wiring ran.',
      });
      return undefined;
    }
    return deps;
  }

  router.post('/:slug/teams-identity', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      // Client errors first: a missing agent or malformed body is a 4xx even
      // while the connector is inactive — the 503 gate below only guards the
      // actual provisioning kick-off.
      const body = TeamsIdentityProvisionSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!deps.isProvisionerInstalled()) {
        // Mirror of unavailable(): the mount-level 503 shape, for the
        // provisioner capability instead of the orchestrator registry.
        res.status(503).json({
          error: 'teams_provisioner_unavailable',
          message:
            'teamsProvisioner@1 is not installed — install and activate the M365 connector plugin (>= 0.3.1) before provisioning Teams identities.',
        });
        return;
      }
      // A re-run may not silently RETARGET the install: this route writes the
      // same single `team_id` column the team read model publishes, so an
      // 'installed' row or an in-flight run toward another team is a 409 —
      // before any write. See refuseConflictingTeamRetarget.
      const current = await deps.store.getByAgentId(existing.id);
      if (
        current &&
        refuseConflictingTeamRetarget(res, deps, existing, current, body.team_id)
      ) {
        return;
      }
      let row: OperatorTeamsIdentityRecord;
      try {
        row = await deps.store.ensureForAgent({
          agentId: existing.id,
          botSlug: body.bot_slug ?? deriveBotSlug(existing.slug),
          displayName: body.display_name ?? existing.name,
          teamId: body.team_id,
        });
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'bot_slug_taken') {
          res.status(409).json({
            error: 'bot_slug_taken',
            message:
              err instanceof Error ? err.message : 'bot slug already in use',
          });
          return;
        }
        throw err;
      }
      startProvisioningRun(deps, existing, body.team_id);
      res.status(202).json({
        ok: true,
        agent: existing.slug,
        bot_slug: row.botSlug,
        state: row.state,
        // Honest signal: true only when the runner actually holds a run for
        // this agent (a rejected enqueue leaves it false).
        running: deps.runner.isRunning(existing.id),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.get('/:slug/teams-identity', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const row = await deps.store.getByAgentId(existing.id);
      if (!row) {
        res.status(404).json({ error: 'teams_identity_not_found' });
        return;
      }
      // `teams_bot` is the channel-teams `teams_bots[]` projection. It goes
      // through the router's ONE choke point so every team↔agent route
      // emits a byte-identical entry — see projectTeamsBotConfig.
      const teamsBot = projectTeamsBotConfig(row, deps.clientSecretRef);
      res.json({
        ok: true,
        agent: existing.slug,
        state: row.state,
        running: deps.runner.isRunning(existing.id),
        provisioner_installed: deps.isProvisionerInstalled(),
        identity: {
          bot_slug: row.botSlug,
          display_name: row.displayName,
          app_id: row.appId,
          tenant_id: row.tenantId,
          teams_app_id: row.teamsAppId,
          teams_app_external_id: row.teamsAppExternalId,
          // Additive (W2a): the recorded install target. The operator UI
          // needs it to re-run provisioning without asking the operator to
          // retype a team id it already has — the POST schema requires
          // `team_id` and there is no fall-back-to-stored path on the
          // server. `null` on a row created before a target was known.
          team_id: row.teamId,
          last_error: row.lastError,
          // Additive (W2a): the same failure, decoded by the runner's own
          // classifier. The UI renders from `code` + the typed arguments and
          // may show `raw` only as a secondary technical detail — it must
          // never parse the sentence itself.
          last_error_detail: projectTeamsIdentityErrorDetail(row),
          created_at: row.createdAt ?? null,
          updated_at: row.updatedAt ?? null,
        },
        teams_bot: teamsBot,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── Team ↔ agent assignment (W2a, #860) ─────────────────────────────
  // The read model is DERIVED from the identity row (see
  // projectInstalledTeams): the schema stores one team per agent and the
  // connector publishes neither an installation listing nor an uninstall,
  // so this surface reports what the middleware provably knows and
  // advertises the rest as an unsupported capability rather than guessing.

  /** Resolve agent + identity row for the team routes, answering the shared
   *  404s. `undefined` means a response was already sent. */
  async function teamsIdentityRow(
    req: Request,
    res: Response,
    live: { store: ConfigStore },
    deps: OperatorTeamsIdentityDeps,
  ): Promise<
    | { agent: { id: string; slug: string }; row: OperatorTeamsIdentityRecord }
    | undefined
  > {
    const slug = slugParam(req, res);
    if (!slug) return undefined;
    const existing = await live.store.getAgentBySlug(slug);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return undefined;
    }
    const row = await deps.store.getByAgentId(existing.id);
    if (!row) {
      res.status(404).json({
        error: 'teams_identity_not_found',
        message: `agent '${existing.slug}' has no Teams identity yet — POST /:slug/teams-identity creates one.`,
      });
      return undefined;
    }
    return { agent: { id: existing.id, slug: existing.slug }, row };
  }

  router.get('/:slug/teams', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      const found = await teamsIdentityRow(req, res, live, deps);
      if (!found) return;
      const { agent, row } = found;
      res.json({
        ok: true,
        agent: agent.slug,
        state: row.state,
        running: deps.runner.isRunning(agent.id),
        provisioner_installed: deps.isProvisionerInstalled(),
        teams: projectInstalledTeams(row),
        // The recorded install TARGET while the chain has not reached
        // 'installed' — a run in flight (or a stalled one), never an install.
        pending_team_id: row.state === 'installed' ? null : row.teamId,
        consent: projectTeamsConsent(row),
        last_error: row.lastError,
        last_error_detail: projectTeamsIdentityErrorDetail(row),
        capabilities: TEAMS_ASSIGNMENT_CAPABILITIES,
        // Same choke point as GET /:slug/teams-identity — one byte-identical
        // channel-teams `teams_bots[]` entry across every team route.
        teams_bot: projectTeamsBotConfig(row, deps.clientSecretRef),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.post('/:slug/teams', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      // Client errors first (mirrors POST /:slug/teams-identity): a malformed
      // body or an unknown agent is a 4xx even while the connector is down.
      const body = TeamsInstallSchema.parse(req.body);
      const found = await teamsIdentityRow(req, res, live, deps);
      if (!found) return;
      const { agent, row } = found;
      if (!deps.isProvisionerInstalled()) {
        res.status(503).json({
          error: 'teams_provisioner_unavailable',
          message:
            'teamsProvisioner@1 is not installed — install and activate the M365 connector plugin (>= 0.3.1) before installing an agent into a team.',
        });
        return;
      }
      if (row.state === 'installed' && row.teamId === body.team_id) {
        // Idempotent: the app is already installed in exactly this team.
        res.json({
          ok: true,
          agent: agent.slug,
          team_id: body.team_id,
          state: row.state,
          already_installed: true,
          // Honest, not assumed: a run may still be settling even though
          // the row already reads 'installed'.
          running: deps.runner.isRunning(agent.id),
        });
        return;
      }
      // Re-targeting would overwrite the ONLY team_id the schema has — for an
      // already-installed row AND for a run still in flight toward another
      // team. Both are refused before any write; see
      // refuseConflictingTeamRetarget and
      // TEAMS_ASSIGNMENT_CAPABILITIES.multi_team.
      if (refuseConflictingTeamRetarget(res, deps, agent, row, body.team_id)) {
        return;
      }
      // Record the (new) target through the store's own gate, then let the
      // provisioning runner resume the chain — it owns every Graph/ARM call
      // and every state write, including the final installToTeam.
      const updated = await deps.store.ensureForAgent({
        agentId: agent.id,
        botSlug: row.botSlug,
        displayName: row.displayName,
        teamId: body.team_id,
      });
      startProvisioningRun(deps, agent, body.team_id);
      res.status(202).json({
        ok: true,
        agent: agent.slug,
        team_id: body.team_id,
        bot_slug: updated.botSlug,
        state: updated.state,
        already_installed: false,
        running: deps.runner.isRunning(agent.id),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.delete('/:slug/teams/:teamId', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      const found = await teamsIdentityRow(req, res, live, deps);
      if (!found) return;
      // NOT implemented, and deliberately not faked: `teamsProvisioner@1`
      // publishes no uninstall, and clearing `team_id` would only make the
      // middleware forget an install that is still live in Teams. 501 (with
      // the reason) lets the operator UI render a disabled control instead of
      // interpreting a 404 as "no such route" or, worse, calling something
      // that lies. Widening the connector contract is a separate decision.
      res.status(501).json({
        error: 'teams_uninstall_unsupported',
        message: TEAMS_ASSIGNMENT_CAPABILITIES.unsupported_reason['uninstall'],
        agent: found.agent.slug,
        team_id: req.params['teamId'] ?? null,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── replace plugins ─────────────────────────────────────────────────
  router.put('/:slug/plugins', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentPluginsSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Phase B contract: the fallback Agent always runs plugins with the
      // global store config — per-Agent overrides are reserved for named
      // Agents (Agent-A talks to Odoo prod, Agent-B to Odoo staging, etc).
      // Enforce here so a client that ignored the UI restriction can not
      // still smuggle a per-Agent config into the fallback row.
      const settings = await live.store.getPlatformSettings();
      const isFallback = settings.fallbackAgentId === existing.id;
      const current = await live.store.listAgentPlugins(existing.id);
      const desired = new Set(body.plugins.map((p) => p.id));
      for (const p of current) {
        if (!desired.has(p.pluginId)) {
          await live.store.removeAgentPlugin(existing.id, p.pluginId);
        }
      }
      for (const p of body.plugins) {
        const config = isFallback ? {} : p.config;
        await live.store.upsertAgentPlugin(existing.id, {
          pluginId: p.id,
          ...(config ? { config } : {}),
          ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        });
      }
      await live.registry.reload();
      res.json({ ok: true, fallback: isFallback });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── replace bindings ────────────────────────────────────────────────
  router.put('/:slug/bindings', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentBindingsSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const current = await live.store.listChannelBindingsForAgent(existing.id);
      const desired = new Set(
        body.bindings.map((b) => `${b.channel_type}|${b.channel_key}`),
      );
      for (const b of current) {
        if (!desired.has(`${b.channelType}|${b.channelKey}`)) {
          await live.store.removeChannelBinding(b.channelType, b.channelKey);
        }
      }
      for (const b of body.bindings) {
        // createChannelBinding throws ConfigValidationError on PK collision
        // (binding already owned by another agent) — let badRequest surface it.
        try {
          await live.store.createChannelBinding(existing.id, {
            channelType: b.channel_type,
            channelKey: b.channel_key,
          });
        } catch (err) {
          if (err instanceof ConfigValidationError) {
            const own = await live.store.resolveBinding(
              b.channel_type,
              b.channel_key,
            );
            if (own?.agentId === existing.id) continue;
          }
          throw err;
        }
      }
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── fallback ────────────────────────────────────────────────────────
  router.put('/fallback', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = FallbackSchema.parse(req.body);
      if (body.slug === null) {
        await live.store.setFallbackAgentId(null);
      } else {
        const target = await live.store.getAgentBySlug(body.slug);
        if (!target) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        await live.store.setFallbackAgentId(target.id);
      }
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── manual reload trigger ───────────────────────────────────────────
  router.post('/reload', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const plan = await live.registry.reload();
      res.json({
        ok: true,
        actions: plan.actions.length,
        platform_changed: plan.platformChanged,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── force-invalidate: drain ─────────────────────────────────────────
  router.post('/:slug/drain', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const sessionStore = options.getChatSessionStore();
    if (!sessionStore) {
      res.status(503).json({
        error: 'chat_session_store_unavailable',
        message: 'chatAgent@1 not published — chatSessionStore unavailable.',
      });
      return;
    }
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const affected = await live.registry.forceInvalidate(
        slug,
        'drain',
        sessionStore,
      );
      res.json({ ok: true, affected });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── force-invalidate: kill ──────────────────────────────────────────
  router.post('/:slug/kill', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const sessionStore = options.getChatSessionStore();
    if (!sessionStore) {
      res.status(503).json({
        error: 'chat_session_store_unavailable',
        message: 'chatAgent@1 not published — chatSessionStore unavailable.',
      });
      return;
    }
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const affected = await live.registry.forceInvalidate(
        slug,
        'kill',
        sessionStore,
      );
      res.json({ ok: true, affected });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── plugin catalog (B3a multi-select source) ────────────────────────
  // Returns the installed-plugin projection the dashboard needs to render
  // the multi-select: id, name, kind, multi_instance, memory scope,
  // network egress hosts, and the manifest `setup_fields` so B3c can
  // render typed per-(Agent × plugin) config forms.
  //
  // 503s when the kernel did not wire the catalog/installed-registry
  // getters (tests / minimal mounts). Filters reference-only plugins +
  // restricts to entries actually in the installed registry — the
  // operator can only attach what is live on the platform.
  router.get('/plugin-catalog', async (_req: Request, res: Response) => {
    const catalog = options.getPluginCatalog?.();
    const installed = options.getInstalledRegistry?.();
    if (!catalog || !installed) {
      res.status(503).json({
        error: 'plugin_catalog_unavailable',
        message:
          'pluginCatalog or installedRegistry not wired into the operator-agents router.',
      });
      return;
    }
    try {
      const installedIds = new Set(installed.list().map((e) => e.id));
      const entries: AgentPluginCatalogEntry[] = catalog
        .list()
        .filter((entry) => entry.plugin.is_reference_only !== true)
        .filter((entry) => installedIds.has(entry.plugin.id))
        .map((entry) => {
          const p = entry.plugin;
          const summary = p.permissions_summary;
          return {
            id: p.id,
            name: p.name,
            kind: p.kind,
            version: p.version,
            multi_instance: p.multi_instance !== false,
            ...(p.multi_instance_justification
              ? { multi_instance_justification: p.multi_instance_justification }
              : {}),
            privacy_class: p.privacy_class,
            memory_reads: summary?.memory_reads ?? [],
            memory_writes: summary?.memory_writes ?? [],
            network_outbound: summary?.network_outbound ?? [],
            setup_fields: p.setup_fields ?? [],
            depends_on: p.depends_on ?? [],
          } satisfies AgentPluginCatalogEntry;
        });
      res.json({ items: entries });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── routing tester (B3b) ────────────────────────────────────────────
  // "Which Agent handles teams/<key>?" — returns the same decision the
  // ChannelResolver would make for an inbound webhook, without invoking
  // it. Hits an explicit binding first, then the platform fallback.
  router.post('/resolve-channel', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = ResolveChannelSchema.parse(req.body);
      const match = live.registry.resolveByChannel(
        body.channel_type,
        body.channel_key,
      );
      if (!match) {
        res.json({
          matched: null,
          via: 'none',
          message:
            'no binding for this channel and no platform fallback is configured',
        });
        return;
      }
      const settings = await live.store.getPlatformSettings();
      const via =
        match.agent.id === settings.fallbackAgentId &&
        !match.bindings.some(
          (b) =>
            b.channelType === body.channel_type &&
            b.channelKey === body.channel_key,
        )
          ? 'fallback'
          : 'binding';
      res.json({
        matched: {
          slug: match.agent.slug,
          name: match.agent.name,
          privacy_profile: match.agent.privacyProfile,
        },
        via,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── reset fallback to all installed plugins (B3d) ───────────────────
  // Re-runs the B1 catalog-attach against the CURRENT fallback Agent.
  // Consent-bearing — only invoked from an explicit operator button so
  // an operator who pruned the fallback is not silently re-granted
  // capabilities. Idempotent: upserts produce the same row shape.
  router.post('/fallback/rehydrate', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const installed = options.getInstalledRegistry?.();
    if (!installed) {
      res.status(503).json({
        error: 'installed_registry_unavailable',
        message:
          'installedRegistry not wired into the operator-agents router.',
      });
      return;
    }
    try {
      const settings = await live.store.getPlatformSettings();
      if (!settings.fallbackAgentId) {
        res.status(409).json({
          error: 'no_fallback',
          message:
            'no fallback agent is currently configured — set one before rehydrating',
        });
        return;
      }
      const fallback = (await live.store.listAgents()).find(
        (a) => a.id === settings.fallbackAgentId,
      );
      if (!fallback) {
        res.status(404).json({ error: 'fallback_missing' });
        return;
      }
      // Skip `errored` entries (validateSnapshot would reject them anyway —
      // installedRegistry treats `errored` as un-installable until the
      // operator fixes the manifest). Include `inactive` so a plugin that
      // briefly stopped activating still ends up attached.
      const pluginIds = installed
        .list()
        .filter((e) => e.status !== 'errored')
        .map((e) => e.id);
      const attached = await attachAllPlugins(
        live.store,
        fallback.id,
        pluginIds,
      );
      await live.registry.reload();
      res.json({
        ok: true,
        slug: fallback.slug,
        attached,
        requested: pluginIds.length,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  return router;
}

/**
 * Deny-default narrowing for the persisted rollout mode (#899).
 *
 * Mirrors `parseContextMemoryMode` in the orchestrator's ConfigStore: an
 * absent, NULL, or unrecognised value reads as `'off'`. Duplicated rather
 * than imported because the orchestrator keeps it private, and because the
 * read surface must never be the place where an unknown value gets promoted
 * into something the operator sees as "on".
 */
function normalizeContextMemoryMode(raw: unknown): ContextMemoryMode {
  return raw === 'enforce' || raw === 'enforce-strict' ? raw : 'off';
}

function groupBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}
