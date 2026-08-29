import { Router, raw } from 'express';
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

import {
  isChatTarget,
  resolveTeamsInstallTarget,
  TEAMS_TARGET_EXAMPLES,
  type TeamsTargetKind,
} from '../platform/teamsInstallTarget.js';
import type { Plugin, PluginSetupField } from '../api/admin-v1.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  buildBotHandle,
  classifyTeamsProvisioningError,
  TEAMS_CHAT_INSTALL_MIN_CONNECTOR_VERSION,
  type TeamsProvisioningErrorDetail,
} from '../services/teamsProvisioningJob.js';
import {
  supportsChatInstall,
  supportsTeamUninstall,
  type TeamsProvisionerAccessor,
} from '../platform/teamsProvisionerService.js';
import type { DelegatedTokenSet } from '../platform/teamsDelegatedSignIn.js';
import { loadTeamsTargetDirectory } from '../services/teamsTargetDirectoryService.js';
import {
  resetTeamsIdentity,
  TeamsIdentityResetNotFoundError,
  type TeamsResetEventSink,
  type TeamsResetIdentityRecord,
  type TeamsResetProvisionerPort,
} from '../services/teamsIdentityReset.js';
import {
  projectTeamsBotConfig,
  projectTeamsBotsConfigSyncStatus,
} from '../services/teamsBotsConfigSync.js';
import {
  AgentAvatarError,
  deriveAgentAvatar,
  MAX_AVATAR_BYTES,
} from '../services/agentAvatarIcons.js';
import {
  resolveAgentIdentity,
  type AgentIdentityAvatarBytes,
  type AgentIdentityAvatarInput,
  type AgentIdentityComposedPrompt,
  type AgentIdentityRecord,
  type AgentIdentitySaveInput,
} from '../platform/agentIdentityStore.js';
import {
  PersonaConfigSchema,
  QualityConfigSchema,
  type PersonaConfig,
  type QualityConfig,
} from '../plugins/builder/agentSpec.js';
import {
  composeAgentIdentityPrompt,
  inferFamilyFromModel,
} from '../services/agentIdentityPrompt.js';
import type { PersonaModelFamily } from '../plugins/personaDelta.js';

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
 *   DELETE /api/v1/operator/agents/:slug/teams/:teamId    remove the agent's app from a team (#900; 501 on a connector < 0.4.0)
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
  // NOT transformed to a GUID here any more. `team_id` may now name a group
  // chat or a 1:1 chat as well, and `normalizeTeamsTeamId` only knows how to
  // spell a TEAM — running it first would hyphenate the 32-hex stem of a chat
  // id into a team GUID that Graph has never heard of, which is exactly the
  // field-test failure. `resolveTeamsInstallTarget` decides the kind FIRST and
  // normalises only what is actually a team.
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
  /** See the note on {@link TeamsIdentityProvisionSchema.team_id}. */
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
  /** Kind of the target above (migration 0054). OPTIONAL on this structural
   *  mirror: a store predating the chat targets still satisfies the port and
   *  its rows mean `'team'`, the only thing they could have meant. */
  readonly targetKind?: TeamsTargetKind;
  readonly appId: string | null;
  /** The Entra app's DIRECTORY OBJECT id (migration 0055) — what the
   *  recycle-bin purge of a teardown needs, and what `appId` cannot stand in
   *  for. OPTIONAL on this structural mirror for the usual reason: a store
   *  predating the column still satisfies the port. Never surfaced in a
   *  response; it is an internal identifier, like `appId`'s secret ref. */
  readonly appObjectId?: string | null;
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
    /** Which kind of target `teamId` addresses (migration 0054). OPTIONAL on
     *  this structural mirror on purpose: a store that predates the chat
     *  targets still satisfies the port, and its rows keep meaning `'team'` —
     *  which is the only thing they could ever have meant. */
    readonly targetKind?: TeamsTargetKind;
  }): Promise<OperatorTeamsIdentityRecord>;
  /** Optional: persist an enqueue failure into the row's last_error so the
   *  status endpoint can distinguish 'queueing failed' from 'just created,
   *  run in flight'. Best-effort — called from the POST fire-and-forget
   *  catch. */
  recordEnqueueFailure?(agentId: string, message: string): Promise<void>;
  /**
   * Forget the recorded team install after a successful uninstall
   * (byte5ai/omadia#900) — the row drops back to `catalog_uploaded` with a
   * null `team_id`.
   *
   * Optional so a store implementation that predates the uninstall route
   * still satisfies this interface; the route refuses (501) rather than
   * removing an install it cannot then record as removed, because a
   * middleware that forgot the removal would keep reporting a team the app
   * is no longer in.
   */
  clearTeamInstall?(agentId: string): Promise<OperatorTeamsIdentityRecord>;
  /**
   * Return the row to `pending` with every Azure identifier cleared, keeping
   * the two fields a human typed (`botSlug`, `displayName`) — the last act of
   * a teardown.
   *
   * Optional for the same reason as {@link clearTeamInstall}, and refused the
   * same way: without it the reset route answers 501 rather than deleting
   * Azure objects it could not then forget. A middleware that removed an app
   * registration and kept a row pointing at it would send the next
   * provisioning run building a bot on an application that is gone.
   */
  resetForRetry?(agentId: string): Promise<OperatorTeamsIdentityRecord>;
  /** Persist a single field mid-teardown — today only the freshly resolved
   *  `appObjectId`, which must reach the database BEFORE the delete that
   *  makes it unlookupable. Optional, like every other write above. */
  update?(
    agentId: string,
    patch: { readonly appObjectId?: string | null },
  ): Promise<unknown>;
}

/** Structural subset of `TeamsProvisioningJobRunner` — enqueue is
 *  fire-and-forget from the route's perspective; the returned promise is
 *  the run's eventual result and is deliberately not awaited. */
export interface OperatorTeamsProvisioningRunner {
  enqueue(request: {
    readonly agentId: string;
    readonly teamId: string;
    /** #914 — re-render and re-upload the package of an already-installed
     *  identity after an identity edit. */
    readonly republish?: boolean;
  }): Promise<unknown>;
  isRunning(agentId: string): boolean;
  /** Install target of the run currently in flight, `null` when idle. The
   *  routes need it BEFORE they touch the row: a concurrent enqueue for a
   *  DIFFERENT team is refused by the runner with a RESOLVED
   *  `{ status: 'rejected' }` result rather than a rejected promise, so a
   *  fire-and-forget caller cannot learn about the refusal in time. See
   *  {@link assertTeamRetargetAllowed}. */
  runningTeamId(agentId: string): string | null;
  /**
   * Reserve this agent for an operation that is not a provisioning run, and
   * hand back the release — or `null` when it is already busy.
   *
   * The reset route needs this rather than an `isRunning` check alone,
   * because `isRunning` answers a question about the PAST instant: between
   * reading it and starting to delete an app registration, an enqueue can
   * arrive and start building on the very objects the teardown is removing.
   * The lease closes that window from the one place that knows what is in
   * flight.
   *
   * Optional so a stub runner (and every existing test) still satisfies the
   * port; the route falls back to refusing on `isRunning` alone, which is the
   * pre-teardown behaviour of every other destructive route here.
   */
  acquireExclusive?(agentId: string, label: string): (() => void) | null;
}

