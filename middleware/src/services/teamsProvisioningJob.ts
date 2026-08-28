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
import type { TimerSeam } from '../plugins/jobScheduler.js';
import type {
  BackgroundJob,
  BackgroundJobHandle,
} from '../platform/backgroundJobRegistry.js';

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
  readonly tenantId: string | null;
  readonly teamsAppId: string | null;
  readonly teamsAppExternalId: string | null;
  readonly lastError: string | null;
}

export interface TeamsIdentityJobUpdate {
  readonly state?: TeamsProvisioningState;
  readonly appId?: string;
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
  readonly registration: { readonly tenantId: string };
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
      registration: { readonly appId: string; readonly tenantId: string },
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

  getCatalogApp(input: {
    readonly teamsAppExternalId: string;
  }): Promise<{ readonly found: false } | { readonly found: true; readonly teamsAppId: string }>;

  installToTeam(input: {
    readonly teamId: string;
    readonly teamsAppId: string;
  }): Promise<Idempotent<{ readonly teamId: string; readonly teamsAppId: string }>>;
}

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
  /** Team (group) id the generated app is installed into. */
  readonly teamId: string;
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
      readonly status: 'failed';
      readonly agentId: string;
      readonly reason: 'consent_missing' | 'bot_handle_unavailable' | 'error';
      readonly detail: string;
    }
  | {
      readonly status: 'retries_exhausted';
      readonly agentId: string;
      readonly detail: string;
    }
  | {
      /** A run for the SAME agent but a DIFFERENT team is in flight — this
       *  request was refused outright (nothing enqueued, nothing joined), so
       *  a caller can never be handed the other team's success. */
      readonly status: 'rejected';
      readonly agentId: string;
      readonly reason: 'team_conflict';
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
  private readonly log: (msg: string) => void;

  private readonly inFlight = new Map<
    string,
    { readonly teamId: string; readonly run: Promise<ProvisioningRunResult> }
  >();
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
      });
    this.inFlight.set(request.agentId, { teamId: request.teamId, run });
    return run;
  }

  isRunning(agentId: string): boolean {
    return this.inFlight.has(agentId);
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
   */
  runningTeamId(agentId: string): string | null {
    return this.inFlight.get(agentId)?.teamId ?? null;
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

  private async runWithRetries(
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
    await this.sleep(delayMs);
    return undefined;
  }

  private backoffDelayMs(attempt: number): number {
    return Math.min(this.baseRetryDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
  }

  /** Best-effort persistence of a failure detail — a store outage while
   *  recording must not mask the original failure. */
  private async recordError(
    agentId: string,
    patch: TeamsIdentityJobUpdate,
  ): Promise<void> {
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
    if (row.state === 'installed' && request.republish !== true) {
      // #910 — a re-run of an already-installed identity is the self-healing
      // path: an operator may have removed the entry from the plugin config.
      // The chain itself has nothing left to do, but the config write is
      // re-asserted so "re-run provisioning" always ends with the bot
      // actually configured.
      await this.syncTeamsBotsConfig(row);
      return { status: 'installed', agentId };
    }
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
    if (row.state === 'installed') {
      const assets = await this.loadPackageAssets(row);
      const packageZip = provisioner.buildAppPackage({
        manifestTemplate: assets.manifestTemplate,
        params: assets.params,
        icons: assets.icons,
      });
      const uploaded = await provisioner.uploadToCatalog({
        packageZip,
        externalId: assets.externalId,
      });
      row = await this.store.update(agentId, {
        teamsAppId: uploaded.value.teamsAppId,
        teamsAppExternalId: assets.externalId,
        lastError: null,
      });
      // The install is idempotent and cheap, and it is what makes an already
      // installed team pick the updated app up. The state stays `installed`:
      // nothing about this run moves the identity backwards.
      await provisioner.installToTeam({
        teamId: request.teamId,
        teamsAppId: row.teamsAppId as string,
      });
      await this.syncTeamsBotsConfig(row);
      return { status: 'installed', agentId };
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
          });
        },
      });
      row = await this.store.update(agentId, {
        state: 'app_registered',
        appId: result.value.appId,
        tenantId: result.value.registration.tenantId,
        lastError: null,
      });
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Step 2 — Azure bot (idempotent by bot handle). The endpoint is built by
    // the accessor module's URL builder, injected — never composed here.
    if (STATE_RANK[row.state] < STATE_RANK.bot_created) {
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
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Steps 3+4 — app package + catalog upload (idempotent by externalId).
    if (STATE_RANK[row.state] < STATE_RANK.catalog_uploaded || !row.teamsAppId) {
      const assets = await this.loadPackageAssets(row);
      if (STATE_RANK[row.state] < STATE_RANK.package_built) {
        row = await this.store.update(agentId, {
          state: 'package_built',
          teamsAppExternalId: assets.externalId,
          lastError: null,
        });
      }
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
          const uploaded = await provisioner.uploadToCatalog({
            packageZip,
            externalId: assets.externalId,
          });
          teamsAppId = uploaded.value.teamsAppId;
        }
      }
      row = await this.store.update(agentId, {
        state: 'catalog_uploaded',
        teamsAppId,
        lastError: null,
      });
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Step 5 — install into the team (idempotent on Graph's side).
    await provisioner.installToTeam({
      teamId: request.teamId,
      teamsAppId: row.teamsAppId as string,
    });
    row = await this.store.update(agentId, { state: 'installed', lastError: null });

    // Step 6 (#910) — the finishing move: write the `teams_bots` entry into
    // channel-teams and reload it, so the bot answers without an operator
    // pasting JSON between two screens. Deliberately AFTER the terminal state
    // write and deliberately unable to change it.
    await this.syncTeamsBotsConfig(row);
    return { status: 'installed', agentId };
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
    try {
      const report = await sync(row);
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

export type TeamsProvisioningErrorCode =
  | 'consent_missing'
  | 'arm_not_configured'
  | 'throttled'
  | 'config_sync_failed'
  | 'bot_handle_unavailable'
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
  if (sentence.startsWith(CONFIG_SYNC_FAILED_PREFIX)) {
    const inner = /\[([^\]]*)\]/.exec(sentence)?.[1]?.trim() ?? '';
    return {
      code: 'config_sync_failed',
      reason: inner === CONFIG_SYNC_REASON_UNSPECIFIED ? '' : inner,
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
