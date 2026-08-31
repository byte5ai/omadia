/**
 * Teams identity provisioning job runner — epic byte5ai/omadia#860, wave W1a.
 *
 * Drives one agent's Teams identity through the provisioning chain
 *
 *   pending → app_registered → bot_created → package_built
 *           → catalog_uploaded → installed            (terminal: failed)
 *
 * as an ASYNC, IN-PROCESS job: the operator endpoint enqueues and returns
 * immediately; status is queryable through the identity store row. Follows
 * the middleware's existing background-job precedents instead of inventing a
 * scheduler: {@link TimerSeam} (from `plugins/jobScheduler.ts`) makes every
 * retry/backoff delay injectable in tests, and {@link asBackgroundJob}
 * adapts the runner to the `BackgroundJobRegistry` lifecycle.
 *
 * Idempotent resume: a run re-enters at the stored state and leans on the
 * provisioner's 'already-existed' signals — completed steps are skipped via
 * the persisted columns (app_id/tenant_id/teams_app_id) together with the
 * state rank, and re-executed steps are safe because every remote call is
 * idempotent by a stable key (Graph `uniqueName`, ARM bot handle, catalog
 * `externalId`, team install). A row left in 'failed' resumes the same way:
 * evidence decides the entry point, so nothing is re-created.
 *
 * app_id is persisted the MOMENT the Entra registration exists, before the
 * client secret and the service principal (byte5ai/omadia#916) — an
 * interruption then leaves a resumable row instead of an app registration
 * the runner can never find again. Because such a row carries app_id while
 * the step is unfinished, step 1 is considered done only when the STATE says
 * so, never by the presence of app_id alone.
 *
 * Error policy (duck-typed guards — connector errors cross the plugin
 * boundary as plain `Error`s whose class identity is the plugin's, so
 * `instanceof` against local mirrors would never match):
 *   - ConsentMissingError   → TERMINAL: state 'failed', the missing scopes
 *                             recorded in last_error. Retrying cannot help
 *                             until an admin consents.
 *   - ArmNotConfiguredError / the accessor's typed 'registration-only'
 *     outcome → NOT terminal: state stays 'app_registered' with an
 *     actionable last_error naming the missing ARM setup fields.
 *   - ProvisioningThrottledError → retried within {@link maxAttempts},
 *     honoring the error's `retryAfterSeconds` hint over the default
 *     exponential backoff. Exhaustion keeps the reached state (progress is
 *     real) and records the throttle in last_error for a later re-run.
 *   - Provisioner unavailable (connector plugin not installed/active) →
 *     retried like a throttle without a hint; never a crash, never 'failed'.
 *   - Anything else → bounded retries, then state 'failed' with last_error.
 *
 * Hard constraint honored: NO Graph/ARM call happens here — every outbound
 * step goes through the injected `teamsProvisioner@1` accessor port, and the
 * bot messaging endpoint (`https://<public-base-url>/api/teams/<botSlug>/messages`,
 * per-bot route since channel-teams 0.20.0) is composed by the accessor
 * module's URL builder, injected as {@link buildMessagingEndpoint} — never
 * duplicated here.
 *
 * WIRING NOTE (reconciled by the wave's wiring unit): the store port and the
 * provisioner port below are STRUCTURAL subsets of, respectively, the
 * `agentTeamsIdentityStore` module and the `TeamsProvisionerAccessor` of
 * `platform/teamsProvisionerService.ts` — both built in parallel units of
 * this wave. The real implementations satisfy these ports as-is.
 */

import {
  TEAMS_PROVISIONING_STATES,
  type TeamsProvisioningState,
} from '../platform/agentTeamsIdentityStore.js';
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  adminConsentUrlOf,
  delegatedStepOf,
  isAccessTokenExpiring,
  isDelegatedConsentRequiredError,
  isDelegatedSignInRequiredError,
  isDelegatedTokenExpiredError,
  isDeviceCodeFlowError,
  isRecoverableByRefresh,
  requiredScopesOf,
  type DelegatedTokenSet,
} from '../platform/teamsDelegatedSignIn.js';
import type { TimerSeam } from '../plugins/jobScheduler.js';
import type {
  BackgroundJob,
  BackgroundJobHandle,
} from '../platform/backgroundJobRegistry.js';
import { normalizeTeamsTeamId } from '../platform/teamsTeamId.js';
import {
  isChatTarget,
  type TeamsTargetKind,
} from '../platform/teamsInstallTarget.js';

// ---------------------------------------------------------------------------
// State vocabulary — the CHECK constraint of agent_teams_identities
// (migration 0049): imported from the store module, which owns the single
// exported union (wave reconciliation of the parallel-unit mirror), and
// re-exported here for the runner's existing consumers.
// ---------------------------------------------------------------------------

export { TEAMS_PROVISIONING_STATES, type TeamsProvisioningState };

/** Progress rank; 'failed' ranks below everything so a resume re-checks each
 *  step (evidence columns + idempotent calls make that safe). */
const STATE_RANK: Readonly<Record<TeamsProvisioningState, number>> = {
  failed: -1,
  pending: 0,
  app_registered: 1,
  bot_created: 2,
  package_built: 3,
  catalog_uploaded: 4,
  installed: 5,
};

// ---------------------------------------------------------------------------
// Store port (structural subset of agentTeamsIdentityStore)
// ---------------------------------------------------------------------------

export interface TeamsIdentityJobRecord {
  readonly agentId: string;
  readonly botSlug: string;
  readonly displayName: string;
  readonly state: TeamsProvisioningState;
  readonly appId: string | null;
  /**
   * The Entra app's directory object id (migration 0055) — what the
   * teardown's purge needs and `appId` cannot substitute for.
   *
   * OPTIONAL on this structural port, like every other additive field here
   * (`targetKind` before it): a store or a test double that predates the
   * column still satisfies the type, and absent means the same as `null` —
   * the teardown re-resolves the id from Graph or from the recycle bin.
   */
  readonly appObjectId?: string | null;
  readonly tenantId: string | null;
  readonly teamsAppId: string | null;
  readonly teamsAppExternalId: string | null;
  readonly lastError: string | null;
}

export interface TeamsIdentityJobUpdate {
  readonly state?: TeamsProvisioningState;
  readonly appId?: string;
  readonly appObjectId?: string | null;
  readonly tenantId?: string;
  readonly teamsAppId?: string;
  readonly teamsAppExternalId?: string;
  /** `null` clears a previous error. */
  readonly lastError?: string | null;
}

/** The runner writes state/last_error EXCLUSIVELY through this port. */
export interface TeamsIdentityJobStore {
  getByAgentId(agentId: string): Promise<TeamsIdentityJobRecord | undefined>;
  update(
    agentId: string,
    patch: TeamsIdentityJobUpdate,
  ): Promise<TeamsIdentityJobRecord>;
}

/**
 * Where a COMPLETED install is recorded (`agent_teams_installs`, migration
 * 0051) — the persisted binding, as opposed to the identity row's `team_id`,
 * which is only ever the target of the run currently walking the chain.
 *
 * Written strictly AFTER Graph confirmed the install: the table answers "which
 * teams did omadia install this agent into", and a row written on intent would
 * make it answer a different, less useful question.
 *
 * Optional on the runner so a minimal mount (and every existing test) keeps
 * working; without it the runner behaves exactly as it did before migration
 * 0051, single-binding and all.
 */