export interface OperatorTeamsIdentityDeps {
  readonly store: OperatorTeamsIdentityStore;
  readonly runner: OperatorTeamsProvisioningRunner;
  /** Live check whether the M365 connector currently publishes
   *  `teamsProvisioner@1`. POST 503s without it; GET only reports it. */
  readonly isProvisionerInstalled: () => boolean;
  /**
   * The live provisioner, for the operations the ROUTE performs itself
   * (today: the team uninstall of byte5ai/omadia#900). Everything in the
   * provisioning CHAIN still belongs to the job runner — this is not a
   * second path into it.
   *
   * Optional, and `undefined` is a first-class answer: a wiring that does
   * not bind it, or a connector that is not installed, both mean "no
   * uninstall", which the route reports as a capability rather than a crash.
   * `uninstallFromTeam` itself is optional on the accessor too (connector
   * >= 0.4.0), so callers go through
   * {@link supportsTeamUninstall}.
   */
  readonly getProvisioner?: () => TeamsProvisionerAccessor | undefined;
  /** Vault ref under which the bot's app password is held — surfaced by the
   *  status endpoint INSTEAD of the secret itself. Defaults to
   *  {@link defaultTeamsBotSecretRef} (the connector's deterministic ref).
   *  Only consulted once the identity carries an `appId`. */
  readonly clientSecretRef?: (record: OperatorTeamsIdentityRecord) => string;
  /**
   * The PERSISTED team↔agent bindings (`agent_teams_installs`, migration
   * 0051). Optional so a minimal mount and the router's stub-based tests keep
   * working; while it is absent the route falls back to the single derived
   * entry of {@link projectInstalledTeams} and keeps reporting
   * `multi_team: false`, i.e. exactly the pre-0051 contract.
   */
  readonly installs?: OperatorTeamsInstallStore;
  /**
   * The provisioning progress log (`agent_teams_provisioning_events`,
   * migration 0053, #915). Optional — see
   * {@link OperatorTeamsEventStore}.
   */
  readonly events?: OperatorTeamsEventStore;
  /**
   * Resolve one team id to its Graph display name (`teamsProvisioner@1`
   * >= 0.5.0), or `null` when the connector cannot answer. Optional and
   * best-effort: a name is decoration on a binding the route already knows,
   * never a precondition for reporting it.
   */
  readonly resolveTeamName?: (teamId: string) => Promise<string | null>;
  /**
   * Render this identity's Teams app package ON DEMAND (byte5ai/omadia#924).
   *
   * BUILT PER REQUEST, NEVER STORED. A package saved at provisioning time
   * starts drifting the moment the agent's identity is edited — name,
   * description, accent colour, avatar all feed the manifest — and the
   * operator would be handed a zip that differs from what a re-run would
   * upload. Since the render is pure and cheap (`loadPackageAssets` reads
   * files, `buildAppPackage` is documented "pure, no network"), rebuilding is
   * both the correct and the simpler answer.
   *
   * Optional: a mount without the connector or without the channel-teams
   * package cannot render one, and the route says so as a capability rather
   * than 500ing.
   */
  readonly buildAppPackage?: (
    record: OperatorTeamsIdentityRecord,
  ) => Promise<Uint8Array>;
  /**
   * The tenant's delegated token set (#924/#949), read on demand.
   *
   * Two routes need it and neither can fake it: withdrawing the app from the
   * tenant catalog is delegated-only at Microsoft, and chat enumeration may
   * be. Optional — absent means "nobody is signed in", which both routes
   * report as a blocked capability rather than a failure.
   */
  readonly delegatedTokens?: {
    read(): Promise<DelegatedTokenSet | undefined>;
  };
  /**
   * WRITE access to the provisioning progress log, so a teardown lands on the
   * same timeline as a run (`events` above is the read side).
   *
   * Deliberately a second dep rather than a widening of `events`: the router
   * has been a pure READER of that table since #915 — the job runner is its
   * only writer — and the teardown is the first thing the router itself does
   * that an operator watches happen. Keeping the two directions apart makes
   * that exception visible instead of quietly granting the whole router write
   * access to a log it does not own.
   */
  readonly eventWriter?: TeamsResetEventSink;
}

/**
 * The subset of `TeamsProvisioningEventStore` this router uses (migration
 * 0053, byte5ai/omadia#915) — read-only. The runner is the only writer.
 *
 * Optional on the deps for the same reason `installs` is: a middleware whose
 * migrations have not reached 0053 answers the status endpoint without a
 * timeline rather than 500ing against a table that is not there.
 */
export interface OperatorTeamsEventStore {
  listRecent(
    agentId: string,
    limit?: number,
  ): Promise<readonly OperatorTeamsProvisioningEventRecord[]>;
}

/** One `agent_teams_provisioning_events` row, camelCase — see
 *  `platform/teamsProvisioningEventStore.ts`. */
export interface OperatorTeamsProvisioningEventRecord {
  readonly id: string;
  readonly agentId: string;
  readonly at: Date;
  readonly step: string;
  readonly status: string;
  readonly attempt: number | null;
  readonly detail: string | null;
}

/**
 * Filename stem for a downloaded Teams app package (byte5ai/omadia#924).
 *
 * Derived from the BOT slug, because that is the name the package carries into
 * the Teams catalogue — an operator comparing a download against what is live
 * matches on that, not on the orchestrator's slug.
 *
 * Sanitised rather than trusted: the value lands in a `Content-Disposition`
 * header, where a quote or a newline is a header-injection primitive. The bot
 * slug is already constrained upstream (`BOT_SLUG_RE` in
 * `platform/teamsProvisionerService.ts`), so this narrowing normally changes
 * nothing — which is exactly the property a defence at a boundary should have.
 */
export function teamsPackageFilenameFor(record: {
  readonly botSlug: string;
}): string {
  const safe = record.botSlug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return `omadia-teams-${safe.length > 0 ? safe : 'app'}`;
}

/** How many events the status endpoint publishes. A run emits roughly a
 *  dozen; thirty covers a full retry storm without turning a status poll
 *  (every 3s, per open panel) into a page of JSON. */
export const TEAMS_PROVISIONING_EVENT_LIMIT = 30;

/** The subset of `AgentTeamsInstallStore` this router uses. */
export interface OperatorTeamsInstallStore {
  listForAgent(agentId: string): Promise<readonly OperatorTeamsInstallRecord[]>;
  setDisplayName(
    agentId: string,
    teamId: string,
    displayName: string,
  ): Promise<boolean>;
  remove(agentId: string, teamId: string): Promise<boolean>;
  /** Drop every binding of one agent — the teardown's counterpart of
   *  {@link remove}. Optional so a store predating it still satisfies the
   *  port; without it the teardown leaves the read model alone and says so. */
  removeAllForAgent?(agentId: string): Promise<number>;
}

/** One persisted binding, camelCase — see `platform/agentTeamsInstallStore.ts`. */
export interface OperatorTeamsInstallRecord {
  readonly agentId: string;
  readonly teamId: string;
  /** Optional for the same structural-mirror reason as on the identity
   *  record; absent means `'team'`. */
  readonly targetKind?: TeamsTargetKind;
  readonly teamsAppId: string | null;
  readonly teamDisplayName: string | null;
  readonly displayNameSyncedAt?: Date | null;
  readonly installedAt: Date;
}

/**
 * The `teams_bots[]` projection and its secret-ref convention MOVED to
 * `services/teamsBotsConfigSync.ts` (#910): the same entry is now WRITTEN
 * into the channel-teams plugin config after provisioning, and a projection
 * that lives in a route module could not be the producer for both. Re-exported
 * here because this router is still the surface that publishes it, and because
 * two producers of a config contract is exactly the drift the choke point
 * exists to prevent.
 */
export {
  defaultTeamsBotSecretRef,
  projectTeamsBotConfig,
  type TeamsBotConfigProjection,
} from '../services/teamsBotsConfigSync.js';

/** Structured form of the identity's `last_error`, decoded by the runner's
 *  own classifier so the UI renders from a code + typed arguments instead of
 *  parsing English. `null` while the row carries no error. */
export function projectTeamsIdentityErrorDetail(
  record: OperatorTeamsIdentityRecord,
): TeamsProvisioningErrorDetail | null {
  return record.lastError ? classifyTeamsProvisioningError(record.lastError) : null;
}

/** One event as the status endpoint publishes it — snake_case like the rest
 *  of the payload, `at` as an ISO string. */
export interface TeamsProvisioningEventProjection {
  readonly id: string;
  readonly at: string;
  readonly step: string;
  readonly status: string;
  readonly attempt: number | null;
  readonly detail: string | null;
}

/**
 * The run's timeline, newest first (#915).
 *
 * THIS FUNCTION IS THE ROUTE'S ONE CHOKE POINT for progress-log failures, the
 * mirror of the runner's `emit`. The timeline is decoration on a response
 * whose actual payload is the identity row: a middleware that has not reached
 * migration 0053, a table that is briefly unreadable, a query that times out —
 * none of those are a reason to deny an operator the state of their agent. So
 * every one of them degrades to an empty list, loudly in the server log and
 * silently in the response.
 *
 * The empty list is honest, not a lie: it says "no events to show", which is
 * exactly what a pre-0053 middleware has. What it must never do is claim a
 * run failed or succeeded, and it cannot — every entry here is written by the
 * runner or does not exist.
 */
async function projectProvisioningEvents(
  deps: OperatorTeamsIdentityDeps,
  agentId: string,
): Promise<readonly TeamsProvisioningEventProjection[]> {
  const events = deps.events;
  if (!events) return [];
  try {
    const rows = await events.listRecent(
      agentId,
      TEAMS_PROVISIONING_EVENT_LIMIT,
    );
    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      step: row.step,
      status: row.status,
      attempt: row.attempt,
      detail: row.detail,
    }));
  } catch (err) {
    console.warn(
      `[operator-agents] provisioning timeline for agent '${agentId}' could not be read:`,
      err,
    );
    return [];
  }
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
// MIGRATION 0051 CLOSED THE FIRST HALF OF THAT GATE. The install SET now has
// its own table (`agent_teams_installs`), so an agent can be bound to several
// teams and a binding survives the next request instead of being overwritten —
// the "bindings do not persist" symptom operators reported. Each entry says
// where it comes from (`evidence: 'install_row'`, or `'identity_row'` on a
// mount that has no installs store bound yet), and `multi_team` follows that
// same fact rather than being a constant.
//
// The SECOND half stands: there is still no live enumeration, because the
// connector publishes no listing method. The list is what omadia recorded
// doing, and `capabilities.enumerate` stays false so the UI can say so.
// ---------------------------------------------------------------------------

/** One target an agent's Teams app is known to be installed in. */
export interface InstalledTeamProjection {
  /** Teams team (group) id, or a chat conversation id — see `target_kind`. */
  readonly team_id: string;
  /**
   * WHICH KIND of target `team_id` addresses (migration 0054). Sent so the
   * operator UI can label a chat as a chat instead of listing it under a
   * heading that says team — the whole reason the field test read as a
   * mystery rather than as a wrong-kind-of-id.
   */
  readonly target_kind: TeamsTargetKind;
  /**
   * Graph display name of the team, as last resolved — `null` when it was
   * never resolved (no connector, connector < 0.5.0, or the team is not
   * visible to the tenant app). The UI shows the id alone in that case rather
   * than inventing a label. A CACHE: Graph owns the name and renames are not
   * pushed to us, so `display_name_synced_at` says how old the answer is.
   */
  readonly team_display_name: string | null;
  readonly display_name_synced_at: Date | null;
  /** Catalog id of the installed app, when the upload step already ran. */
  readonly teams_app_id: string | null;
  /** Row timestamp of the write that recorded the install — NOT a Graph
   *  timestamp; the connector reports none. `null` when the store port
   *  carries no timestamps. */
  readonly installed_at: Date | null;
  /**
   * Where the entry comes from.
   *
   * `install_row` — a persisted binding (`agent_teams_installs`, migration
   * 0051): omadia performed this install and recorded it.
   * `identity_row` — the legacy single-column derivation, still used while no
   * installs store is bound.
   *
   * Neither is an enumeration: the connector publishes no listing method, so
   * both answer "what omadia did", never "what Graph currently holds".
   */
  readonly evidence: 'identity_row' | 'install_row';
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
      // The pre-0054 derivation can only ever have described a team: it is
      // the fallback for a mount with no installs table, and no code path
      // that wrote those rows could install anywhere else.
      target_kind: record.targetKind ?? 'team',
      team_display_name: null,
      display_name_synced_at: null,
      teams_app_id: record.teamsAppId,
      installed_at: record.updatedAt ?? null,
      evidence: 'identity_row',
    },
  ];
}

/**
 * The binding list the route publishes.
 *
 * PREFERS the persisted table (migration 0051) — the only source that can
 * hold more than one team and can carry a resolved name. Falls back to the
 * legacy single-entry derivation while no installs store is bound, so a
 * partial deployment reports less rather than nothing.
 *
 * The name lookup is OPPORTUNISTIC and best-effort: only bindings that have
 * never been named are resolved, at most {@link MAX_NAME_LOOKUPS_PER_READ}
 * per request, and any failure leaves the binding as it was. A read of the
 * operator page must never fail — or hang — because Graph is slow.
 */
export async function readInstalledTeams(
  deps: OperatorTeamsIdentityDeps,
  agentId: string,
  record: OperatorTeamsIdentityRecord,
): Promise<readonly InstalledTeamProjection[]> {
  const installs = deps.installs;
  if (!installs) return projectInstalledTeams(record);
  const rows = await installs.listForAgent(agentId);
  const named = await resolveMissingTeamNames(deps, agentId, rows);
  return named.map((row) => ({
    team_id: row.teamId,
    target_kind: row.targetKind ?? 'team',
    team_display_name: row.teamDisplayName,
    display_name_synced_at: row.displayNameSyncedAt ?? null,
    teams_app_id: row.teamsAppId,
    installed_at: row.installedAt,
    evidence: 'install_row' as const,
  }));
}

/** Bound so one operator page load cannot fan out into an unbounded number of
 *  Graph calls. Un-named bindings beyond it are picked up by the next read —
 *  the name is a cache, and a cache is allowed to fill in gradually. */
const MAX_NAME_LOOKUPS_PER_READ = 10;

async function resolveMissingTeamNames(
  deps: OperatorTeamsIdentityDeps,
  agentId: string,
  rows: readonly OperatorTeamsInstallRecord[],
): Promise<readonly OperatorTeamsInstallRecord[]> {
  const resolve = deps.resolveTeamName;
  const installs = deps.installs;
  if (!resolve || !installs) return rows;
  const missing = rows
    // `resolveTeamName` is `teamsProvisioner@1.getTeam`, which answers for a
    // TEAM. Asking it about a chat id spends a Graph call to be told
    // `found: false` and leaves exactly the nameless row we started with.
    .filter((row) => row.teamDisplayName === null && (row.targetKind ?? 'team') === 'team')
    .slice(0, MAX_NAME_LOOKUPS_PER_READ);
  if (missing.length === 0) return rows;

  const resolved = new Map<string, string>();
  for (const row of missing) {
    try {
      const name = await resolve(row.teamId);
      if (name === null || name === '') continue;
      resolved.set(row.teamId, name);
      // Persist so the next read needs no lookup at all, and so the name
      // survives a connector that is later removed or downgraded.
      await installs.setDisplayName(agentId, row.teamId, name);
    } catch (err) {
      console.warn(
        `[operator-agents] team name lookup for '${row.teamId}' failed:`,
        err,
      );
    }
  }
  if (resolved.size === 0) return rows;
  return rows.map((row) => {
    const name = resolved.get(row.teamId);
    return name === undefined
      ? row
      : { ...row, teamDisplayName: name, displayNameSyncedAt: new Date() };
  });
}

/** What the operator router can actually do with team↔agent assignment. Sent
 *  with the read model so the UI disables what the platform cannot do instead
 *  of discovering it from a failed request. */
export interface TeamsAssignmentCapabilities {
  /** Install into a team by resuming the provisioning chain. */
  readonly install: boolean;
  /** Remove an install — requires a connector that publishes
   *  `uninstallFromTeam` (M365 connector >= 0.4.0). */
  readonly uninstall: boolean;
  /** Enumerate installs live — the connector publishes no listing method. */
  readonly enumerate: boolean;
  /** Track more than one team per agent — migration 0049 stores one. */
  readonly multi_team: boolean;
  /** Install into a GROUP CHAT or 1:1 chat — requires a connector that
   *  publishes `installToChat` (M365 connector >= 0.7.0). */
  readonly chat_install: boolean;
  /** Why a `false` above is false, keyed by capability. */
  readonly unsupported_reason: Readonly<Record<string, string>>;
}

/** Minimum connector version whose `teamsProvisioner@1` publishes an
 *  uninstall. Quoted in the operator-facing reason so the fix is actionable
 *  ("upgrade the plugin"), not just a refusal. */
export const TEAMS_UNINSTALL_MIN_CONNECTOR_VERSION = '0.4.0';

/** Reason text for a capability that is off because the INSTALLED connector
 *  is too old — a version skew an operator can fix, unlike the structural
 *  gaps below. */
export const TEAMS_UNINSTALL_UNSUPPORTED_REASON =
  `the installed teamsProvisioner@1 publishes no uninstallFromTeam method — upgrade @omadia/integration-microsoft365 to >= ${TEAMS_UNINSTALL_MIN_CONNECTOR_VERSION}; until then removing the app from a team is a manual Teams-admin step.`;

/** Reason text for the chat direction against a connector that predates it —
 *  a version skew an operator can fix, so the sentence names the version. */
export const TEAMS_CHAT_INSTALL_UNSUPPORTED_REASON =
  `the installed teamsProvisioner@1 publishes no installToChat method — upgrade @omadia/integration-microsoft365 to >= ${TEAMS_CHAT_INSTALL_MIN_CONNECTOR_VERSION}; until then an agent can only be installed into a team, not into a group chat.`;

/** Minimum connector that can tear a provisioning run down without making
 *  things worse — see `platform/teamsProvisionerCleanup.ts` on the purge. */
export const TEAMS_RESET_MIN_CONNECTOR_VERSION = '0.8.0';

/** Reason text for a mount that cannot reset. Two independent causes, one
 *  sentence: no connector at all, or an identity store predating
 *  `resetForRetry`. Both mean the same thing to the operator — the cleanup is
 *  still a manual Azure-portal step. */
export const TEAMS_RESET_UNSUPPORTED_REASON =
  `resetting a Teams provisioning run needs teamsProvisioner@1 and an identity store that can return the row to 'pending' — upgrade @omadia/integration-microsoft365 to >= ${TEAMS_RESET_MIN_CONNECTOR_VERSION} and apply migration 0055; until then the Entra app, the Azure bot and the catalog entry have to be removed by hand.`;

const STRUCTURAL_UNSUPPORTED_REASONS: Readonly<Record<string, string>> = {
  enumerate:
    'teamsProvisioner@1 publishes no installation-listing method — the team list is what omadia recorded when it installed (agent_teams_installs), not a live enumeration from Graph.',
};

/** Reason for a mount that has no installs table bound yet — the pre-0051
 *  single-column world, where a second team could only be recorded by
 *  overwriting the first. */
const MULTI_TEAM_UNSUPPORTED_REASON =
  'this middleware has no agent_teams_installs store bound (migration 0051) — without it only the single agent_teams_identities.team_id exists, and a second team could only be recorded by overwriting the first.';