export interface TeamsInstallJobStore {
  get(
    agentId: string,
    teamId: string,
  ): Promise<{ readonly teamId: string } | undefined>;
  record(input: {
    readonly agentId: string;
    readonly teamId: string;
    readonly teamsAppId?: string | null;
    readonly teamDisplayName?: string | null;
    /** Which kind of target the id addresses (migration 0054). Optional on
     *  the port so a mount predating it still satisfies the structural type;
     *  the store defaults it to `'team'`, which is what every pre-0054 row
     *  means. */
    readonly targetKind?: TeamsTargetKind;
  }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Progress log port (migration 0053, byte5ai/omadia#915)
// ---------------------------------------------------------------------------

/**
 * The steps the runner reports progress for.
 *
 * The five CHAIN steps carry the name of the state they PRODUCE, so the
 * operator UI can lay events straight onto the progress chain it already
 * renders instead of learning a second vocabulary. Two steps have no state of
 * their own:
 *
 *   * `run` — the run itself: one `started` when it begins, exactly one
 *     terminal event when it ends. It is what tells a UI apart "this run died
 *     in step 1" from "no run ever started", which look identical when the
 *     only evidence is a `pending` row.
 *   * `config_sync` — the post-install `teams_bots` write (#910). Its failure
 *     is a warning on a successful run, never the run's verdict.
 */
export const TEAMS_PROVISIONING_STEPS = [
  'run',
  'app_registered',
  'bot_created',
  'package_built',
  'catalog_uploaded',
  'installed',
  'config_sync',
] as const;

export type TeamsProvisioningStep = (typeof TEAMS_PROVISIONING_STEPS)[number];

/** The five chain steps, in order — everything a resume can find already
 *  done. `run` and `config_sync` are excluded because neither is a link of
 *  the chain and neither can be "already done". */
export const SKIPPABLE_CHAIN_STEPS = [
  'app_registered',
  'bot_created',
  'package_built',
  'catalog_uploaded',
  'installed',
] as const satisfies readonly TeamsProvisioningStep[];

/** Status vocabulary — mirrors `TEAMS_PROVISIONING_EVENT_STATUSES` in
 *  `platform/teamsProvisioningEventStore.ts` (the CHECK constraint of
 *  migration 0053). Structural, like every other port in this module. */
export type TeamsProvisioningEventStatus =
  | 'started'
  | 'progress'
  | 'retrying'
  | 'succeeded'
  | 'failed';

/**
 * Where the runner writes its progress notes (structural subset of
 * `TeamsProvisioningEventStore`).
 *
 * OPTIONAL BY DESIGN. A mount without Postgres, and every existing test, gets
 * no sink and behaves exactly as before — the log is decoration on a run, and
 * a run that needed it would be a run that depends on its own diary.
 *
 * MAY REJECT. Every call goes through {@link TeamsProvisioningJobRunner.emit},
 * which is the ONE place a write failure is swallowed. Nothing else in this
 * module guards a sink call.
 */
export interface TeamsProvisioningEventSink {
  record(input: {
    readonly agentId: string;
    readonly step: string;
    readonly status: TeamsProvisioningEventStatus;
    readonly attempt?: number | null;
    readonly detail?: string | null;
  }): Promise<unknown>;
  clearForAgent(agentId: string): Promise<unknown>;
}

/**
 * The `detail` of a `retrying` event, as a `key=value;…` token list.
 *
 * A retry is the one event whose copy needs numbers the operator can act on —
 * "attempt 3 of 5, next in 8s" — and migration 0053 has one free-form
 * `detail` column, not a column per number. So the shape is pinned HERE, next
 * to its only producer, and mirrored by a total, defensive parser in
 * `web-ui/app/_lib/teamsIdentity.ts`; an unparsable token there degrades to
 * "retrying" rather than to a crash.
 */
export function retryDetail(delayMs: number, maxAttempts: number): string {
  return `retry_in_ms=${String(Math.max(0, Math.round(delayMs)))};max_attempts=${String(maxAttempts)}`;
}

/** `detail` of a step event that had nothing to do — a resume re-entering
 *  above this step. Emitted rather than skipped so a resumed run shows five
 *  steps, not two; a gap in the timeline reads as a lost step. */
export const SKIPPED_DETAIL = 'skipped';

/** `detail` of the `started` event for the Entra app registration.
 *
 *  The connector polls Entra for replication inside `createAppRegistration`
 *  and can sit there for up to a minute. The runner cannot see into that call
 *  (it is another repo's contract), so instead of inventing progress it says
 *  up front that this step is the slow one — and then emits a real `progress`
 *  event from `onRegistrationCreated`, the one boundary the contract already
 *  exposes: the registration exists, the secret and service principal do not
 *  yet, and the replication wait is what happens next. */
export const AWAITING_ENTRA_REPLICATION_DETAIL = 'awaiting_entra_replication';

/** `detail` of that `progress` event — the app registration exists in Graph
 *  and its id is persisted; what follows is the wait. */
export const REGISTRATION_CREATED_DETAIL = 'registration_created';

/** `detail` of the `progress` event emitted when the catalog upload runs on
 *  the tenant's delegated sign-in rather than app-only (#924). No token, no
 *  account, no flow handle — just the fact, which is what an operator
 *  watching a stalled panel actually needs. */
export const DELEGATED_UPLOAD_DETAIL = 'delegated_upload';

/** `detail` of the `progress` event for a silent token rotation. Worth a line
 *  because it is the one moment the run pauses for a reason that is NOT a
 *  fault and that the operator would otherwise never see. */
export const DELEGATED_TOKEN_REFRESHED_DETAIL = 'delegated_token_refreshed';

// ---------------------------------------------------------------------------
// Delegated token custody port (#924)
// ---------------------------------------------------------------------------

/**
 * Where the tenant's delegated token set is kept — a structural subset of
 * `platform/teamsDelegatedTokenStore.ts`.
 *
 * TENANT-SCOPED, NOT AGENT-SCOPED, and that is the whole point of #924: one
 * admin signs in once, and every agent provisioned afterwards uses that sign-in.
 * There is deliberately no agent id in this port — adding one would re-create
 * the per-agent manual upload the feature exists to remove.
 *
 * OPTIONAL ON THE RUNNER. A mount without it (and every existing test) behaves
 * exactly as before: app-only upload, which is correct against a connector
 * older than 0.6.0 and against a tenant that never needed the delegated path.
 */
export interface TeamsDelegatedTokenPort {
  read(): Promise<DelegatedTokenSet | undefined>;
  /** Called the instant the connector reports `refreshed === true`. */
  write(tokens: DelegatedTokenSet): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provisioner port (structural subset of TeamsProvisionerAccessor)
// ---------------------------------------------------------------------------

export type IdempotentOutcome = 'created' | 'already-existed';

export interface Idempotent<T> {
  readonly outcome: IdempotentOutcome;
  readonly value: T;
}

export type TenantMode = 'customer' | 'home';

export interface ProvisionerAppRegistrationResult {
  readonly appId: string;
  readonly registration: {
    readonly tenantId: string;
    /**
     * The DIRECTORY OBJECT id (migration 0055) — a different identifier from
     * {@link appId} and the only one the recycle-bin purge accepts.
     *
     * Optional on the PORT although the connector contract always returns it,
     * because every existing test double predates it and a required field
     * would break them all for a value none of them exercises. The runner
     * persists it when it is there and shrugs when it is not; the teardown
     * (`services/teamsIdentityReset.ts`) can re-resolve it either way.
     */
    readonly objectId?: string;
  };
}

export interface ProvisionerRegistrationOnlyOutcome {
  readonly kind: 'registration-only';
  readonly reason: 'arm-not-configured';
  readonly missingSetupFields: readonly string[];
}

export interface ProvisionerBotOutcome {
  readonly kind: 'provisioned';
  readonly bot: Idempotent<{ readonly botName: string }>;
}

export interface TeamsAppPackageIcons {
  readonly color: Uint8Array;
  readonly outline: Uint8Array;
}

export type TeamsAppPackageParams = Readonly<
  Record<string, string | readonly string[]>
>;

/** The accessor methods the runner drives — one per chain step. */
export interface TeamsProvisionerPort {
  createAppRegistration(input: {
    readonly displayName: string;
    readonly tenantMode: TenantMode;
    readonly uniqueName?: string;
    readonly secretDisplayName?: string;
    /** Early-persistence hook — see the runner's step 1 (byte5ai/omadia#916). */
    readonly onRegistrationCreated?: (
      registration: {
        readonly appId: string;
        readonly tenantId: string;
        readonly objectId?: string;
      },
      outcome: IdempotentOutcome,
    ) => void | Promise<void>;
  }): Promise<Idempotent<ProvisionerAppRegistrationResult>>;

  createBot(input: {
    readonly botName: string;
    readonly displayName: string;
    readonly msaAppId: string;
    readonly msaAppTenantId: string;
    readonly messagingEndpoint: string;
  }): Promise<ProvisionerBotOutcome | ProvisionerRegistrationOnlyOutcome>;

  /** Pure, no network — renders the per-agent Teams app package zip. */
  buildAppPackage(input: {
    readonly manifestTemplate: string;
    readonly params: TeamsAppPackageParams;
    readonly icons: TeamsAppPackageIcons;
  }): Uint8Array;

  uploadToCatalog(input: {
    readonly packageZip: Uint8Array;
    readonly externalId: string;
  }): Promise<Idempotent<{ readonly teamsAppId: string }>>;

  /**
   * The DELEGATED catalog upload (connector >= 0.6.0, byte5ai/omadia#924).
   *
   * OPTIONAL, and the runner feature-detects it exactly like every other
   * version-skewed method: absent means an older connector, which keeps using
   * the app-only {@link uploadToCatalog} above and keeps failing the way it
   * always did against a tenant that requires delegated permissions.
   *
   * Returns the token set it used, with `refreshed` telling the caller whether
   * it rotated — a rotation MUST be persisted immediately or the next run
   * signs in from scratch.
   */
  uploadToCatalogDelegated?(input: {
    readonly packageZip: Uint8Array;
    readonly externalId: string;
    readonly tokens: DelegatedTokenSet;
  }): Promise<{
    readonly app: { readonly value: { readonly teamsAppId: string } };
    readonly tokens: DelegatedTokenSet;
    readonly refreshed: boolean;
  }>;

  /** Silent token refresh (connector >= 0.6.0). Optional for the same
   *  reason; without it an expired access token needs a human. */
  refreshDelegatedToken?(input: {
    readonly tokens: DelegatedTokenSet;
  }): Promise<DelegatedTokenSet>;

  getCatalogApp(input: {
    readonly teamsAppExternalId: string;
  }): Promise<{ readonly found: false } | { readonly found: true; readonly teamsAppId: string }>;

  installToTeam(input: {
    readonly teamId: string;
    readonly teamsAppId: string;
  }): Promise<Idempotent<{ readonly teamId: string; readonly teamsAppId: string }>>;

  /**
   * The CHAT direction — `POST /chats/{id}/installedApps` (connector >=
   * 0.7.0). Optional for the same version-skew reason as every other method
   * added after the oldest supported connector: feature-detect with
   * `typeof === 'function'`, never call it blind.
   *
   * Reached only for a `group-chat` / `one-on-one-chat` target
   * ({@link ProvisionTeamsIdentityRequest.targetKind}); a `team` target keeps
   * using {@link installToTeam} unchanged.
   */
  installToChat?(input: {
    readonly chatId: string;
    readonly teamsAppId: string;
  }): Promise<Idempotent<{ readonly chatId: string; readonly teamsAppId: string }>>;
}

/**
 * The chain reached its install step with a CHAT target, against a connector
 * that publishes no `installToChat` (< 0.7.0).
 *
 * A typed error rather than a crash, and raised by the runner as well as
 * refused by the route, because the two guard different moments: the route
 * refuses a NEW request up front (501, nothing enqueued), while a run that
 * RESUMES an older request can meet a connector that was downgraded since —
 * and a resumed run must fail with the same actionable sentence rather than a
 * `TypeError: installToChat is not a function`.
 */
export class TeamsChatInstallUnsupportedError extends Error {
  public readonly code = 'teams_chat_install_unsupported';

  constructor() {
    super(
      `the installed teamsProvisioner@1 publishes no installToChat method — upgrade @omadia/integration-microsoft365 to >= ${TEAMS_CHAT_INSTALL_MIN_CONNECTOR_VERSION}; until then an agent can only be installed into a team, not into a group chat.`,
    );
    this.name = 'TeamsChatInstallUnsupportedError';
  }
}

/** Minimum connector version whose `teamsProvisioner@1` installs into a chat.
 *  Quoted in the operator-facing reason so the fix is actionable. */
export const TEAMS_CHAT_INSTALL_MIN_CONNECTOR_VERSION = '0.7.0';

/** App-package inputs for one identity; loading is bound by the wiring unit
 *  (manifest template + icons ship with the channel-teams package). */
export interface TeamsAppPackageAssets {
  readonly manifestTemplate: string;
  readonly params: TeamsAppPackageParams;
  readonly icons: TeamsAppPackageIcons;
  /** Manifest id (`externalId`) — the catalog idempotency key. */
  readonly externalId: string;
}

export type TeamsAppPackageAssetLoader = (
  identity: TeamsIdentityJobRecord,
) => Promise<TeamsAppPackageAssets>;

// ---------------------------------------------------------------------------
// Bot handle composition (byte5ai/omadia#921)
// ---------------------------------------------------------------------------

/**
 * Azure bot handles live in ONE GLOBAL namespace shared by every Azure
 * customer — they behave like DNS labels, not like tenant- or
 * subscription-scoped resource names. The operator's `botSlug` is a local
 * label (`hr`, `sales`, `test-hr`); handing it to ARM raw means every natural
 * slug collides with a stranger's bot registered years ago, and the operator
 * reads "already registered to another bot application" as evidence of a
 * leftover of their own.
 *
 * So the runner qualifies the handle here, for the same reason it qualifies
 * `uniqueName` two steps below: the naming convention is the runner's, not
 * the connector's. The connector validates the RESULT against the ARM/Bot
 * Framework grammar (`requireBotName`) — it owns the rules, we own the shape.
 *
 * Shape: `omadia-<slug>-<first appId segment>`. The app registration always
 * runs first, so its `appId` GUID is available and already globally unique;
 * its first segment is 8 hex chars, enough to separate two omadia
 * installations that picked the same slug while staying readable in the
 * portal.
 *
 * TRUNCATION CUTS THE SLUG, NEVER THE SUFFIX — shortening the unique part
 * would reintroduce exactly the collision this function exists to prevent.
 * The slug is normalised to the handle charset (lowercased, every run of
 * non-alphanumerics folded to a single hyphen) and then trimmed to whatever
 * budget the fixed parts leave.
 */
export const BOT_HANDLE_PREFIX = 'omadia';
/** Bot Framework's upper bound; the connector enforces the same number. */
export const BOT_HANDLE_MAX_LENGTH = 42;
/** Hex characters of the appId taken as the uniqueness suffix. */
export const BOT_HANDLE_APP_ID_SEGMENT_LENGTH = 8;

export function buildBotHandle(botSlug: string, appId: string): string {
  const suffix = appId
    .replace(/[^0-9a-fA-F]/g, '')
    .slice(0, BOT_HANDLE_APP_ID_SEGMENT_LENGTH)
    .toLowerCase();
  if (suffix.length === 0) {
    throw new TeamsProvisioningJobError(
      `cannot build a bot handle: app id '${appId}' has no hex characters to qualify the slug with`,
    );
  }
  // `omadia` + `-` + slug + `-` + suffix — the slug gets whatever is left.
  const budget =
    BOT_HANDLE_MAX_LENGTH - BOT_HANDLE_PREFIX.length - 2 - suffix.length;
  const normalized = botSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slugPart = normalized.slice(0, Math.max(budget, 0)).replace(/-+$/g, '');
  return slugPart.length > 0
    ? `${BOT_HANDLE_PREFIX}-${slugPart}-${suffix}`
    : `${BOT_HANDLE_PREFIX}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Duck-typed connector error guards (see module doc on why not instanceof)
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function missingScopesOf(err: unknown): readonly string[] | undefined {
  if (!(err instanceof Error) || err.name !== 'ConsentMissingError') return undefined;
  const scopes = (err as Error & { missingScopes?: unknown }).missingScopes;
  return isStringArray(scopes) ? scopes : [];
}

function throttleHintOf(err: unknown): { retryAfterSeconds?: number } | undefined {
  if (!(err instanceof Error) || err.name !== 'ProvisioningThrottledError') {
    return undefined;
  }
  const hint = (err as Error & { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof hint === 'number' && Number.isFinite(hint) && hint >= 0
    ? { retryAfterSeconds: hint }
    : {};
}

function missingSetupFieldsOf(err: unknown): readonly string[] | undefined {
  if (!(err instanceof Error) || err.name !== 'ArmNotConfiguredError') return undefined;
  const fields = (err as Error & { missingSetupFields?: unknown }).missingSetupFields;
  return isStringArray(fields) ? fields : [];
}

/**
 * The connector's typed verdict that the global bot handle is taken (#921).
 * Duck-typed like every other cross-plugin guard in this module.
 */
function botHandleUnavailableOf(err: unknown): { readonly botName?: string } | undefined {
  if (!(err instanceof Error) || err.name !== 'BotHandleUnavailableError') {
    return undefined;
  }
  const botName = (err as Error & { botName?: unknown }).botName;
  return typeof botName === 'string' ? { botName } : {};
}

/**
 * Would re-running this step UNCHANGED plausibly produce a different answer?
 *
 * A `ProvisioningRequestError` carrying a deterministic 4xx says no: the
 * request was rejected on its content, and the content is identical next
 * time. Retrying it five times (which is what this runner did until #921 —
 * `retryable` was computed but only consulted at exhaustion) buys nothing but
 * a slower failure and a misleading "gave up after 5 attempts".
 *
 * 408 and 429 are excluded because they ARE time-dependent, and 403 never
 * reaches here — `ConsentMissingError` is handled above. This guard is
 * deliberately connector-version-independent: an older connector that still
 * reports a taken handle as an untyped 400 also stops after one attempt.
 */
const TIME_DEPENDENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

function isDeterministicRequestFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'ProvisioningRequestError') return false;
  const status = (err as Error & { status?: unknown }).status;
  if (typeof status !== 'number') return false;
  return status >= 400 && status < 500 && !TIME_DEPENDENT_CLIENT_STATUSES.has(status);
}

function isProvisionerUnavailable(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TeamsProvisionerUnavailableError' ||
      (err as Error & { code?: unknown }).code === 'teams_provisioner_unavailable')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class TeamsProvisioningJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsProvisioningJobError';
  }
}

export interface ProvisionTeamsIdentityRequest {
  readonly agentId: string;
  /**
   * The install TARGET id. Historically a team (group) id — hence the name,
   * which is kept because it is also the column name and the request field on
   * the wire — but since the chat targets of `platform/teamsInstallTarget.ts`
   * it may equally be a chat conversation id (`19:…@thread.v2`,
   * `19:…@unq.gbl.spaces`). {@link targetKind} says which.
   */
  readonly teamId: string;
  /**
   * WHICH KIND of target {@link teamId} addresses, and therefore which Graph
   * endpoint installs into it.
   *
   * The runner does NOT classify: the string arrives already decided, from
   * `resolveTeamsInstallTarget` at the route (for a new request) or from the
   * identity row's persisted `target_kind` (for a resume). Two reasons that
   * both matter:
   *
   *   * a bare 32-hex id is genuinely ambiguous between a team group id and a
   *     chat stem, and the context that resolves it lives with the operator,
   *     not in the runner;
   *   * re-deriving here would make the runner a SECOND classifier, free to
   *     disagree with the one that validated the request — and the endpoint
   *     it picked would then differ from the one the operator was told about.
   *
   * Defaults to `'team'` when absent, which is what every caller before this
   * change meant and what every stored row records.
   */
  readonly targetKind?: TeamsTargetKind;
  /**
   * #914 — re-render and re-upload the app package for an identity that is
   * already `installed`. Set by the identity routes after an edit that
   * changed what the package contains (name, description, accent colour,
   * avatar): without it, {@link TeamsProvisioningJobRunner} short-circuits at
   * `installed` and the tenant keeps serving the package built from the old
   * identity.
   *
   * Only meaningful for an installed row — every other state rebuilds anyway.
   * A republish enqueued while a normal run for the same team is in flight
   * JOINS that run (see {@link TeamsProvisioningJobRunner.enqueue}); the
   * identity write that triggered it is already persisted, so the worst case
   * is one more explicit "re-run provisioning" click, not a lost edit.
   */
  readonly republish?: boolean;
}

export type ProvisioningRunResult =
  | { readonly status: 'installed'; readonly agentId: string }
  | {
      readonly status: 'halted';
      readonly agentId: string;
      readonly reason: 'arm_not_configured';
      readonly missingSetupFields: readonly string[];
    }
  | {
      /**
       * #924 — the delegated catalog upload cannot proceed until a tenant
       * admin has signed in (or consented). NOT a failure: every step already
       * taken is real, the row keeps its state, and the run resumes from here
       * the moment the sign-in exists. A run that fell to `failed` because
       * nobody had signed in yet would send an operator hunting a fault that
       * is not there — and would drop the chain's evidence with it.
       */
      readonly status: 'halted';
      readonly agentId: string;
      readonly reason:
        | 'delegated_sign_in_required'
        | 'delegated_consent_required'
        | 'delegated_token_expired';
      readonly detail: string;
    }
  | {
      readonly status: 'failed';
      readonly agentId: string;
      readonly reason:
        | 'consent_missing'
        | 'bot_handle_unavailable'
        /** #924 — the device-code flow itself is broken (publisher app not
         *  configured for it, Conditional Access refusing it). Terminal:
         *  retrying the same flow produces the same refusal. */
        | 'device_code_flow_failed'
        /** Graph refused the install because the app package's
         *  resource-specific permissions exceed what the installing identity
         *  may consent to. Terminal: a tenant role grant fixes it, a retry
         *  does not. */
        | 'rsc_permissions_mismatch'
        | 'error';
      readonly detail: string;
    }
  | {
      readonly status: 'retries_exhausted';
      readonly agentId: string;
      readonly detail: string;
    }
  | {
      /**
       * Refused outright — nothing enqueued, nothing joined, so a caller can
       * never be handed somebody else's outcome. Two causes:
       *
       *   * `'team_conflict'` — a run for the SAME agent but a DIFFERENT team
       *     is in flight;
       *   * `'exclusive_lease'` — a non-provisioning operation holds this
       *     agent (today: a teardown, {@link
       *     TeamsProvisioningJobRunner.acquireExclusive}). Provisioning into
       *     an identity whose Azure objects are being deleted underneath it
       *     would race the two against each other over the same app
       *     registration.
       */
      readonly status: 'rejected';
      readonly agentId: string;
      readonly reason: 'team_conflict' | 'exclusive_lease';
      readonly detail: string;
    }
  | { readonly status: 'stopped'; readonly agentId: string };

/**
 * Outcome of the post-provisioning `teams_bots` config write (#910). A
 * structural subset of `TeamsBotsConfigSyncOutcome` in
 * `services/teamsBotsConfigSync.ts` — the runner only needs to know whether
 * something was written, so it can log it; every branch is non-fatal.
 */
export interface TeamsBotsConfigSyncReport {
  readonly status: 'synced' | 'unchanged' | 'skipped';
  readonly reason?: string;
}

/**
 * Write this identity's entry into the channel-teams plugin config and reload
 * the plugin, so the provisioned bot answers without a restart (#910).
 *
 * Optional: a wiring without an installed registry (tests, minimal mounts)
 * simply leaves the operator on the documented copy-paste path.
 *
 * MAY REJECT. The runner treats a rejection as a warning on an
 * already-successful run — see {@link TeamsProvisioningJobRunner} on why the
 * identity is never rolled back for it.
 */
export type TeamsBotsConfigSyncPort = (
  identity: TeamsIdentityJobRecord,
) => Promise<TeamsBotsConfigSyncReport>;

export interface TeamsProvisioningJobOptions {
  readonly store: TeamsIdentityJobStore;
  /** Resolves the accessor; throws its typed 'unavailable' error when the
   *  connector plugin is not installed/active. */
  readonly getProvisioner: () => TeamsProvisionerPort;
  /** The accessor module's URL builder, bound to the public base URL by the
   *  wiring unit. NEVER reimplemented here. */
  readonly buildMessagingEndpoint: (botSlug: string) => string;
  readonly loadPackageAssets: TeamsAppPackageAssetLoader;
  readonly tenantMode?: TenantMode;
  /** Chain attempts per run, including the first (default 5). */
  readonly maxAttempts?: number;
  /** First retry delay for hint-less retryable failures (default 5s). */
  readonly baseRetryDelayMs?: number;
  /** Backoff cap (default 5 min). */
  readonly maxRetryDelayMs?: number;
  /** Test seam — defaults to real timers. */
  readonly timers?: TimerSeam;
  /** #910 — the finishing move that makes the bot live. Absent means the
   *  operator configures channel-teams by hand, exactly as before. */
  readonly syncBotConfig?: TeamsBotsConfigSyncPort;
  /** Persisted team↔agent bindings (migration 0051). Absent = pre-0051
   *  behaviour: the identity row's `team_id` is the only record there is. */
  readonly installs?: TeamsInstallJobStore;
  /**
   * Resolve a team id to its Graph display name, or `null` when the lookup is
   * unsupported / the team is not visible. Best-effort decoration of the
   * binding, never a gate on the install: feature detection against the
   * connector lives in the WIRING (`supportsTeamLookup`), so the runner has
   * no opinion about connector versions.
   */
  readonly resolveTeamName?: (teamId: string) => Promise<string | null>;
  /**
   * Progress log (migration 0053, #915). Absent = pre-0053 behaviour: the
   * run is identical, it simply leaves no timeline behind.
   */
  readonly events?: TeamsProvisioningEventSink;
  /**
   * #924 — the tenant's delegated token set. Absent means app-only catalog
   * upload, i.e. exactly the pre-0.6.0 behaviour.
   */
  readonly delegatedTokens?: TeamsDelegatedTokenPort;
  /**
   * Wall clock, injectable. Used only to decide whether a delegated access
   * token is close enough to its expiry to be refreshed BEFORE the call that
   * would otherwise discover it the hard way — a decision that has to be
   * testable without waiting an hour. Named `now` to match
   * `platform/teamsDelegatedTokenStore.ts`, which seams the clock the same
   * way for the same question.
   */
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 300_000;
/** Node's setTimeout ceiling (2^31 − 1 ms) — a longer delay would overflow
 *  to ~1 ms and burn the whole retry budget instantly. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const REAL_TIMERS: TimerSeam = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export class TeamsProvisioningJobRunner {
  private readonly store: TeamsIdentityJobStore;
  private readonly getProvisioner: () => TeamsProvisionerPort;
  private readonly buildMessagingEndpoint: (botSlug: string) => string;
  private readonly loadPackageAssets: TeamsAppPackageAssetLoader;
  private readonly tenantMode: TenantMode;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly timers: TimerSeam;
  private readonly syncBotConfig: TeamsBotsConfigSyncPort | undefined;
  private readonly installs: TeamsInstallJobStore | undefined;
  private readonly resolveTeamName:
    | ((teamId: string) => Promise<string | null>)
    | undefined;
  private readonly events: TeamsProvisioningEventSink | undefined;
  private readonly delegatedTokens: TeamsDelegatedTokenPort | undefined;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  /**
   * Runs this runner holds.
   *
   * `settled` is what makes {@link isRunning} honest (byte5ai/omadia#915).
   * The entry itself is removed in `enqueue`'s `.finally()`, which is one
   * full turn of the microtask queue AND — on the installed path — a couple
   * of network round trips after the terminal state was persisted. A status
   * request landing in that window used to be answered `state: 'failed',
   * running: true`, i.e. a terminal verdict presented as work in progress.
   * The flag is set the instant the run has its verdict, before anything
   * awaits again, so no request can observe the contradiction.
   */
  private readonly inFlight = new Map<
    string,
    {
      readonly teamId: string;
      readonly run: Promise<ProvisioningRunResult>;
      settled: boolean;
    }
  >();
  /** Step each in-flight run is currently inside, so a failure classified in
   *  {@link handleFailure} — which is deliberately step-agnostic — can still
   *  say WHICH step it is retrying. One run per agent is guaranteed by
   *  {@link inFlight}, so an agent id is a sufficient key. */
  private readonly currentStep = new Map<string, TeamsProvisioningStep>();
  /**
   * Agents held by an operation that is NOT a provisioning run — today only
   * the teardown (`services/teamsIdentityReset.ts`), reserved through
   * {@link acquireExclusive}.
   *
   * Kept next to {@link inFlight} rather than inside it because the two hold
   * different things: `inFlight` holds a promise a second caller can JOIN,
   * and there is nothing joinable about a teardown — a caller who arrives
   * mid-teardown must be refused, not handed its result. Sharing the map
   * would have meant giving every entry a nullable `run` and a discriminator
   * for the sake of one extra state.
   *
   * The value is a short label, so a refusal can say WHAT is holding the
   * agent instead of only that something is.
   */
  private readonly leases = new Map<string, string>();
  private readonly pendingSleeps = new Set<() => void>();
  private stopped = false;

  constructor(opts: TeamsProvisioningJobOptions) {
    this.store = opts.store;
    this.getProvisioner = opts.getProvisioner;
    this.buildMessagingEndpoint = opts.buildMessagingEndpoint;
    this.loadPackageAssets = opts.loadPackageAssets;
    this.tenantMode = opts.tenantMode ?? 'customer';
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseRetryDelayMs = opts.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.maxRetryDelayMs = Math.min(
      opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      MAX_TIMER_DELAY_MS,
    );
    this.timers = opts.timers ?? REAL_TIMERS;
    this.syncBotConfig = opts.syncBotConfig;
    this.installs = opts.installs;
    this.resolveTeamName = opts.resolveTeamName;
    this.events = opts.events;
    this.delegatedTokens = opts.delegatedTokens;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /**
   * Fire-and-forget entry point for the operator endpoint: starts (or joins)
   * the run for this agent and returns immediately. One run per agent at a
   * time — a concurrent enqueue for the SAME team joins the in-flight run; a
   * concurrent enqueue for a DIFFERENT team is refused with a 'rejected'
   * result (never silently handed the other team's outcome).
   */
  enqueue(request: ProvisionTeamsIdentityRequest): Promise<ProvisioningRunResult> {
    // Checked BEFORE the in-flight lookup: a leased agent has no in-flight
    // run to join, and falling through would refuse it with `team_conflict`,
    // which names the wrong problem and sends the operator looking for a
    // second team that does not exist.
    const lease = this.leases.get(request.agentId);
    if (lease !== undefined) {
      return Promise.resolve({
        status: 'rejected',
        agentId: request.agentId,
        reason: 'exclusive_lease',
        detail: `'${lease}' is in progress for this agent — wait for it to finish, then run provisioning again`,
      });
    }
    const existing = this.inFlight.get(request.agentId);
    if (existing) {
      if (existing.teamId === request.teamId) return existing.run;
      return Promise.resolve({
        status: 'rejected',
        agentId: request.agentId,
        reason: 'team_conflict',
        detail: `a provisioning run targeting team '${existing.teamId}' is already in flight for this agent — wait for it to finish, then re-run for team '${request.teamId}'`,
      });
    }
    const run = this.runWithRetries(request)
      .catch((err): ProvisioningRunResult => {
        // Defensive: runWithRetries handles its own failures; a throw here is
        // a runner bug. Log, never crash the process from a background job.
        this.log(
          `[teams-provisioning] run for ${request.agentId} threw unexpectedly: ${errorMessage(err)}`,
        );
        return {
          status: 'failed',
          agentId: request.agentId,
          reason: 'error',
          detail: errorMessage(err),
        };
      })
      .finally(() => {
        this.inFlight.delete(request.agentId);
        this.currentStep.delete(request.agentId);
      });
    this.inFlight.set(request.agentId, {
      teamId: request.teamId,
      run,
      settled: false,
    });
    return run;
  }

  /**
   * Is a run for this agent still WORKING? (byte5ai/omadia#915)
   *
   * Not "is there a map entry" — an entry outlives the verdict by a microtask
   * turn on the failure path and by two network calls on the installed one
   * (the binding write and the `teams_bots` config sync both run after the
   * terminal state is persisted). Reporting `true` there is what produced the
   * `state: 'failed', running: true` responses of #915. A run that has
   * reached its verdict is not running any more, whatever the map still
   * holds.
   *
   * Note what this deliberately does NOT do: suppress `running` because the
   * ROW says `installed` or `failed`. Since migration 0051 an installed agent
   * can be legitimately provisioning into a second team, and a re-run of a
   * failed row is running before it writes its first state. The contradiction
   * is fixed by making the runner's own answer honest, not by second-guessing
   * it from the row.
   */
  isRunning(agentId: string): boolean {
    // A held lease counts as running, and it has to: the operator screen asks
    // this to decide whether work is happening on the agent, and a teardown
    // deleting an app registration is emphatically work. Reporting `false`
    // would also let the UI offer a second teardown next to the one already
    // going.
    if (this.leases.has(agentId)) return true;
    const entry = this.inFlight.get(agentId);
    return entry !== undefined && !entry.settled;
  }

  /**
   * Reserve this agent for an operation that is not a provisioning run, and
   * return the function that gives it back — or `null` when the agent is
   * already busy.
   *
   * THE MUTUAL EXCLUSION IS THE POINT. A teardown deletes the Entra app the
   * chain is mid-way through building on; running both at once means one of
   * them is operating on objects the other is removing, and neither can
   * report a truthful outcome. The lock lives HERE, on the runner, because
   * the runner is the only thing that already knows what is in flight — a
   * second lock elsewhere would be a second opinion about the same question.
   *
   * The release is a closure rather than a `release(agentId)` method so a
   * caller cannot release somebody else's lease, and it is idempotent so a
   * `finally` that runs twice is harmless.
   */
  acquireExclusive(agentId: string, label: string): (() => void) | null {
    // `inFlight.has`, not `isRunning`: a run that has its verdict but is
    // still writing its bindings and its plugin config is not something a
    // teardown may start deleting underneath.
    if (this.inFlight.has(agentId) || this.leases.has(agentId)) return null;
    this.leases.set(agentId, label);
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.leases.delete(agentId);
    };
  }

  /** What is holding this agent, or `null` — so a route can name the
   *  conflict in its refusal instead of saying "busy". */
  exclusiveLease(agentId: string): string | null {
    return this.leases.get(agentId) ?? null;
  }

  /**
   * The team an in-flight run is installing into, or `null` when nothing is
   * running for this agent.
   *
   * Exposed for the operator routes: `agent_teams_identities` keeps a SINGLE
   * `team_id` column, so re-targeting a run that is already under way would
   * overwrite the only record of where the app is actually being installed.
   * {@link enqueue} refuses that with a `rejected` RESULT — it does NOT
   * reject the promise — which a fire-and-forget caller cannot observe in
   * time to answer the request. Reading the in-flight target lets the route
   * refuse BEFORE it mutates the row.
   *
   * Deliberately keyed on map PRESENCE, not on {@link isRunning}: this exists
   * to predict {@link enqueue}'s refusal, and enqueue refuses while the entry
   * is there — settled or not. A route that used the softer answer would
   * accept a re-target enqueue that the runner then rejects behind its back.
   */
  runningTeamId(agentId: string): string | null {
    return this.inFlight.get(agentId)?.teamId ?? null;
  }

  // -------------------------------------------------------------------------
  // Progress log (migration 0053, #915)
  // -------------------------------------------------------------------------

  /**
   * THE choke point for the progress log — the single place a sink failure is
   * swallowed.
   *
   * Everything about this log is decoration: nothing reads it to decide
   * anything, resume runs off the identity row, and a run that failed because
   * its diary entry did not write would be an outage manufactured by an
   * observability feature. So a rejection is logged and dropped, and no emit
   * site anywhere else in this class carries a `try`/`catch`.
   *
   * Awaited rather than fire-and-forget so the timeline keeps insertion
   * order: two events racing on the same connection pool could otherwise land
   * out of sequence, and an out-of-order timeline is worse than none.
   */
  private async emit(
    agentId: string,
    step: TeamsProvisioningStep,
    status: TeamsProvisioningEventStatus,
    extra?: { readonly attempt?: number; readonly detail?: string },
  ): Promise<void> {
    if (status === 'started') this.currentStep.set(agentId, step);
    const sink = this.events;
    if (!sink) return;
    try {
      await sink.record({
        agentId,
        step,
        status,
        ...(extra?.attempt !== undefined ? { attempt: extra.attempt } : {}),
        ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
      });
    } catch (err) {
      this.log(
        `[teams-provisioning] progress event (${step}/${status}) for ${agentId} was not recorded: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Open a fresh timeline for the run that is about to start.
   *
   * The log describes ONE run (migration 0053): an operator clicking "run
   * provisioning again" is asking about the run they just started, not about
   * the one that failed yesterday, and concatenating the two would show the
   * same step succeeding and failing with nothing to say which was which.
   * Same swallow policy as {@link emit} — a clear that fails leaves stale
   * events, which the store's per-agent cap then bounds.
   */
  private async beginEventLog(agentId: string): Promise<void> {
    const sink = this.events;
    if (sink) {
      try {
        await sink.clearForAgent(agentId);
      } catch (err) {
        this.log(
          `[teams-provisioning] could not clear the previous progress log of ${agentId}: ${errorMessage(err)}`,
        );
      }
    }
    await this.emit(agentId, 'run', 'started');
  }

  /**
   * Close the timeline: mark the step that died (when one did), then write
   * the run's single terminal event.
   *
   * `installed` is the only success. Every other outcome carries a
   * machine-readable reason — a code the UI localizes, never prose it has to
   * parse. A `stopped` run gets no step-level failure: a shutdown did not
   * break the step it interrupted, and saying it did would send an operator
   * hunting a fault that is not there.
   */
  private async endEventLog(result: ProvisioningRunResult): Promise<void> {
    const agentId = result.agentId;
    if (result.status === 'installed') {
      await this.emit(agentId, 'run', 'succeeded');
      return;
    }
    const reason =
      result.status === 'halted' || result.status === 'failed'
        ? result.reason
        : result.status;
    const step = this.currentStep.get(agentId);
    if (step !== undefined && step !== 'run' && result.status !== 'stopped') {
      await this.emit(agentId, step, 'failed', { detail: reason });
    }
    await this.emit(agentId, 'run', 'failed', { detail: reason });
  }

  /** Mark this agent's run as no longer working — see {@link isRunning}.
   *  Synchronous on purpose: it has to land before the next `await`, or the
   *  window it closes reopens. */
  private markSettled(agentId: string): void {
    const entry = this.inFlight.get(agentId);
    if (entry) entry.settled = true;
  }

  /** Stop accepting work and release every pending retry delay. An
   *  in-flight accessor call finishes on its own; its run then ends at the
   *  next stop-check between chain steps (that step's own store write has
   *  already landed; no further step starts). Idempotent; a later
   *  {@link asBackgroundJob} start() re-arms the runner. */
  stop(): void {
    this.stopped = true;
    for (const release of [...this.pendingSleeps]) release();
    this.pendingSleeps.clear();
  }

  /** Adapter for the BackgroundJobRegistry lifecycle precedent. start()
   *  clears a previous stop() so a stopAll → start cycle (registry restart)
   *  yields a working runner again instead of one that answers every
   *  enqueue with 'stopped'. */
  asBackgroundJob(): BackgroundJob {
    const handle: BackgroundJobHandle = { stop: () => this.stop() };
    return {
      name: 'teams-identity-provisioning',
      start: () => {
        this.stopped = false;
        return handle;
      },
    };
  }

  /**
   * One run, start to verdict, with its progress log around it.
   *
   * ORDER MATTERS HERE. {@link markSettled} runs BEFORE the terminal event is
   * written and before anything else awaits: between the terminal state
   * reaching Postgres inside {@link attemptLoop} and this line there is only
   * microtask continuation — no timer, no I/O — and Node drains the microtask
   * queue before it services the next request. That is what makes it
   * impossible for a status request to observe `failed` + `running: true`
   * (#915). Writing the event first would reintroduce the window it closes.
   */
  private async runWithRetries(
    request: ProvisionTeamsIdentityRequest,
  ): Promise<ProvisioningRunResult> {
    await this.beginEventLog(request.agentId);
    const result = await this.attemptLoop(request);
    this.markSettled(request.agentId);
    await this.endEventLog(result);
    return result;
  }

  private async attemptLoop(
    request: ProvisionTeamsIdentityRequest,
  ): Promise<ProvisioningRunResult> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.stopped) return { status: 'stopped', agentId: request.agentId };
      try {
        return await this.advance(request);
      } catch (err) {
        const outcome = await this.handleFailure(request, err, attempt);
        if (outcome) return outcome;
        // else: retry delay already awaited — loop again.
      }
    }
    // Unreachable: handleFailure returns a result on the final attempt.
    return { status: 'stopped', agentId: request.agentId };
  }

  /** Classify a chain failure. Returns a final result, or undefined after
   *  having awaited the appropriate retry delay. */
  private async handleFailure(
    request: ProvisionTeamsIdentityRequest,
    err: unknown,
    attempt: number,
  ): Promise<ProvisioningRunResult | undefined> {
    const { agentId } = request;
    // NOTE ON WHERE THE `failed` EVENT IS WRITTEN. Every terminal branch
    // below persists the verdict and returns; the matching progress event is
    // emitted by {@link endEventLog}, AFTER {@link markSettled}. Emitting it
    // here would put a database round trip between the terminal state write
    // and the settle — exactly the window #915 is about. A `retrying` event
    // is different and stays here: nothing is terminal at that point.

    if (err instanceof TeamsProvisioningJobError) {
      // Precondition failure (e.g. no identity row) — retrying cannot help,
      // and there may be no row to record the error on.
      return { status: 'failed', agentId, reason: 'error', detail: err.message };
    }

    const scopes = missingScopesOf(err);
    if (scopes !== undefined) {
      // TERMINAL — an admin has to consent; retrying is pointless.
      const detail = consentMissingDetail(scopes);
      await this.recordError(agentId, { state: 'failed', lastError: detail });
      return { status: 'failed', agentId, reason: 'consent_missing', detail };
    }

    const setupFields = missingSetupFieldsOf(err);
    if (setupFields !== undefined) {
      // NOT terminal — partial success: the app registration exists, only the
      // ARM leg is unconfigured. Keep state app_registered, tell the operator
      // exactly what to configure.
      const detail = armNotConfiguredDetail(setupFields);
      await this.recordError(agentId, { state: 'app_registered', lastError: detail });
      return {
        status: 'halted',
        agentId,
        reason: 'arm_not_configured',
        missingSetupFields: setupFields,
      };
    }

    const takenHandle = botHandleUnavailableOf(err);
    if (takenHandle !== undefined) {
      // TERMINAL and DETERMINISTIC — the global namespace will not free the
      // name on the next attempt. Fail on attempt 1 with an explanation
      // instead of five identical 400s (#921).
      const detail = botHandleUnavailableDetail(errorMessage(err), takenHandle.botName);
      await this.recordError(agentId, { state: 'failed', lastError: detail });
      return { status: 'failed', agentId, reason: 'bot_handle_unavailable', detail };
    }

    // #924 — THE FOUR DELEGATED ERRORS, EACH WITH A DIFFERENT INSTRUCTION.
    // They are classified before the throttle/deterministic paths below
    // because none of them is a transport problem and none is fixable by
    // retrying: three need a specific human action and the fourth needs a
    // configuration change on the publisher app. Collapsing them into one
    // "delegated failed" would collapse four different instructions into an
    // operator staring at a dead end.
    //
    // Three of the four PARK rather than fail. The Entra app, the Azure bot
    // and the built package all exist and are this agent's; the only thing
    // missing is a sign-in. A row that dropped to `failed` would throw that
    // evidence away and re-walk the chain on the next run.

    if (isDelegatedSignInRequiredError(err)) {
      const detail = delegatedSignInRequiredDetail(
        requiredScopesOf(err),
        delegatedStepOf(err),
      );
      await this.recordError(agentId, { lastError: detail });
      return { status: 'halted', agentId, reason: 'delegated_sign_in_required', detail };
    }

    if (isDelegatedConsentRequiredError(err)) {
      // The consent URL is the difference between an actionable message and a
      // dead end, so it travels in `last_error` — it is a public Microsoft URL
      // naming a tenant and a client id, not a credential. It is validated as
      // absolute https by `adminConsentUrlOf` before it gets anywhere near a
      // link, and it is NOT put into a progress-event detail.
      const detail = delegatedConsentRequiredDetail(
        requiredScopesOf(err),
        adminConsentUrlOf(err),
      );
      await this.recordError(agentId, { lastError: detail });
      return { status: 'halted', agentId, reason: 'delegated_consent_required', detail };
    }

    if (isDelegatedTokenExpiredError(err)) {
      // The refreshable case is recovered inside `uploadPackage` and never
      // reaches here; arriving with one means the refresh itself failed, which
      // has the same answer as the invalid one — sign in again. Its OWN code,
      // though, not `delegated_sign_in_required`: "your sign-in expired" and
      // "nobody has ever signed in" send an operator to the same button for
      // different reasons, and only one of them is worth investigating.
      const detail = delegatedTokenExpiredDetail(err.reason);
      await this.recordError(agentId, { lastError: detail });
      return { status: 'halted', agentId, reason: 'delegated_token_expired', detail };
    }

    if (isDeviceCodeFlowError(err)) {
      // TERMINAL and DETERMINISTIC: the flow is refused by configuration, not
      // by load. Retrying it five times produces five identical refusals.
      const detail = deviceCodeFlowFailedDetail(errorMessage(err), err.oauthError);
      await this.recordError(agentId, { state: 'failed', lastError: detail });
      return { status: 'failed', agentId, reason: 'device_code_flow_failed', detail };
    }

    const throttle = throttleHintOf(err);

    if (throttle === undefined && isDeterministicRequestFailure(err)) {
      // A 4xx on identical input is a verdict, not a hiccup — see
      // isDeterministicRequestFailure. Stop now, keep the reached state's
      // evidence, and report the real reason on attempt 1.
      const detail = `${errorMessage(err)} (deterministic — not retried)`;
      await this.recordError(agentId, { state: 'failed', lastError: detail });
      return { status: 'failed', agentId, reason: 'error', detail };
    }

    const retryable = throttle !== undefined || isProvisionerUnavailable(err);

    if (attempt >= this.maxAttempts) {
      // A throttle exhaustion is its OWN code — the operator can simply come
      // back later, so the UI must be able to say that without reading prose.
      const detail =
        throttle !== undefined
          ? throttledDetail(errorMessage(err), attempt, throttle.retryAfterSeconds)
          : `${errorMessage(err)} (gave up after ${attempt} attempts)`;
      if (retryable) {
        // Progress states are real — keep them, record why the run stopped so
        // a later re-run resumes from the same point.
        await this.recordError(agentId, { lastError: detail });
        return { status: 'retries_exhausted', agentId, detail };
      }
      await this.recordError(agentId, { state: 'failed', lastError: detail });
      return { status: 'failed', agentId, reason: 'error', detail };
    }

    // The hint wins over the exponential backoff but never over the cap:
    // maxRetryDelayMs bounds EVERY delay (a hint of hours would otherwise
    // park the attempt loop — and overflow Node's 32-bit setTimeout).
    const delayMs =
      throttle?.retryAfterSeconds !== undefined
        ? Math.min(throttle.retryAfterSeconds * 1_000, this.maxRetryDelayMs)
        : this.backoffDelayMs(attempt);
    this.log(
      `[teams-provisioning] ${agentId} attempt ${attempt}/${this.maxAttempts} failed (${errorMessage(err)}); retrying in ${delayMs}ms`,
    );
    // THE event this whole feature exists for (#915): the minutes an operator
    // stares at an unmoving panel are these delays. Attempt number and wait
    // are carried as structured arguments, never as a sentence — the UI
    // renders "attempt 3 of 5, next in 8s" from them. The error MESSAGE is
    // deliberately not included: it is connector output, so it can carry a
    // request URL or an identifier, and this column is read by a screen.
    await this.emit(agentId, this.currentStep.get(agentId) ?? 'run', 'retrying', {
      attempt,
      detail: retryDetail(delayMs, this.maxAttempts),
    });
    await this.sleep(delayMs);
    return undefined;
  }

  private backoffDelayMs(attempt: number): number {
    return Math.min(this.baseRetryDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
  }

  /**
   * Best-effort persistence of a failure detail — a store outage while
   * recording must not mask the original failure.
   *
   * SETTLES THE RUN BEFORE IT WRITES A TERMINAL STATE (byte5ai/omadia#915).
   * The order is the whole fix. `state = 'failed'` is committed in Postgres
   * the moment this write lands, but the runner's own continuation only
   * resumes a driver round trip later — and a status request served in that
   * gap read the committed `failed` from the database while `isRunning` still
   * answered `true`. Marking first makes the pair unobservable: from the
   * instant the terminal state can be READ, the runner already agrees the run
   * is over. Marking afterwards would leave exactly the window #915 reports.
   */
  private async recordError(
    agentId: string,
    patch: TeamsIdentityJobUpdate,
  ): Promise<void> {
    if (patch.state === 'failed') this.markSettled(agentId);
    try {
      await this.store.update(agentId, patch);
    } catch (err) {
      this.log(
        `[teams-provisioning] persisting last_error for ${agentId} failed: ${errorMessage(err)}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      // `handle` is assigned after setTimeout returns; a synchronous test
      // seam may fire `release` before that, hence the guards.
      // eslint-disable-next-line prefer-const
      let handle: unknown;
      let done = false;
      const release = (): void => {
        if (done) return;
        done = true;
        this.pendingSleeps.delete(release);
        if (handle !== undefined) this.timers.clearTimeout(handle);
        resolve();
      };
      this.pendingSleeps.add(release);
      handle = this.timers.setTimeout(release, ms);
    });
  }

  /**
   * One pass over the chain, re-entering at the stored state. Completed
   * steps are skipped by evidence (persisted columns / state rank); the rest
   * rely on the provisioner's idempotency keys.
   */
  private async advance(
    request: ProvisionTeamsIdentityRequest,
  ): Promise<ProvisioningRunResult> {
    const { agentId } = request;
    let row = await this.store.getByAgentId(agentId);
    if (!row) {
      throw new TeamsProvisioningJobError(
        `no teams identity row for agent '${agentId}' — create it before enqueueing provisioning`,
      );
    }
    // Three conditions, three separate reasons: the chain is complete
    // (#910), this team's install is already recorded (#919), and the
    // package is not stale (#914). Any one of them false means there IS
    // something left to do.
    if (
      row.state === 'installed' &&
      request.republish !== true &&
      (await this.isBound(row, request.teamId))
    ) {
      // #910 — a re-run of an already-installed identity is the self-healing
      // path: an operator may have removed the entry from the plugin config.
      // The chain itself has nothing left to do, but the config write is
      // re-asserted so "re-run provisioning" always ends with the bot
      // actually configured.
      //
      // The whole chain is still logged as skipped. An operator who clicks
      // "run provisioning again" on a healthy identity gets a timeline that
      // says "all five steps: nothing to do", which answers their question;
      // a timeline holding only the config write would look like the run
      // never got started.
      for (const step of SKIPPABLE_CHAIN_STEPS) {
        await this.emit(agentId, step, 'succeeded', { detail: SKIPPED_DETAIL });
      }
      await this.syncTeamsBotsConfig(row);
      return { status: 'installed', agentId };
    }
    // An `installed` identity with an UNRECORDED team is the additional-team
    // case (migration 0051): the Entra app, the bot and the catalog entry are
    // per-AGENT and already exist, only the per-TEAM install is missing. The
    // run falls through — every step below is evidence-guarded and skips
    // itself at this state rank, so the chain lands directly on step 5.
    if (this.stopped) return { status: 'stopped', agentId };

    const provisioner = this.getProvisioner();

    // #914 — republish: the chain is complete, but the PACKAGE is stale
    // because the agent's identity changed. Steps 3+4 below skip themselves
    // once `teams_app_id` is set (by design: they are resume logic, and
    // re-uploading an unchanged package on every re-run would be waste), so
    // the rebuild gets its own branch rather than a condition threaded
    // through theirs. The catalog upload is an update here — same
    // `externalId`, higher manifest version, which is what Teams requires
    // before it accepts one.
    if (request.republish === true && row.state === 'installed') {
      const assets = await this.loadPackageAssets(row);
      const packageZip = provisioner.buildAppPackage({
        manifestTemplate: assets.manifestTemplate,
        params: assets.params,
        icons: assets.icons,
      });
      // Same upload path as the chain's step 4 — a republish that bypassed it
      // would be the one code path still doing an app-only upload, which is
      // precisely the call Microsoft refuses (#924).
      const uploaded = await this.uploadPackage(
        agentId,
        provisioner,
        packageZip,
        assets.externalId,
      );
      if (uploaded.kind === 'sign_in_required') return uploaded.result;
      row = await this.store.update(agentId, {
        teamsAppId: uploaded.teamsAppId,
        teamsAppExternalId: assets.externalId,
        lastError: null,
      });
      // Deliberately NO early return. The chain's own step 5 installs the
      // refreshed app into the requested team, records the binding (#919)
      // and re-asserts the plugin config — a republish that returned here
      // would skip all three, and an install that was never recorded would
      // stay unrecorded. Every step between here and step 5 is
      // evidence-guarded and skips itself at this state rank.
    }

    // Step 1 — Entra app registration (idempotent by Graph uniqueName).
    //
    // The step counts as done only when the STATE says so, not when app_id is
    // merely present: app_id is now persisted the moment Graph confirms the
    // registration (see onRegistrationCreated below), so a row can carry one
    // while the client secret was never stored. Re-running is safe — the
    // connector adopts the existing registration by its uniqueName and
    // rotates the secret (byte5ai/omadia#916).
    if (
      !row.appId ||
      !row.tenantId ||
      STATE_RANK[row.state] < STATE_RANK.app_registered
    ) {
      // The slow one. The connector polls Entra for replication inside this
      // call and can sit there for the best part of a minute; the runner
      // cannot see into it (another repo's contract), so it says so up front
      // instead of leaving the panel silent.
      await this.emit(agentId, 'app_registered', 'started', {
        detail: AWAITING_ENTRA_REPLICATION_DETAIL,
      });
      const result = await provisioner.createAppRegistration({
        displayName: row.displayName,
        tenantMode: this.tenantMode,
        uniqueName: `omadia-teams-bot-${row.botSlug}`,
        secretDisplayName: `omadia-teams-bot-${row.botSlug}`,
        // The app id is the one durable fact of this step. Write it BEFORE
        // the secret and the service principal so an interruption leaves a
        // resumable row rather than an orphaned Entra app the runner cannot
        // find again — the failure mode of byte5ai/omadia#916. The state
        // stays where it is: the step is not finished yet.
        onRegistrationCreated: async (registration) => {
          await this.store.update(agentId, {
            appId: registration.appId,
            tenantId: registration.tenantId,
            // Written in the SAME statement as the app id, deliberately. The
            // two are only ever observable together — after a delete the
            // application is gone from `/applications` and no lookup turns one
            // into the other any more — so a teardown that has one and not the
            // other cannot empty the recycle bin, and the agent's `uniqueName`
            // stays reserved for 30 days (#916). Two writes would have left a
            // window where exactly that is true.
            ...(registration.objectId === undefined
              ? {}
              : { appObjectId: registration.objectId }),
          });
          // The ONE boundary inside this call the connector's contract already
          // exposes, and therefore the only honest intra-step progress the
          // runner can report without changing that contract (it lives in
          // another repo — out of scope here): the registration exists in
          // Graph, its id is persisted, and the replication wait is what
          // happens next. The app id itself is deliberately NOT in `detail` —
          // a tenant identifier has no business in a progress note.
          await this.emit(agentId, 'app_registered', 'progress', {
            detail: REGISTRATION_CREATED_DETAIL,
          });
        },
      });
      row = await this.store.update(agentId, {
        state: 'app_registered',
        appId: result.value.appId,
        tenantId: result.value.registration.tenantId,
        // Also here, not only in the hook above: the hook is skipped entirely
        // when the connector ADOPTS an existing registration, which is the
        // resume path — and a resumed identity needs its object id just as
        // much as a fresh one.
        ...(result.value.registration.objectId === undefined
          ? {}
          : { appObjectId: result.value.registration.objectId }),
        lastError: null,
      });
      await this.emit(agentId, 'app_registered', 'succeeded');
    } else {
      // A resume re-entering above this step. Recorded rather than passed over
      // in silence: a timeline that starts at step 3 reads as two lost steps.
      await this.emit(agentId, 'app_registered', 'succeeded', {
        detail: SKIPPED_DETAIL,
      });
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Step 2 — Azure bot (idempotent by bot handle). The endpoint is built by
    // the accessor module's URL builder, injected — never composed here.
    if (STATE_RANK[row.state] < STATE_RANK.bot_created) {
      await this.emit(agentId, 'bot_created', 'started');
      const outcome = await provisioner.createBot({
        // Qualified, NOT the raw slug: the handle namespace is global (#921).
        botName: buildBotHandle(row.botSlug, row.appId as string),
        displayName: row.displayName,
        msaAppId: row.appId as string,
        msaAppTenantId: row.tenantId as string,
        messagingEndpoint: this.buildMessagingEndpoint(row.botSlug),
      });
      if (outcome.kind === 'registration-only') {
        const detail = armNotConfiguredDetail(outcome.missingSetupFields);
        await this.store.update(agentId, {
          state: 'app_registered',
          lastError: detail,
        });
        return {
          status: 'halted',
          agentId,
          reason: 'arm_not_configured',
          missingSetupFields: outcome.missingSetupFields,
        };
      }
      row = await this.store.update(agentId, { state: 'bot_created', lastError: null });
      await this.emit(agentId, 'bot_created', 'succeeded');
    } else {
      await this.emit(agentId, 'bot_created', 'succeeded', { detail: SKIPPED_DETAIL });
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Steps 3+4 — app package + catalog upload (idempotent by externalId).
    if (STATE_RANK[row.state] < STATE_RANK.catalog_uploaded || !row.teamsAppId) {
      await this.emit(agentId, 'package_built', 'started');
      const assets = await this.loadPackageAssets(row);
      if (STATE_RANK[row.state] < STATE_RANK.package_built) {
        row = await this.store.update(agentId, {
          state: 'package_built',
          teamsAppExternalId: assets.externalId,
          lastError: null,
        });
      }
      await this.emit(agentId, 'package_built', 'succeeded');
      // The catalog leg is its own step for the operator even though the two
      // share a guard: it is the one that talks to Graph, so it is the one
      // that can sit there.
      await this.emit(agentId, 'catalog_uploaded', 'started');
      let teamsAppId = row.teamsAppId;
      if (!teamsAppId) {
        const existing = await provisioner.getCatalogApp({
          teamsAppExternalId: assets.externalId,
        });
        if (existing.found) {
          teamsAppId = existing.teamsAppId;
        } else {
          const packageZip = provisioner.buildAppPackage({
            manifestTemplate: assets.manifestTemplate,
            params: assets.params,
            icons: assets.icons,
          });
          const uploaded = await this.uploadPackage(
            agentId,
            provisioner,
            packageZip,
            assets.externalId,
          );
          // PARKED, not failed: the package is built and every earlier step
          // is real. The row keeps `package_built`, `last_error` says which
          // human action is missing, and the next run resumes right here.
          if (uploaded.kind === 'sign_in_required') return uploaded.result;
          teamsAppId = uploaded.teamsAppId;
        }
      }
      row = await this.store.update(agentId, {
        state: 'catalog_uploaded',
        teamsAppId,
        lastError: null,
      });
      await this.emit(agentId, 'catalog_uploaded', 'succeeded');
    } else {
      await this.emit(agentId, 'package_built', 'succeeded', {
        detail: SKIPPED_DETAIL,
      });
      await this.emit(agentId, 'catalog_uploaded', 'succeeded', {
        detail: SKIPPED_DETAIL,
      });
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Step 5 — install into the target (idempotent on Graph's side).
    //
    // TWO ENDPOINTS, ONE STEP. A team installs through
    // `POST /teams/{id}/installedApps`, a chat through
    // `POST /chats/{id}/installedApps`. They are different Graph resources
    // with different permissions, so the branch is here rather than inside
    // the connector: the runner already knows which kind it was asked for and
    // guessing from the id string is exactly the failure this feature exists
    // to remove.
    const targetKind: TeamsTargetKind = request.targetKind ?? 'team';
    await this.emit(agentId, 'installed', 'started');
    try {
      if (isChatTarget(targetKind)) {
        const installToChat = provisioner.installToChat;
        // Feature detection, never an optional call: an older connector must
        // fail with the actionable sentence below rather than with a
        // TypeError, and `installToChat?.(…)` would silently resolve to
        // `undefined` and let the run mark itself installed without
        // installing anything.
        if (typeof installToChat !== 'function') {
          throw new TeamsChatInstallUnsupportedError();
        }
        await installToChat.call(provisioner, {
          // NOT normalised: a conversation id is not a GUID, and
          // `normalizeTeamsTeamId` passes it through untouched anyway.
          // Calling it here would only suggest a reshaping that must never
          // happen.
          chatId: request.teamId.trim(),
          teamsAppId: row.teamsAppId as string,
        });
      } else {
        await provisioner.installToTeam({
          // Graph rejects the unhyphenated form Teams itself hands out (see
          // platform/teamsTeamId). Normalised here as well as at the route,
          // so a row stored before the route did it still installs instead of
          // dying at the last step of an otherwise complete chain.
          teamId: normalizeTeamsTeamId(request.teamId),
          teamsAppId: row.teamsAppId as string,
        });
      }
    } catch (err) {
      // `400 ResourceSpecificPermissionsMismatch` is NOT a generic bad
      // request, and reporting it as one sends the operator hunting for a
      // wrong id that is in fact correct. It means this agent's app package
      // declares resource-specific permissions the installing identity may not
      // consent to — a tenant-side role grant. TERMINAL: no retry makes a
      // missing grant appear.
      if (isRscPermissionsMismatch(err)) {
        const detail = rscPermissionsMismatchDetail(targetKind);
        await this.recordError(agentId, { state: 'failed', lastError: detail });
        return {
          status: 'failed',
          agentId,
          reason: 'rsc_permissions_mismatch',
          detail,
        };
      }
      throw err;
    }
    // Same ordering rule as recordError (#915): the chain is finished, so the
    // run stops calling itself running BEFORE the terminal state becomes
    // readable. Everything past this line — the binding write, the
    // `teams_bots` config sync — is bookkeeping on an agent that is already
    // installed, and the UI reports its outcome through `teams_bots_sync` and
    // the timeline rather than through `running`.
    this.markSettled(agentId);
    row = await this.store.update(agentId, { state: 'installed', lastError: null });
    // `detail` carries the TARGET KIND — a closed, localizable vocabulary
    // ('team' | 'group-chat' | 'one-on-one-chat'), exactly like the
    // `config_sync` step's status. Never the id: the timeline is a screen, and
    // a chat id names the humans in that chat.
    await this.emit(agentId, 'installed', 'succeeded', { detail: targetKind });

    // Step 5b (migration 0051) — PERSIST the binding. Graph has confirmed the
    // install, so this is the moment the pair becomes a fact rather than an
    // intent. Before this table existed the only trace was the identity row's
    // single `team_id`, which the next request overwrote — the reason a
    // binding never survived a re-target.
    await this.recordInstall(agentId, request.teamId, row.teamsAppId, targetKind);

    // Step 6 (#910) — the finishing move: write the `teams_bots` entry into
    // channel-teams and reload it, so the bot answers without an operator
    // pasting JSON between two screens. Deliberately AFTER the terminal state
    // write and deliberately unable to change it.
    await this.syncTeamsBotsConfig(row);
    return { status: 'installed', agentId };
  }

  // -------------------------------------------------------------------------
  // Catalog upload (#924)
  // -------------------------------------------------------------------------

  /**
   * Upload the rendered package to the tenant catalog — delegated when the
   * connector can, app-only when it cannot.
   *
   * WHY THIS BRANCH EXISTS AT ALL. `POST /appCatalogs/teamsApps` is
   * delegated-only at Microsoft; Application permissions are documented as
   * "Not supported". So the app-only call below is the ONE step of the whole
   * chain that a fully-consented tenant still refuses, and a connector that
   * publishes `uploadToCatalogDelegated` (>= 0.6.0) is the only way to do it
   * properly — on a token set a tenant admin produced by signing in once.
   *
   * NOT SIGNED IN IS NOT A FAILURE. It is the absence of a human action, so
   * this parks rather than throws: it returns a `halted` result the caller
   * turns into "keep the state, record what is missing, resume later".
   * Letting the connector throw and classifying it downstream would work too,
   * but it would burn the retry budget on a condition no retry can fix and
   * make the first run of a fresh install look broken.
   *
   * A ROTATED TOKEN IS PERSISTED IMMEDIATELY, before the upload's result is
   * used for anything else. Had the process died between the connector
   * rotating and us writing, the refresh token still in the vault would
   * already have been spent — and the tenant would be silently signed out
   * until the next run failed and somebody investigated.
   */
  private async uploadPackage(
    agentId: string,
    provisioner: TeamsProvisionerPort,
    packageZip: Uint8Array,
    externalId: string,
  ): Promise<
    | { readonly kind: 'uploaded'; readonly teamsAppId: string }
    | { readonly kind: 'sign_in_required'; readonly result: ProvisioningRunResult }
  > {
    const delegatedUpload = provisioner.uploadToCatalogDelegated;
    const custody = this.delegatedTokens;
    // Feature detection, not configuration: an older connector and a mount
    // without token custody both mean "app-only", which is what this
    // middleware did before #924 and stays correct for those deployments.
    if (typeof delegatedUpload !== 'function' || custody === undefined) {
      const uploaded = await provisioner.uploadToCatalog({ packageZip, externalId });
      return { kind: 'uploaded', teamsAppId: uploaded.value.teamsAppId };
    }

    const tokens = await custody.read();
    if (tokens === undefined) {
      const detail = delegatedSignInRequiredDetail([]);
      // State deliberately untouched — every step already taken is real, and
      // the row's own rank is what makes the next run resume from here.
      await this.recordError(agentId, { lastError: detail });
      return {
        kind: 'sign_in_required',
        result: {
          status: 'halted',
          agentId,
          reason: 'delegated_sign_in_required',
          detail,
        },
      };
    }

    // The one honest thing the runner can say from outside another repo's
    // call: which credential this upload rides on. No token, no account, no
    // flow handle — this column is read by a screen.
    await this.emit(agentId, 'catalog_uploaded', 'progress', {
      detail: DELEGATED_UPLOAD_DETAIL,
    });

    // PROACTIVE REFRESH — before the call, not after it has failed.
    //
    // The reactive path below still exists and still matters, but it can only
    // ever run once the upload has already failed: a package re-sent, and a
    // recovery that depends on the failure being classified exactly as
    // "expired". If Graph answers with anything else, a run dies for a reason
    // no human needs to fix. Asking the token whether it is spent costs
    // nothing and removes that whole class of failure.
    //
    // A FAILURE HERE IS NOT FATAL, deliberately. If the refresh throws we
    // carry on with the stored token: our clock may be the thing that is
    // wrong, and a token we wrongly believed spent may work perfectly. When it
    // does not, the upload fails exactly as it did before this block existed
    // and the reactive path takes over — so the worst case of a proactive
    // refresh is today's behaviour, never worse than it.
    const refreshDelegated = provisioner.refreshDelegatedToken;
    let current = tokens;
    if (
      typeof refreshDelegated === 'function' &&
      isAccessTokenExpiring(
        current.expiresAt,
        this.now(),
        ACCESS_TOKEN_REFRESH_MARGIN_MS,
      )
    ) {
      try {
        current = await refreshDelegated.call(provisioner, { tokens: current });
        // Persisted IMMEDIATELY, for the same reason the reactive path does:
        // a rotation the vault has not seen is a refresh token already spent,
        // and a crash here would sign the tenant out silently.
        await custody.write(current);
        await this.emit(agentId, 'catalog_uploaded', 'progress', {
          detail: DELEGATED_TOKEN_REFRESHED_DETAIL,
        });
      } catch (err) {
        current = tokens;
        this.log(
          `[teams-provisioning] pre-emptive delegated token refresh for agent '${agentId}' failed, continuing with the stored token: ${errorMessage(err)}`,
        );
      }
    }

    const attemptUpload = async (set: DelegatedTokenSet): Promise<string> => {
      const result = await delegatedUpload.call(provisioner, {
        packageZip,
        externalId,
        tokens: set,
      });
      if (result.refreshed) {
        await custody.write(result.tokens);
        await this.emit(agentId, 'catalog_uploaded', 'progress', {
          detail: DELEGATED_TOKEN_REFRESHED_DETAIL,
        });
      }
      return result.app.value.teamsAppId;
    };

    try {
      return { kind: 'uploaded', teamsAppId: await attemptUpload(current) };
    } catch (err) {
      // THE FALLBACK, and it stays a fallback rather than becoming dead code.
      // The check above reads a clock; this reads Microsoft's actual verdict.
      // It is what still catches a host whose clock is behind, and a token the
      // server invalidated early — a revoked session, a password change, a
      // Conditional Access policy — neither of which any expiry arithmetic can
      // see coming.
      //
      // The ONE delegated failure an operator must never be shown: an access
      // token past its expiry with a refresh token that is still good. It is
      // recovered right here — refresh, retry once — because surfacing it
      // would ask a human to fix something no human needs to touch. Anything
      // else, INCLUDING a refresh that itself fails, travels on to
      // {@link handleFailure}, which is where the four errors are told apart.
      if (!isDelegatedTokenExpiredError(err) || !isRecoverableByRefresh(err)) throw err;
      const refresh = provisioner.refreshDelegatedToken;
      if (typeof refresh !== 'function') throw err;
      const rotated = await refresh.call(provisioner, { tokens: current });
      await custody.write(rotated);
      await this.emit(agentId, 'catalog_uploaded', 'progress', {
        detail: DELEGATED_TOKEN_REFRESHED_DETAIL,
      });
      return { kind: 'uploaded', teamsAppId: await attemptUpload(rotated) };
    }
  }

  /**
   * Is this agent ALREADY recorded as installed in this team? Asked only of
   * an `installed` identity, to tell "nothing left to do" apart from "the
   * per-agent chain is done, this team's install is not".
   *
   * Without the installs store (pre-0051 mounts, tests) there is no per-team
   * record to consult, and the runner's own port deliberately does not expose
   * the identity's `team_id` — so the honest fallback is the pre-0051
   * answer: an `installed` identity IS the binding. That keeps old mounts
   * behaving exactly as before rather than re-installing on every run.
   */
  private async isBound(
    row: TeamsIdentityJobRecord,
    teamId: string,
  ): Promise<boolean> {
    const installs = this.installs;
    if (!installs) return true;
    return (await installs.get(row.agentId, teamId)) !== undefined;
  }

  /**
   * Persist the confirmed binding, decorated with the team's display name
   * when the connector can resolve one.
   *
   * Failure policy mirrors {@link syncTeamsBotsConfig}: the install itself
   * already happened in Graph, so neither a bookkeeping write nor a cosmetic
   * name lookup may turn a successful run into a failed one. A write failure
   * is logged; a name failure leaves the binding nameless, which the operator
   * UI renders as the bare id.
   */
  private async recordInstall(
    agentId: string,
    teamId: string,
    teamsAppId: string | null,
    targetKind: TeamsTargetKind,
  ): Promise<void> {
    const installs = this.installs;
    if (!installs) return;
    let displayName: string | null = null;
    // The name resolver is `teamsProvisioner@1.getTeam`, which answers for a
    // TEAM only. A chat has no equivalent lookup in the mirrored contract, so
    // a chat binding stays nameless rather than being handed an id to resolve
    // that the connector would answer `found: false` for — a wasted Graph call
    // whose only outcome is a misleading log line.
    if (this.resolveTeamName && targetKind === 'team') {
      try {
        displayName = await this.resolveTeamName(teamId);
      } catch (err) {
        this.log(
          `[teams-provisioning] team name lookup for '${teamId}' failed: ${errorMessage(err)}`,
        );
      }
    }
    try {
      await installs.record({
        agentId,
        teamId,
        teamsAppId,
        teamDisplayName: displayName,
        targetKind,
      });
    } catch (err) {
      this.log(
        `[teams-provisioning] could not record the install of agent '${agentId}' in team '${teamId}': ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Best-effort `teams_bots` config write (#910).
   *
   * NEVER throws, never changes `state`. By the time this runs the Entra app,
   * the Azure bot, the catalog entry and the team install all exist and are
   * this agent's — failing the run over a config write would report a
   * provisioning failure that did not happen, and re-running it would re-walk
   * a chain that is already complete. So a failure is recorded as an
   * ACTIONABLE warning in `last_error` (`config_sync_failed`, which the
   * operator UI renders as "paste the block by hand, here is why") while the
   * identity stays `installed`.
   */
  private async syncTeamsBotsConfig(row: TeamsIdentityJobRecord): Promise<void> {
    const sync = this.syncBotConfig;
    if (!sync) return;
    await this.emit(row.agentId, 'config_sync', 'started');
    try {
      const report = await sync(row);
      // `report.status` is one of synced | unchanged | skipped — a closed
      // vocabulary the UI can localize. `report.reason` is NOT forwarded: it
      // is free text from the sync path and this column is read by a screen.
      await this.emit(row.agentId, 'config_sync', 'succeeded', {
        detail: report.status,
      });
      this.log(
        `[teams-provisioning] teams_bots config sync for ${row.agentId} (${row.botSlug}): ${report.status}${
          report.reason !== undefined ? ` (${report.reason})` : ''
        }`,
      );
      // Retiring OUR OWN stale warning is part of "re-run provisioning to
      // retry the write": without this, a run that fixed the problem would
      // leave the operator staring at the warning that sent them here.
      // Scoped to the `config_sync_failed` prefix on purpose — an unrelated
      // error on the row is not this method's to clear.
      if (row.lastError?.startsWith(CONFIG_SYNC_FAILED_PREFIX)) {
        await this.recordError(row.agentId, { lastError: null });
      }
    } catch (err) {
      const detail = configSyncFailedDetail(errorMessage(err));
      // A step-level failure on a run whose verdict is `installed` — the
      // timeline shows it as a warning line, because the terminal `run`
      // event that follows says `succeeded`. Only the code travels; the
      // connector's message stays in `last_error`, which the UI already
      // renders through the classifier.
      await this.emit(row.agentId, 'config_sync', 'failed', {
        detail: 'config_sync_failed',
      });
      this.log(
        `[teams-provisioning] teams_bots config sync for ${row.agentId} (${row.botSlug}) failed: ${errorMessage(err)} — identity stays installed; the operator can paste the block manually`,
      );
      await this.recordError(row.agentId, { lastError: detail });
    }
  }
}

// ---------------------------------------------------------------------------
// last_error sentences + their classifier (W2a, epic #860)
//
// The runner is the ONLY writer of `agent_teams_identities.last_error`, and
// every sentence it writes starts with a machine-readable code. The operator
// UI must not re-derive meaning from English prose, so the classifier that
// decodes those sentences lives HERE, next to the producers: changing a
// message and forgetting the decoder breaks the colocated round-trip test
// instead of silently degrading the operator UI in production.
//
// Follow-up (out of scope here): persist the structured code as its own
// column from the start, so the sentence stays purely human-facing.
// ---------------------------------------------------------------------------

/** Bracket filler used when the connector named no ARM field. Shared by the
 *  producer and the classifier so the empty case round-trips to `[]`. */
const ARM_FIELDS_UNSPECIFIED = 'ARM setup fields';

/**
 * Graph answered `400 ResourceSpecificPermissionsMismatch`.
 *
 * NOT a generic bad request, and mis-reading it as one is exactly why this has
 * its own code. The install call is well-formed and the target id is correct;
 * what Graph is saying is that the RESOURCE-SPECIFIC permissions declared in
 * the agent's app package (ours declares seven) exceed what the installing
 * identity may consent to on the target's behalf. The fix is a tenant-side
 * role grant, so the sentence names the role instead of sending the operator
 * back to check an id that was never wrong.
 */
export const RSC_PERMISSIONS_MISMATCH_PREFIX = 'rsc_permissions_mismatch:';

/** The two Graph app roles that let an install carry an app's RSC
 *  permissions — team direction and chat direction. Named in the
 *  operator-facing sentence so the fix is a copy-paste, not a search. */
export const RSC_CONSENT_ROLES = {
  team: 'TeamsAppInstallation.ReadWriteAndConsentForTeam.All',
  chat: 'TeamsAppInstallation.ReadWriteAndConsentForChat.All',
} as const;

export function rscPermissionsMismatchDetail(targetKind: TeamsTargetKind): string {
  const role = targetKind === 'team' ? RSC_CONSENT_ROLES.team : RSC_CONSENT_ROLES.chat;
  return `${RSC_PERMISSIONS_MISMATCH_PREFIX} Graph refused the install because this agent's Teams app package declares resource-specific permissions the installing identity may not consent to — grant the app role ${role} to the M365 connector's Entra app and admin-consent it, then re-run provisioning. The target id is correct; this is a permission grant, not a wrong id.`;
}

/** Does this error carry Graph's ResourceSpecificPermissionsMismatch code?
 *  Duck-typed on the message for the same reason as the connector's other
 *  error guards: the class identity belongs to the plugin, not to us. */
export function isRscPermissionsMismatch(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /ResourceSpecificPermissionsMismatch/i.test(`${err.name} ${err.message}`);
}

export function consentMissingDetail(missingScopes: readonly string[]): string {
  return `consent_missing: admin consent required for scopes [${missingScopes.join(', ')}] — grant them in the customer tenant, then re-run provisioning`;
}

export function armNotConfiguredDetail(missingSetupFields: readonly string[]): string {
  const fields =
    missingSetupFields.length > 0
      ? missingSetupFields.join(', ')
      : ARM_FIELDS_UNSPECIFIED;
  return `arm_not_configured: bot creation needs the ARM setup fields [${fields}] on the M365 connector — configure them, then re-run provisioning (the app registration is kept)`;
}

/** Machine-readable prefix of {@link botHandleUnavailableDetail}. The
 *  connector's own message already starts with this code, so the producer
 *  passes it through rather than double-prefixing. */
export const BOT_HANDLE_UNAVAILABLE_PREFIX = 'bot_handle_unavailable:';

/**
 * The global bot handle is taken (#921).
 *
 * The explanatory text — global namespace, automatic qualification, rename
 * the slug — is authored by the CONNECTOR, which is where the ARM semantics
 * live; the runner only guarantees the sentence carries the code the operator
 * UI switches on. An older connector reports the same condition without the
 * prefix, so it is added when missing.
 */
export function botHandleUnavailableDetail(message: string, botName?: string): string {
  const handle = botName !== undefined ? ` [${botName}]` : '';
  return message.startsWith(BOT_HANDLE_UNAVAILABLE_PREFIX)
    ? message
    : `${BOT_HANDLE_UNAVAILABLE_PREFIX}${handle} ${message} — Azure bot handles share one global namespace across all Azure customers, so a name can be taken by a bot outside your tenant. Rename the agent's bot slug and re-run provisioning`;
}

/** Throttle budget exhausted. The reached state is KEPT — this is a "come
 *  back later", not a failure — so the sentence carries the connector's
 *  `Retry-After` hint when it had one. */
export function throttledDetail(
  message: string,
  attempts: number,
  retryAfterSeconds?: number,
): string {
  const hint =
    retryAfterSeconds !== undefined ? `; retry after ${String(retryAfterSeconds)}s` : '';
  return `throttled: ${message} (gave up after ${String(attempts)} attempts${hint})`;
}

/**
 * The one sentence this runner writes that is a WARNING, not a failure (#910).
 *
 * The identity is provisioned and valid in Azure; only the automatic write of
 * the channel-teams `teams_bots` entry did not land. The reason is carried in
 * brackets like the other structured sentences, with bracket and newline
 * characters stripped so the classifier's `[...]` group round-trips exactly.
 */
/** Machine-readable prefix of {@link configSyncFailedDetail}. Shared by the
 *  producer, the classifier and the runner's stale-warning cleanup. */
export const CONFIG_SYNC_FAILED_PREFIX = 'config_sync_failed:';

export function configSyncFailedDetail(reason: string): string {
  const safe = reason.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  return `config_sync_failed: [${safe.length > 0 ? safe : CONFIG_SYNC_REASON_UNSPECIFIED}] — the Teams identity is provisioned and installed; only the automatic teams_bots entry in the Teams channel plugin was not written. Paste the shown block into that setup field to bring the bot online, or re-run provisioning to retry the write`;
}

/** Bracket filler when the failure carried no usable message. Shared by the
 *  producer and the classifier so the empty case round-trips. */
const CONFIG_SYNC_REASON_UNSPECIFIED = 'no reason reported';

// ---------------------------------------------------------------------------
// The delegated sentences (#924)
//
// Four codes for four errors, because each one sends the operator somewhere
// else: start a sign-in, send an admin to a consent URL, sign in again, or go
// look at the publisher app's device-code / Conditional Access configuration.
// A single `delegated_failed` code would have been shorter and would have made
// the panel useless.
// ---------------------------------------------------------------------------

export const DELEGATED_SIGN_IN_REQUIRED_PREFIX = 'delegated_sign_in_required:';
export const DELEGATED_CONSENT_REQUIRED_PREFIX = 'delegated_consent_required:';
export const DELEGATED_TOKEN_EXPIRED_PREFIX = 'delegated_token_expired:';
export const DEVICE_CODE_FLOW_FAILED_PREFIX = 'device_code_flow_failed:';

/** Token carrying the admin-consent URL. Its own `key=value` rather than a
 *  second bracket group, because a URL and a comma-split list do not mix. */
const CONSENT_URL_TOKEN = 'consent_url=';

/** Bracket filler for "the connector named no scopes", shared by producer and
 *  classifier so the empty case round-trips to `[]`. */
const DELEGATED_SCOPES_UNSPECIFIED = 'the delegated Teams scopes';

/** Nobody is signed in for this tenant — the ordinary state of a fresh
 *  install, and the reason the very first agent cannot reach the catalog. */
export function delegatedSignInRequiredDetail(
  requiredScopes: readonly string[],
  step?: string,
): string {
  const scopes =
    requiredScopes.length > 0
      ? requiredScopes.join(', ')
      : DELEGATED_SCOPES_UNSPECIFIED;
  const where = step !== undefined ? ` (step: ${step.replace(/[[\]]/g, '')})` : '';
  return `${DELEGATED_SIGN_IN_REQUIRED_PREFIX} the Teams app catalog upload is delegated-only at Microsoft, so it needs a tenant admin signed in with [${scopes}]${where} — sign in once under Teams sign-in; every agent provisioned afterwards uses it automatically`;
}

/** Signed in, but the scopes were never consented to. A DIFFERENT person may
 *  be needed here (a global admin), which is why it is not the same code. */
export function delegatedConsentRequiredDetail(
  requiredScopes: readonly string[],
  adminConsentUrl?: string,
): string {
  const scopes =
    requiredScopes.length > 0
      ? requiredScopes.join(', ')
      : DELEGATED_SCOPES_UNSPECIFIED;
  const link =
    adminConsentUrl !== undefined ? ` ${CONSENT_URL_TOKEN}${adminConsentUrl}` : '';
  return `${DELEGATED_CONSENT_REQUIRED_PREFIX} a tenant admin still has to grant consent for [${scopes}] before the delegated catalog upload is allowed — open the consent URL, approve, then re-run provisioning${link}`;
}

/**
 * The sign-in itself is spent. The refreshable variant never reaches an
 * operator (see `uploadPackage`), so a row carrying this sentence means the
 * refresh token is gone — a re-sign-in, not a wait.
 */
export function delegatedTokenExpiredDetail(reason?: string): string {
  const because =
    reason === 'access-token-expired'
      ? 'the access token expired and could not be refreshed'
      : 'the refresh token is no longer valid';
  return `${DELEGATED_TOKEN_EXPIRED_PREFIX} ${because} — the stored tenant sign-in cannot be used any more; sign in again under Teams sign-in, then re-run provisioning`;
}

/**
 * The device-code flow is refused by configuration. Not the operator's tenant
 * data — the publisher app itself, or a Conditional Access policy that will
 * not let a device-code sign-in through.
 */
export function deviceCodeFlowFailedDetail(
  message: string,
  oauthError?: string,
): string {
  const safe = message.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  const code = oauthError !== undefined ? ` [${oauthError.replace(/[[\]]/g, '')}]` : '';
  return `${DEVICE_CODE_FLOW_FAILED_PREFIX}${code} ${safe.length > 0 ? safe : 'the device-code sign-in was refused'} — check that the M365 connector's publisher app allows public-client device-code flows and that no Conditional Access policy blocks them`;
}

export type TeamsProvisioningErrorCode =
  | 'consent_missing'
  /** Graph refused the install because the app package's RSC permissions
   *  exceed what the installing identity may consent to. */
  | 'rsc_permissions_mismatch'
  | 'arm_not_configured'
  | 'throttled'
  | 'config_sync_failed'
  | 'bot_handle_unavailable'
  /** #924 — the four delegated codes, one per producer above. */
  | 'delegated_sign_in_required'
  | 'delegated_consent_required'
  | 'delegated_token_expired'
  | 'device_code_flow_failed'
  | 'unknown';

/** Structured projection of one `last_error` sentence. `raw` is always the
 *  untouched original — a UI may show it as a secondary technical detail,
 *  but it must render its message from `code` + the typed arguments. */
export interface TeamsProvisioningErrorDetail {
  readonly code: TeamsProvisioningErrorCode;
  /** Graph/ARM scopes still awaiting admin consent (`consent_missing`). */
  readonly scopes?: readonly string[];
  /** M365-connector setup fields still unconfigured (`arm_not_configured`). */
  readonly fields?: readonly string[];
  /** Connector `Retry-After` hint in seconds (`throttled`), when it had one. */
  readonly retryAfterSeconds?: number;
  /**
   * Where an admin grants the delegated scopes (`delegated_consent_required`).
   * Absolute https by construction — `adminConsentUrlOf` rejects anything
   * else before the sentence is ever written, so a UI may render it as a link
   * without re-validating.
   */
  readonly adminConsentUrl?: string;
  /** Why the automatic `teams_bots` write did not land (`config_sync_failed`).
   *  A technical sentence, shown as the argument of a localized line — never
   *  as the copy itself. */
  readonly reason?: string;
  readonly raw: string;
}

/** Content of the first `[...]` group, split into trimmed entries. The
 *  sentinel maps back to the empty list the producer started from. */
function bracketList(sentence: string, sentinel?: string): readonly string[] {
  const inner = /\[([^\]]*)\]/.exec(sentence)?.[1];
  if (inner === undefined) return [];
  const entries = inner
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (sentinel !== undefined && entries.length === 1 && entries[0] === sentinel) {
    return [];
  }
  return entries;
}

/**
 * The `consent_url=` token of a `delegated_consent_required` sentence.
 *
 * Re-validated as absolute https on the way OUT as well as on the way in: the
 * sentence is a database column, and a row written by an older build (or edited
 * by hand) must not be able to put a `javascript:` href in front of an
 * operator. Cheap, and the only alternative is trusting stored text.
 */
function consentUrlOf(sentence: string): string | undefined {
  const raw = new RegExp(`${CONSENT_URL_TOKEN}(\\S+)`).exec(sentence)?.[1];
  if (raw === undefined) return undefined;
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode a `last_error` sentence written by this runner into the structured
 * form the operator UI renders from. Pure and total: an unrecognized sentence
 * (an older row, a store-level write such as `enqueue_failed: …`) classifies
 * as `unknown` with the raw text preserved — never throws, never guesses.
 */
export function classifyTeamsProvisioningError(
  raw: string,
): TeamsProvisioningErrorDetail {
  const sentence = raw.trim();
  if (sentence.startsWith('consent_missing:')) {
    return { code: 'consent_missing', scopes: bracketList(sentence), raw };
  }
  if (sentence.startsWith('arm_not_configured:')) {
    return {
      code: 'arm_not_configured',
      fields: bracketList(sentence, ARM_FIELDS_UNSPECIFIED),
      raw,
    };
  }
  if (sentence.startsWith(BOT_HANDLE_UNAVAILABLE_PREFIX)) {
    return { code: 'bot_handle_unavailable', raw };
  }
  if (sentence.startsWith(RSC_PERMISSIONS_MISMATCH_PREFIX)) {
    return { code: 'rsc_permissions_mismatch', raw };
  }
  if (sentence.startsWith(CONFIG_SYNC_FAILED_PREFIX)) {
    const inner = /\[([^\]]*)\]/.exec(sentence)?.[1]?.trim() ?? '';
    return {
      code: 'config_sync_failed',
      reason: inner === CONFIG_SYNC_REASON_UNSPECIFIED ? '' : inner,
      raw,
    };
  }
  // #924 — the four delegated codes. Each keeps whatever the producer
  // captured, so the panel can name the scopes and link the consent URL
  // instead of telling the operator to "check the logs".
  if (sentence.startsWith(DELEGATED_SIGN_IN_REQUIRED_PREFIX)) {
    return {
      code: 'delegated_sign_in_required',
      scopes: bracketList(sentence, DELEGATED_SCOPES_UNSPECIFIED),
      raw,
    };
  }
  if (sentence.startsWith(DELEGATED_CONSENT_REQUIRED_PREFIX)) {
    const url = consentUrlOf(sentence);
    return {
      code: 'delegated_consent_required',
      scopes: bracketList(sentence, DELEGATED_SCOPES_UNSPECIFIED),
      ...(url !== undefined ? { adminConsentUrl: url } : {}),
      raw,
    };
  }
  if (sentence.startsWith(DELEGATED_TOKEN_EXPIRED_PREFIX)) {
    return { code: 'delegated_token_expired', raw };
  }
  if (sentence.startsWith(DEVICE_CODE_FLOW_FAILED_PREFIX)) {
    const inner = /\[([^\]]*)\]/.exec(sentence)?.[1]?.trim() ?? '';
    return {
      code: 'device_code_flow_failed',
      ...(inner !== '' ? { reason: inner } : {}),
      raw,
    };
  }
  if (sentence.startsWith('throttled:')) {
    const hint = /; retry after (\d+)s\)?/.exec(sentence)?.[1];
    return {
      code: 'throttled',
      ...(hint !== undefined ? { retryAfterSeconds: Number(hint) } : {}),
      raw,
    };
  }
  return { code: 'unknown', raw };
}