/**
 * The capability block for ONE request.
 *
 * `uninstall` and `chat_install` are the entries that vary at runtime: each
 * mirrors whether the connector installed RIGHT NOW publishes the method
 * behind it (`uninstallFromTeam`, byte5ai/omadia#900; `installToChat`, the
 * chat targets). Everything else is a structural property of this
 * middleware's schema and the capability contract, so it stays constant.
 *
 * A `false` always ships with its reason, and the reason distinguishes the
 * two kinds: a fixable version skew ("upgrade the connector") versus a
 * structural gap the operator cannot do anything about.
 */
export function teamsAssignmentCapabilities(
  canUninstall: boolean,
  canMultiTeam = false,
  canChatInstall = false,
): TeamsAssignmentCapabilities {
  return {
    install: true,
    uninstall: canUninstall,
    enumerate: false,
    multi_team: canMultiTeam,
    chat_install: canChatInstall,
    unsupported_reason: {
      ...(canUninstall ? {} : { uninstall: TEAMS_UNINSTALL_UNSUPPORTED_REASON }),
      ...(canMultiTeam ? {} : { multi_team: MULTI_TEAM_UNSUPPORTED_REASON }),
      ...(canChatInstall
        ? {}
        : { chat_install: TEAMS_CHAT_INSTALL_UNSUPPORTED_REASON }),
      ...STRUCTURAL_UNSUPPORTED_REASONS,
    },
  };
}

/**
 * The block for a connector that cannot uninstall — the pre-#900 shape, kept
 * as the named baseline the tests and the UI contract refer to.
 */
export const TEAMS_ASSIGNMENT_CAPABILITIES: TeamsAssignmentCapabilities =
  teamsAssignmentCapabilities(false);

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

  // Only a mount WITHOUT the bindings table still has to refuse a second
  // team: there, `agent_teams_identities.team_id` is the single slot, and
  // accepting would overwrite the record of an install that stays live in
  // Graph — an untracked install nothing can then remove. With migration 0051
  // bound the second team simply gets its own row.
  if (
    deps.installs === undefined &&
    row.state === 'installed' &&
    row.teamId !== null &&
    row.teamId !== requestedTeamId
  ) {
    res.status(409).json({
      error: 'team_install_conflict',
      message: `agent '${agent.slug}' is already installed in team '${row.teamId}' and this middleware has no agent_teams_installs store bound (migration 0051) — a single team_id is all it can record, so switching teams would leave an untracked install behind.`,
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
 * Turn the operator's pasted `team_id` into a decided install target, or
 * answer the request with a message they can act on.
 *
 * THE FAILURE THIS REPLACES. A pasted id that was neither a team nor a
 * channel used to travel all the way down the provisioning chain and die at
 * step five against Graph — `400 teamId needs to be a valid GUID`, then
 * `404 No team found with Group Id`. Five successful steps, an Entra app, an
 * Azure bot and a catalog upload later, the operator learned only that
 * something about their id was wrong. Deciding it HERE means the answer
 * arrives in the same request, before anything is provisioned.
 *
 * Returns `null` when it has already answered `res`.
 */
function resolveInstallTargetOrRefuse(
  res: Response,
  raw: string,
): { readonly id: string; readonly kind: TeamsTargetKind } | null {
  const target = resolveTeamsInstallTarget(raw);
  if (target.ok) return { id: target.id, kind: target.kind };

  if (target.reason === 'channel') {
    // A channel is refused rather than redirected to its parent team.
    // Installing into the team would succeed and put the app in EVERY channel
    // of it — a wider audience than was asked for, produced by a guess.
    res.status(400).json({
      error: 'teams_target_is_channel',
      message:
        'this is a CHANNEL id (19:…@thread.tacv2), and a channel cannot be an install target: Teams installs an app into a team or into a chat, never into a single channel. Use the id of the team that owns the channel (Teams → team → "Get link to team" → the groupId), or a group chat id (19:…@thread.v2).',
      target_id: raw.trim(),
    });
    return null;
  }

  if (target.reason === 'ambiguous') {
    // NOT guessed at. The id is both a team group id without its dashes and
    // the stem of a group-chat id, and the only party who knows which was
    // meant is the operator — so the refusal hands back both spellings and
    // asks them to paste the one they mean. This is the field-test failure,
    // answered in the first request instead of at step five.
    res.status(400).json({
      error: 'teams_target_ambiguous',
      message: `'${raw.trim()}' is 32 hex digits, which is BOTH a team (group) id without its dashes AND the stem of a group chat id — omadia will not guess. Paste '${target.asTeamId}' for the team, or '${target.asGroupChatId}' for the group chat.`,
      target_id: raw.trim(),
      /** The two ways out, ready to paste — the UI offers them as choices. */
      as_team_id: target.asTeamId,
      as_group_chat_id: target.asGroupChatId,
    });
    return null;
  }

  res.status(400).json({
    error: 'teams_target_unrecognised',
    message: `'${raw.trim()}' is not a Teams install target — expected a team (group) id, a group chat id (19:…@thread.v2) or a 1:1 chat id (19:…@unq.gbl.spaces).`,
    target_id: raw.trim(),
    examples: {
      team: TEAMS_TARGET_EXAMPLES.team,
      group_chat: TEAMS_TARGET_EXAMPLES.groupChat,
      one_on_one_chat: TEAMS_TARGET_EXAMPLES.oneOnOneChat,
    },
  });
  return null;
}

/**
 * Refuse a CHAT target the installed connector cannot reach (`installToChat`,
 * connector >= 0.7.0).
 *
 * 501 rather than 400: the request is well-formed and will work verbatim once
 * the plugin is upgraded, so the refusal names the version instead of blaming
 * the input. Checked before anything is written, so a refused request leaves
 * no re-targeted row behind.
 *
 * Returns `true` when it has answered `res`.
 */
function refuseUnsupportedChatTarget(
  res: Response,
  deps: OperatorTeamsIdentityDeps,
  kind: TeamsTargetKind,
): boolean {
  if (!isChatTarget(kind)) return false;
  if (supportsChatInstall(deps.getProvisioner?.())) return false;
  res.status(501).json({
    error: 'teams_chat_install_unsupported',
    message: TEAMS_CHAT_INSTALL_UNSUPPORTED_REASON,
    target_kind: kind,
  });
  return true;
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
  opts?: { readonly republish?: boolean; readonly targetKind?: TeamsTargetKind },
): void {
  void Promise.resolve(
    deps.runner.enqueue({
      agentId: agent.id,
      teamId,
      // Omitted rather than defaulted to `'team'` here: the runner owns that
      // default, and forwarding an explicit value the caller never chose would
      // hide a caller that forgot to pass one.
      ...(opts?.targetKind !== undefined ? { targetKind: opts.targetKind } : {}),
      ...(opts?.republish === true ? { republish: true } : {}),
    }),
  )
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

// ---------------------------------------------------------------------------
// Agent identity (#914)
// ---------------------------------------------------------------------------

/** Structural subset of `AgentIdentityStore` — the router never learns `pg`. */
export interface OperatorAgentIdentityStore {
  getByAgentId(agentId: string): Promise<AgentIdentityRecord | undefined>;
  save(
    agentId: string,
    input: AgentIdentitySaveInput,
  ): Promise<AgentIdentityRecord>;
  recompose(
    agentId: string,
    composed: AgentIdentityComposedPrompt,
  ): Promise<AgentIdentityRecord | undefined>;
  setAvatar(
    agentId: string,
    avatar: AgentIdentityAvatarInput,
  ): Promise<AgentIdentityRecord>;
  clearAvatar(agentId: string): Promise<AgentIdentityRecord | undefined>;
  getAvatar(agentId: string): Promise<AgentIdentityAvatarBytes | undefined>;
}

export interface OperatorAgentIdentityDeps {
  readonly store: OperatorAgentIdentityStore;
}

/** Image types the avatar upload accepts. PNG is what Teams ships; the other
 *  two are decoded and re-encoded to PNG by the derivation step, so an
 *  operator does not have to convert a photo by hand first. */
export const AVATAR_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

/**
 * Length caps mirror the Teams manifest, deliberately: `description.short`
 * is capped at 80 characters and `description.full` at 4000 there, and a
 * value that would be silently truncated when the package is built is better
 * refused while the operator is still looking at the field.
 */
const AgentIdentitySchema = z.object({
  display_name: z.string().max(120).nullish(),
  short_description: z.string().max(80).nullish(),
  long_description: z.string().max(4000).nullish(),
  instructions: z.string().max(20000).nullish(),
  accent_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'expected a #RRGGBB colour')
    .nullish(),
  // The persona and quality blocks are validated by the SPEC's own schemas,
  // not by a second definition here. They are the same documents the Agent
  // Builder writes and `agent.md` frontmatter mirrors; a private copy would
  // drift the moment an axis or a preset is added, and the compilers this
  // route calls are written against those schemas.
  persona: PersonaConfigSchema.nullish(),
  quality: QualityConfigSchema.nullish(),
});

/** What a write did to the agent's published Teams package. */
export type AgentIdentityRepublishOutcome =
  /** A re-publish run was enqueued (identity changed, agent is installed). */
  | 'queued'
  /** Nothing changed, so nothing to publish. */
  | 'not_needed'
  /** The identity changed but this agent has no installed Teams app. */
  | 'no_installed_app'
  /** The identity changed but the provisioner is not installed right now. */
  | 'provisioner_unavailable';

interface AgentIdentityProjectionAgent {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
}

/**
 * The wire shape. Carries BOTH the authored values (nullable — what the form
 * edits) and the resolved ones (what every consumer actually sees), because a
 * UI that only got the authored values would have to re-implement the
 * fallback to render a preview, and that is exactly the duplication
 * `resolveAgentIdentity` exists to prevent.
 */
export function projectAgentIdentity(
  agent: AgentIdentityProjectionAgent,
  identity: AgentIdentityRecord | undefined,
): Record<string, unknown> {
  const resolved = resolveAgentIdentity(identity, {
    name: agent.name,
    description: agent.description,
  });
  return {
    slug: agent.slug,
    identity: {
      display_name: identity?.displayName ?? null,
      short_description: identity?.shortDescription ?? null,
      long_description: identity?.longDescription ?? null,
      instructions: identity?.instructions ?? null,
      accent_color: identity?.accentColor ?? null,
      persona: identity?.persona ?? null,
      quality: identity?.quality ?? null,
      revision: identity?.revision ?? 1,
      avatar:
        identity?.avatar == null
          ? null
          : {
              etag: identity.avatar.etag,
              // Same-origin path, so the UI never composes one itself.
              url: `/api/v1/operator/agents/${encodeURIComponent(agent.slug)}/identity/avatar`,
            },
      updated_at: identity?.updatedAt.toISOString() ?? null,
    },
    // The compiled prompt is surfaced read-only: it is what the agent
    // actually speaks with, assembled from four controls that each show only
    // their own part. An operator tuning axes should be able to read the
    // result rather than infer it.
    composed_prompt: identity?.composed.text ?? null,
    composed_family: identity?.composed.family ?? null,
    resolved: {
      display_name: resolved.displayName,
      short_description: resolved.shortDescription,
      long_description: resolved.longDescription,
      instructions: resolved.instructions,
      accent_color: resolved.accentColor,
      has_avatar: resolved.hasAvatar,
    },
  };
}

/**
 * Which persona family this agent's persona deltas are computed against.
 *
 * `model_routing.main` is the operator's per-agent model choice; without one
 * the agent runs on the platform default, which this router does not know —
 * and {@link inferFamilyFromModel} answers `sonnet` for an unknown id, the
 * documented safe middle ground for the delta math.
 */
function agentPersonaFamily(agent: {
  readonly modelRouting?: Record<string, unknown> | null;
}): PersonaModelFamily {
  const main = agent.modelRouting?.['main'];
  return inferFamilyFromModel(typeof main === 'string' ? main : '');
}

/**
 * Re-publish the agent's Teams app package after an identity edit (#914).
 *
 * The package renders the identity, so an edit that does not reach the tenant
 * leaves Teams showing the OLD name, description and icon indefinitely — a
 * silent no-op is the failure mode this exists to prevent. Every branch that
 * cannot publish says WHY in the response instead of pretending it did.
 *
 * Only `installed` identities are re-published: those are the ones with a
 * package in the tenant catalog and a recorded install target. Anything
 * earlier in the chain builds its package from the current identity when it
 * gets there.
 */
async function republishTeamsPackage(
  deps: OperatorTeamsIdentityDeps | undefined,
  agent: { readonly id: string; readonly slug: string },
  before: number | undefined,
  after: number | undefined,
): Promise<AgentIdentityRepublishOutcome> {
  if (after === undefined || before === after) return 'not_needed';
  if (!deps) return 'no_installed_app';
  const row = await deps.store.getByAgentId(agent.id);
  if (!row || row.state !== 'installed' || !row.teamId) {
    return 'no_installed_app';
  }
  if (!deps.isProvisionerInstalled()) return 'provisioner_unavailable';
  startProvisioningRun(deps, agent, row.teamId, { republish: true });
  return 'queued';
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
  /** #914 — the agent identity store (migration 0052). Late-bound like the
   *  others; the identity routes 503 while it returns undefined (no
   *  DATABASE_URL, tests / minimal mounts). */
  readonly getAgentIdentity?: () => OperatorAgentIdentityDeps | undefined;
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

  /** #914 — same late-bound 503 posture as `teamsIdentity`, for the identity
   *  store. Kept separate: an agent's identity is editable whether or not the
   *  Teams provisioning stack is wired at all. */
  function agentIdentity(res: Response): OperatorAgentIdentityDeps | undefined {
    const deps = options.getAgentIdentity?.();
    if (!deps) {
      res.status(503).json({
        error: 'agent_identity_unavailable',
        message:
          'the agent identity store is not wired — it registers once DATABASE_URL is set and migration 0052 has been applied.',
      });
      return undefined;
    }
    return deps;
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
    // #914 — body-parser's own size refusal. Without this branch an oversized
    // avatar would be reported as an internal error, which is both wrong and
    // unactionable: the operator can act on "too large", not on a 500.
    if ((err as { type?: unknown } | null)?.type === 'entity.too.large') {
      res.status(413).json({
        error: 'payload_too_large',
        limit_bytes: MAX_AVATAR_BYTES,
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

  // ── agent identity (#914) ───────────────────────────────────────────
  //
  // What a DEPLOYED agent is called, says about itself and looks like. Its
  // own endpoints, not fields on `PATCH /:slug`: that handler is the
  // dashboard's rename/enable surface, while an identity write can trigger a
  // Teams re-publish, and one payload that sometimes re-publishes is a worse
  // contract than two that each do one thing.
  //
  // NOTHING HERE TOUCHES THE AGENT BUILDER. The Builder authors agent
  // PLUGINS; this is the identity of the agent that runs them. An agent that
  // was never near the Builder gets its identity here all the same.
  router.get('/:slug/identity', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = agentIdentity(res);
    if (!deps) return;
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const identity = await deps.store.getByAgentId(agent.id);
      res.json(projectAgentIdentity(agent, identity));
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.put('/:slug/identity', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = agentIdentity(res);
    if (!deps) return;
    try {
      const body = AgentIdentitySchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const before = await deps.store.getByAgentId(agent.id);
      const persona = (body.persona ?? null) as PersonaConfig | null;
      const quality = (body.quality ?? null) as QualityConfig | null;
      // Compile HERE, on the write path: the orchestrator package cannot
      // import the middleware's compilers, so the prompt an agent speaks
      // with is stored alongside the settings it was built from. The family
      // comes from the agent's own model routing — persona axes are deltas
      // against it, so composing against the wrong one would emit the wrong
      // traits.
      const family = agentPersonaFamily(agent);
      const composed = composeAgentIdentityPrompt({
        instructions: body.instructions ?? null,
        persona,
        quality,
        family,
      });
      const identity = await deps.store.save(agent.id, {
        displayName: body.display_name ?? null,
        shortDescription: body.short_description ?? null,
        longDescription: body.long_description ?? null,
        instructions: body.instructions ?? null,
        accentColor: body.accent_color ?? null,
        persona,
        quality,
        composed: { text: composed.text, family },
      });
      // `instructions` is the opening section of this agent's system prompt,
      // so a saved edit that never reaches the running registry would be a
      // change the operator can see and the agent never speaks. Same reload
      // contract as every other write on this router; the diff decides whether
      // an Orchestrator is actually rebuilt.
      // Normalised on both sides: a first save has no `before` at all, and
      // `undefined !== null` would rebuild every Agent whose operator merely
      // typed a display name — dropping live sessions for a label change.
      if ((before?.composed.text ?? null) !== (composed.text ?? null)) {
        await live.registry.reload();
      }
      // A save whose CONTENT did not change returns the stored row
      // untouched — including a prompt that may have been compiled against a
      // model family the agent has since moved off. Recompose covers exactly
      // that case, and deliberately does not bump the revision: nothing the
      // operator authored changed.
      const current =
        identity.composed.text === composed.text &&
        identity.composed.family === family
          ? identity
          : ((await deps.store.recompose(agent.id, {
              text: composed.text,
              family,
            })) ?? identity);
      const republish = await republishTeamsPackage(
        options.getTeamsIdentity?.(),
        agent,
        before?.revision,
        current.revision,
      );
      res.json({
        ...projectAgentIdentity(agent, current),
        republish,
        // Boundary presets this build could not resolve. A rule that silently
        // stopped applying is worse than one that never existed, so the
        // operator hears about it on the save that dropped it.
        ...(composed.droppedBoundaryPresets.length > 0
          ? { dropped_boundary_presets: composed.droppedBoundaryPresets }
          : {}),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // The avatar is uploaded as a RAW image body, not multipart: one file, no
  // fields, and `express.raw` on this one route keeps the parser off every
  // other endpoint. A wrong content type is a 415 rather than a confusing
  // "body is empty" — `raw` leaves `req.body` untouched for types it does
  // not claim, so the check below is the only thing standing between a JSON
  // payload and `sharp`.
  router.post(
    '/:slug/identity/avatar',
    raw({ type: [...AVATAR_CONTENT_TYPES], limit: MAX_AVATAR_BYTES }),
    async (req: Request, res: Response) => {
      const live = svc();
      if (!live) return unavailable(res);
      const deps = agentIdentity(res);
      if (!deps) return;
      try {
        const slug = slugParam(req, res);
        if (!slug) return;
        if (!Buffer.isBuffer(req.body)) {
          res.status(415).json({
            error: 'unsupported_media_type',
            accepted: AVATAR_CONTENT_TYPES,
          });
          return;
        }
        const agent = await live.store.getAgentBySlug(slug);
        if (!agent) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        const before = await deps.store.getByAgentId(agent.id);
        // Derivation happens HERE, before the write: a picture sharp cannot
        // turn into the two icons Teams needs is a 400 the operator can act
        // on, not a provisioning failure three screens later.
        const derived = await deriveAgentAvatar(req.body);
        const identity = await deps.store.setAvatar(agent.id, derived);
        const republish = await republishTeamsPackage(
          options.getTeamsIdentity?.(),
          agent,
          before?.revision,
          identity.revision,
        );
        res.json({
          ...projectAgentIdentity(agent, identity),
          republish,
          // Honest about the one case where the upload is only half used.
          outline_derived: derived.outline !== null,
        });
      } catch (err) {
        if (err instanceof AgentAvatarError) {
          res.status(400).json({ error: 'invalid_avatar', message: err.message });
          return;
        }
        badRequest(res, err);
      }
    },
  );

  router.delete('/:slug/identity/avatar', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = agentIdentity(res);
    if (!deps) return;
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const before = await deps.store.getByAgentId(agent.id);
      const identity = await deps.store.clearAvatar(agent.id);
      const republish = await republishTeamsPackage(
        options.getTeamsIdentity?.(),
        agent,
        before?.revision,
        identity?.revision,
      );
      res.json({ ...projectAgentIdentity(agent, identity), republish });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // Preview source for the UI. Serves the ORIGINAL upload (the derived icons
  // are provisioning's business), private-cached against its etag so the
  // form does not re-download it on every render.
  router.get('/:slug/identity/avatar', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = agentIdentity(res);
    if (!deps) return;
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const avatar = await deps.store.getAvatar(agent.id);
      if (!avatar) {
        res.status(404).json({ error: 'no_avatar' });
        return;
      }
      const etag = `"${avatar.etag}"`;
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.setHeader('ETag', etag);
      res.end(Buffer.from(avatar.bytes));
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
      // Decide WHAT the pasted id addresses before anything is written or
      // compared: a channel id and an unusable string are answered here, and
      // a team id is normalised to the form Graph accepts.
      const target = resolveInstallTargetOrRefuse(res, body.team_id);
      if (!target) return;
      if (refuseUnsupportedChatTarget(res, deps, target.kind)) return;
      const current = await deps.store.getByAgentId(existing.id);
      if (
        current &&
        refuseConflictingTeamRetarget(res, deps, existing, current, target.id)
      ) {
        return;
      }
      let row: OperatorTeamsIdentityRecord;
      try {
        row = await deps.store.ensureForAgent({
          agentId: existing.id,
          botSlug: body.bot_slug ?? deriveBotSlug(existing.slug),
          displayName: body.display_name ?? existing.name,
          teamId: target.id,
          targetKind: target.kind,
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
      startProvisioningRun(deps, existing, target.id, { targetKind: target.kind });
      res.status(202).json({
        ok: true,
        agent: existing.slug,
        team_id: target.id,
        target_kind: target.kind,
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
      // through the platform's ONE choke point so the entry the operator can
      // paste and the entry provisioning WRITES are the same bytes — see
      // `services/teamsBotsConfigSync.ts`.
      const teamsBot = projectTeamsBotConfig(row, deps.clientSecretRef);
      // #910 — does channel-teams actually hold this entry right now? Derived
      // by LOOKING at the live plugin config, never from a remembered "we
      // synced it" flag: an operator can edit or delete the entry at any time
      // and a recorded intention would then tell the UI a comfortable lie.
      const secretRef = deps.clientSecretRef;
      const teamsBotsSync = projectTeamsBotsConfigSyncStatus(
        {
          getInstalledRegistry: () => options.getInstalledRegistry?.(),
          // Bound to THIS row rather than passed through: the dependency is
          // typed for the router's record, the projection for the structural
          // identity source, and the closure is the honest bridge between
          // them (it is only ever called with this row anyway).
          ...(secretRef ? { clientSecretRef: () => secretRef(row) } : {}),
        },
        row,
      );
      // #915 — what the run has been DOING. Read after the projections above
      // so a slow timeline never delays the parts of this response that
      // matter; failures are absorbed inside projectProvisioningEvents.
      const provisioningEvents = await projectProvisioningEvents(
        deps,
        existing.id,
      );
      res.json({
        ok: true,
        agent: existing.slug,
        state: row.state,
        // #915 — `running` means the runner still has WORK in flight, not
        // "there is still a map entry". The fix lives in the runner
        // (`TeamsProvisioningJobRunner.isRunning`), deliberately not here:
        // suppressing it from a terminal `state` would have hidden the two
        // legitimate cases where both are true at once — an installed agent
        // being provisioned into a second team (migration 0051), and a re-run
        // of a failed row before it writes its first state.
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
        // Additive (#910): the sync state of `teams_bot` inside the
        // channel-teams plugin config. The copy-paste block above STAYS —
        // this tells the operator whether they still need it.
        teams_bots_sync: teamsBotsSync,
        // Additive (#915): the current run's step timeline, newest first.
        // The five persisted chain states say WHERE the run is; these say
        // what it has been doing between them — which is where the minutes
        // actually go (Entra replication, ARM backoff, catalog upload).
        provisioning_events: provisioningEvents,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── Team ↔ agent assignment (W2a, #860; uninstall #900) ─────────────
  // The read model is DERIVED from the identity row (see
  // projectInstalledTeams): the schema stores one team per agent and the
  // connector publishes no installation listing, so this surface reports
  // what the middleware provably knows and advertises the rest as an
  // unsupported capability rather than guessing. Uninstall is no longer in
  // that set — it is a RUNTIME capability now, true exactly when the
  // installed connector publishes `uninstallFromTeam` (>= 0.4.0).

  /**
   * Can this middleware remove an install RIGHT NOW? Both halves have to
   * hold: the connector must publish `uninstallFromTeam` (>= 0.4.0), and
   * this store must be able to record the removal. Reporting `true` while
   * either is missing would light up a button that answers 501.
   */
  function canUninstallTeams(deps: OperatorTeamsIdentityDeps): boolean {
    return (
      typeof deps.store.clearTeamInstall === 'function' &&
      supportsTeamUninstall(deps.getProvisioner?.())
    );
  }

  /** Resolve agent + identity row for the team routes, answering the shared
   *  404s. `undefined` means a response was already sent. */
  /**
   * Adapt the router's identity-store port to the teardown's.
   *
   * They are two different shapes on purpose: the teardown needs a row it can
   * reason about (`appObjectId` is load-bearing there and absent from most
   * responses here) and exactly two writes, while this router's port is a
   * read model with optional everything. The adapter is where the optionality
   * is resolved ONCE — `resetForRetry` has already been proven present by the
   * caller's 501 gate, and `update` degrades to a no-op because a store that
   * cannot persist the object id simply forces the teardown down its
   * recycle-bin-search path instead.
   */
  function teamsResetStore(
    deps: OperatorTeamsIdentityDeps,
    resetForRetry: (agentId: string) => Promise<OperatorTeamsIdentityRecord>,
  ): {
    getByAgentId(agentId: string): Promise<TeamsResetIdentityRecord | undefined>;
    update(
      agentId: string,
      patch: { readonly appObjectId?: string | null },
    ): Promise<unknown>;
    resetForRetry(agentId: string): Promise<unknown>;
  } {
    return {
      getByAgentId: async (agentId) => {
        const row = await deps.store.getByAgentId(agentId);
        if (!row) return undefined;
        return {
          agentId: row.agentId,
          botSlug: row.botSlug,
          appId: row.appId,
          appObjectId: row.appObjectId ?? null,
          teamsAppId: row.teamsAppId,
        };
      },
      update: async (agentId, patch) => {
        const update = deps.store.update;
        if (typeof update !== 'function') return undefined;
        return update.call(deps.store, agentId, patch);
      },
      resetForRetry: (agentId) => resetForRetry.call(deps.store, agentId),
    };
  }

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

  /**
   * Download this agent's Teams app package (byte5ai/omadia#924).
   *
   * A FALLBACK, NOT THE PATH. Provisioning uploads the package itself — since
   * #924 through the tenant's delegated sign-in, which is what made the
   * per-agent manual upload unnecessary. This endpoint exists for the cases
   * that are always left over: a tenant whose policy forbids programmatic
   * catalog writes, an admin who wants to inspect the manifest before it goes
   * live, a support conversation. Offering it does not make it the documented
   * route, and the UI is deliberately explicit about that.
   *
   * AVAILABLE WHENEVER IT IS BUILDABLE, not only after a failure. The package
   * is a pure render of the identity, so gating it on an error state would
   * have withheld a harmless artefact exactly from the operators calmly
   * preparing a rollout, and handed it only to the ones already in trouble.
   *
   * REBUILT PER REQUEST — see `buildAppPackage` on the deps for why a stored
   * blob would be a lie.
   */
  router.get(
    '/:slug/teams-identity/package',
    async (req: Request, res: Response) => {
      const live = svc();
      if (!live) return unavailable(res);
      const deps = teamsIdentity(res);
      if (!deps) return;
      try {
        const found = await teamsIdentityRow(req, res, live, deps);
        if (!found) return;
        const { row } = found;
        const build = deps.buildAppPackage;
        if (!build) {
          // A capability, not a fault: this mount cannot render a package
          // (no connector, or no installed channel-teams package to take the
          // manifest template and icons from).
          res.status(501).json({
            error: 'teams_app_package_unavailable',
            message:
              'This deployment cannot render a Teams app package — the M365 connector and the channel-teams plugin package must both be installed.',
          });
          return;
        }
        const zip = await build(row);
        // The bot slug, not the agent slug: the package IS the bot, and an
        // operator with two downloads open needs to tell them apart by the
        // name that appears in the Teams catalogue.
        const filename = `${teamsPackageFilenameFor(row)}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        );
        res.setHeader('Content-Length', String(zip.byteLength));
        // No caching: the package is rendered from the CURRENT identity, and a
        // cached copy is the stored-blob drift this endpoint exists to avoid.
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).end(Buffer.from(zip));
      } catch (err) {
        console.warn(
          `[operator-agents] Teams app package for '${req.params.slug ?? ''}' could not be rendered:`,
          err,
        );
        res.status(500).json({
          error: 'teams_app_package_failed',
          message:
            'The Teams app package could not be rendered — see the middleware log for the underlying error.',
        });
      }
    },
  );

  /**
   * GET /:slug/teams/targets — what the operator can PICK instead of type.
   *
   * The field this replaces is the one that produced migration 0054's field
   * test: a bare 32-hex id is a legal reading of both a team's group id and
   * the stem of a chat id, `resolveTeamsInstallTarget` is therefore obliged
   * to refuse it as ambiguous, and the operator holding it cannot
   * disambiguate it either. Every id in this response classifies
   * unambiguously — teams come back hyphenated, chats keep their `19:…@…`
   * suffix — so picking from the list cannot produce that input at all.
   *
   * ALWAYS 200 WHEN THE AGENT EXISTS. Each half carries its own
   * `available` flag with a machine-readable `reason`, because an enumeration
   * is a convenience over a field the operator can still type into, and a 500
   * from the convenience must not take the field down with it. The one thing
   * this endpoint must never do is answer `[]` for "I could not look" — see
   * `services/teamsTargetDirectoryService.ts`.
   */
  router.get('/:slug/teams/targets', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      // Deliberately NOT `teamsIdentityRow`: an operator choosing where an
      // agent should live may not have created its Teams identity yet, and a
      // 404 would hide the picker exactly when it is most useful.
      const slug = slugParam(req, res);
      if (!slug) return;
      const agent = await live.store.getAgentBySlug(slug);
      if (!agent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const directory = await loadTeamsTargetDirectory({
        getProvisioner: () => deps.getProvisioner?.(),
        ...(deps.delegatedTokens ? { delegatedTokens: deps.delegatedTokens } : {}),
      });
      res.json({
        ok: true,
        agent: agent.slug,
        provisioner_installed: deps.isProvisionerInstalled(),
        ...directory,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  /**
   * POST /:slug/teams-identity/reset — undo a provisioning run.
   *
   * DESTRUCTIVE, AND DELIBERATELY NOT A DELETE OF ANYTHING THE OPERATOR
   * TYPED. The Entra app registration, the Azure bot and the tenant catalog
   * entry go; `bot_slug` and `display_name` stay, because they are the two
   * answers a human gave and the whole point is that the retry is one button
   * with the same slug.
   *
   * WHY THE ORDER AND THE PARTIAL REPORT LIVE IN THE SERVICE, NOT HERE:
   * `services/teamsIdentityReset.ts`. This route owns three things the
   * service must not: the connector/version gate, the exclusion against a
   * provisioning run, and the HTTP shape.
   *
   * A PARTIAL TEARDOWN IS A 200. `status: 'incomplete'` with a per-step
   * report is an ANSWER — it says which Azure objects went and which are
   * still there — and putting it behind a non-2xx would push it into the
   * UI's error path, where the steps get collapsed into "reset failed". That
   * single unhelpful sentence is what this endpoint exists to replace. Only
   * a REFUSAL (nothing attempted) is a 4xx.
   */
  router.post(
    '/:slug/teams-identity/reset',
    async (req: Request, res: Response) => {
      const live = svc();
      if (!live) return unavailable(res);
      const deps = teamsIdentity(res);
      if (!deps) return;
      try {
        const found = await teamsIdentityRow(req, res, live, deps);
        if (!found) return;
        const { agent, row } = found;

        if (!deps.isProvisionerInstalled()) {
          res.status(503).json({
            error: 'teams_provisioner_unavailable',
            message:
              'teamsProvisioner@1 is not installed — install and activate the M365 connector plugin before resetting a provisioning run.',
            agent: agent.slug,
          });
          return;
        }
        const provisioner = deps.getProvisioner?.();
        const resetForRetry = deps.store.resetForRetry;
        if (provisioner === undefined || typeof resetForRetry !== 'function') {
          // Same rule as the uninstall route: never remove something we
          // cannot then record as removed. A row still pointing at a purged
          // app registration would send the next run building a bot on an
          // application that is not there.
          res.status(501).json({
            error: 'teams_reset_unsupported',
            message: TEAMS_RESET_UNSUPPORTED_REASON,
            agent: agent.slug,
          });
          return;
        }

        // Take the agent for the duration. `isRunning` alone answers about
        // the instant it was read; between that read and the first delete an
        // enqueue can arrive and start building on the very objects the
        // teardown is about to remove.
        const acquire = deps.runner.acquireExclusive;
        const release =
          typeof acquire === 'function'
            ? acquire.call(deps.runner, agent.id, 'teams_identity_reset')
            : deps.runner.isRunning(agent.id)
              ? null
              : (): void => {};
        if (release === null) {
          res.status(409).json({
            error: 'teams_provisioning_running',
            message: `agent '${agent.slug}' has a provisioning run in flight — wait for it to finish before resetting.`,
            agent: agent.slug,
          });
          return;
        }

        try {
          const result = await resetTeamsIdentity(
            {
              store: teamsResetStore(deps, resetForRetry),
              getProvisioner: () => provisioner as TeamsResetProvisionerPort,
              buildBotHandle,
              ...(typeof deps.installs?.removeAllForAgent === 'function'
                ? {
                    installs: {
                      removeAllForAgent: (agentId: string): Promise<number> =>
                        (
                          deps.installs?.removeAllForAgent as (
                            id: string,
                          ) => Promise<number>
                        )(agentId),
                    },
                  }
                : {}),
              ...(deps.delegatedTokens
                ? { delegatedTokens: deps.delegatedTokens }
                : {}),
              ...(deps.eventWriter ? { events: deps.eventWriter } : {}),
            },
            agent.id,
          );
          // `agentId` is dropped rather than spread: every other route on
          // this router identifies an agent by its SLUG, and leaking the
          // internal id here would make this the one response an operator
          // screen could accidentally start keying on.
          const { agentId: _agentId, ...report } = result;
          res.json({
            ok: result.status === 'reset',
            agent: agent.slug,
            // The state the row held when the teardown started — so the
            // response says what was torn down, not the `pending` it now is.
            previous_state: row.state,
            ...report,
          });
        } finally {
          release();
        }
      } catch (err) {
        if (err instanceof TeamsIdentityResetNotFoundError) {
          res.status(404).json({
            error: 'teams_identity_not_found',
            message: err.message,
          });
          return;
        }
        badRequest(res, err);
      }
    },
  );

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
        teams: await readInstalledTeams(deps, agent.id, row),
        // The recorded install TARGET while the chain has not reached
        // 'installed' — a run in flight (or a stalled one), never an install.
        pending_team_id: row.state === 'installed' ? null : row.teamId,
        /** Kind of `pending_team_id`, so the in-flight hint can name what it
         *  is installing into rather than calling every target a team. */
        pending_target_kind:
          row.state === 'installed' ? null : (row.targetKind ?? 'team'),
        consent: projectTeamsConsent(row),
        last_error: row.lastError,
        last_error_detail: projectTeamsIdentityErrorDetail(row),
        capabilities: teamsAssignmentCapabilities(
          canUninstallTeams(deps),
          deps.installs !== undefined,
          supportsChatInstall(deps.getProvisioner?.()),
        ),
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
      // Same choke point and the same ORDER as POST /:slug/teams-identity:
      // an unknown agent (404) and an absent connector (503) are answered
      // first, because neither depends on what the target id says. Only then
      // is the id decided — and only then can a chat target be refused for a
      // connector that is present but too old (501, not 503).
      const target = resolveInstallTargetOrRefuse(res, body.team_id);
      if (!target) return;
      if (refuseUnsupportedChatTarget(res, deps, target.kind)) return;
      // Already installed HERE? With the bindings table that is a lookup in
      // it; without one, the identity's single `team_id` is the only record
      // and the answer degrades to the pre-0051 comparison.
      const boundTeams = deps.installs
        ? (await deps.installs.listForAgent(agent.id)).map((entry) => entry.teamId)
        : row.state === 'installed' && row.teamId !== null
          ? [row.teamId]
          : [];
      if (boundTeams.includes(target.id)) {
        // Idempotent: the app is already installed in exactly this target.
        res.json({
          ok: true,
          agent: agent.slug,
          team_id: target.id,
          target_kind: target.kind,
          state: row.state,
          already_installed: true,
          // Honest, not assumed: a run may still be settling even though
          // the row already reads 'installed'.
          running: deps.runner.isRunning(agent.id),
        });
        return;
      }
      // A run already in flight toward ANOTHER team is still refused — one
      // chain per agent, and its `team_id` is the runner's scratch field. What
      // is no longer refused (with migration 0051 bound) is installing into an
      // ADDITIONAL team: the binding gets its own row instead of overwriting
      // the previous one, which is the whole point of the table.
      if (refuseConflictingTeamRetarget(res, deps, agent, row, target.id)) {
        return;
      }
      // Record the (new) target through the store's own gate, then let the
      // provisioning runner resume the chain — it owns every Graph/ARM call
      // and every state write, including the final installToTeam.
      const updated = await deps.store.ensureForAgent({
        agentId: agent.id,
        botSlug: row.botSlug,
        displayName: row.displayName,
        teamId: target.id,
        targetKind: target.kind,
      });
      startProvisioningRun(deps, agent, target.id, { targetKind: target.kind });
      res.status(202).json({
        ok: true,
        agent: agent.slug,
        team_id: target.id,
        target_kind: target.kind,
        bot_slug: updated.botSlug,
        state: updated.state,
        already_installed: false,
        running: deps.runner.isRunning(agent.id),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  /**
   * Remove the agent's Teams app from one team (byte5ai/omadia#900).
   *
   * FEATURE-DETECTED, not assumed. The middleware mirrors the connector
   * contract structurally rather than importing it, so a connector below
   * 0.4.0 has no `uninstallFromTeam` — that install keeps answering the
   * historical 501 with a reason naming the version to upgrade to, exactly
   * as it did before this route learned to remove anything. The capability
   * block on `GET /:slug/teams` reports the same verdict, so the operator UI
   * renders a disabled control instead of discovering it from a failure.
   *
   * ORDER MATTERS. Graph first, row second: the connector's removal is
   * idempotent (`already-absent` is success), so a crash between the two
   * leaves a retry that still converges. Clearing the row first and then
   * failing the Graph call would strand a live install nothing tracks — the
   * exact state this route refused to create back when it answered 501.
   */
  router.delete('/:slug/teams/:teamId', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const deps = teamsIdentity(res);
    if (!deps) return;
    try {
      const found = await teamsIdentityRow(req, res, live, deps);
      if (!found) return;
      const { agent, row } = found;
      const teamId = req.params['teamId'] ?? null;

      if (!deps.isProvisionerInstalled()) {
        res.status(503).json({
          error: 'teams_provisioner_unavailable',
          message:
            'teamsProvisioner@1 is not installed — install and activate the M365 connector plugin before removing an agent from a team.',
        });
        return;
      }
      const provisioner = deps.getProvisioner?.();
      const clearTeamInstall = deps.store.clearTeamInstall;
      if (!supportsTeamUninstall(provisioner) || typeof clearTeamInstall !== 'function') {
        res.status(501).json({
          error: 'teams_uninstall_unsupported',
          message: TEAMS_UNINSTALL_UNSUPPORTED_REASON,
          min_connector_version: TEAMS_UNINSTALL_MIN_CONNECTOR_VERSION,
          agent: agent.slug,
          team_id: teamId,
        });
        return;
      }

      // A run in flight owns this row's team_id and would re-install right
      // behind us. Refuse rather than race the job runner.
      if (deps.runner.isRunning(agent.id)) {
        res.status(409).json({
          error: 'teams_provisioning_running',
          message: `agent '${agent.slug}' has a provisioning run in flight — wait for it to finish before removing the app from a team.`,
          agent: agent.slug,
          team_id: teamId,
        });
        return;
      }

      // The read model only ever reports `row.teamId` on an `installed` row
      // (projectInstalledTeams), so anything else addresses an install this
      // middleware does not have. Saying so beats issuing a Graph delete for
      // a team the operator never installed into through omadia.
      // With migration 0051 the addressable set is the BINDINGS table; the
      // identity's single `team_id` is only a fallback for a mount without it.
      const binding =
        deps.installs && teamId !== null
          ? (await deps.installs.listForAgent(agent.id)).find(
              (entry) => entry.teamId === teamId,
            )
          : undefined;
      const hasLegacyInstall =
        deps.installs === undefined &&
        row.state === 'installed' &&
        row.teamId !== null &&
        row.teamId === teamId;
      if (binding === undefined && !hasLegacyInstall) {
        res.status(404).json({
          error: 'team_install_not_found',
          message: `agent '${agent.slug}' has no recorded install in team '${String(teamId)}' — GET /:slug/teams lists what can be removed.`,
          agent: agent.slug,
          team_id: teamId,
        });
        return;
      }

      // Snapshot before any write. `row` is whatever the store handed back,
      // and a store that patches its rows IN PLACE would otherwise have this
      // response report the CLEARED value — a 200 claiming `team_id: null`
      // for the team it just removed the app from.
      const installedTeamId = binding?.teamId ?? (row.teamId as string);
      // The binding records the catalog app that was installed into THIS team;
      // the identity's current `teams_app_id` is the fallback (and the only
      // answer a pre-0051 mount has).
      const installedAppId = binding?.teamsAppId ?? row.teamsAppId;
      if (!installedAppId) {
        // An install with no catalog app id cannot be addressed in Graph.
        // Inconsistent rather than unsupported — say which.
        res.status(409).json({
          error: 'teams_app_id_missing',
          message: `agent '${agent.slug}' is recorded as installed in team '${installedTeamId}' but carries no teams_app_id — the record cannot address the installation in Graph.`,
          agent: agent.slug,
          team_id: teamId,
        });
        return;
      }

      const uninstall = provisioner?.uninstallFromTeam;
      if (uninstall === undefined) {
        // Unreachable after supportsTeamUninstall; narrows for the compiler
        // without a non-null assertion.
        res.status(501).json({
          error: 'teams_uninstall_unsupported',
          message: TEAMS_UNINSTALL_UNSUPPORTED_REASON,
          min_connector_version: TEAMS_UNINSTALL_MIN_CONNECTOR_VERSION,
          agent: agent.slug,
          team_id: teamId,
        });
        return;
      }
      const result = await uninstall.call(provisioner, {
        teamId: installedTeamId,
        teamsAppId: installedAppId,
      });

      // Drop THIS binding. The identity is only walked back to
      // `catalog_uploaded` when nothing is left bound: an agent still
      // installed in another team is still installed, and demoting the state
      // would make the next read report every remaining binding as pending.
      let remaining: readonly OperatorTeamsInstallRecord[] = [];
      if (deps.installs) {
        await deps.installs.remove(agent.id, installedTeamId);
        remaining = await deps.installs.listForAgent(agent.id);
      }
      const clearIdentity =
        remaining.length === 0 &&
        (deps.installs === undefined || row.teamId === installedTeamId);
      const updated = clearIdentity
        ? await clearTeamInstall.call(deps.store, agent.id)
        : row;

      res.json({
        ok: true,
        agent: agent.slug,
        team_id: installedTeamId,
        // 'already-absent' is the connector's idempotent success: the app was
        // not in the team. The binding is dropped either way — that is the
        // point of an idempotent remove.
        outcome: result.outcome,
        already_absent: result.outcome === 'already-absent',
        state: updated.state,
        remaining_team_ids: remaining.map((entry) => entry.teamId),
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
