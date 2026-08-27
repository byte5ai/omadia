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
 * the persisted columns (app_id/tenant_id/teams_app_id), and re-executed
 * steps are safe because every remote call is idempotent by a stable key
 * (Graph `uniqueName`, ARM bot handle, catalog `externalId`, team install).
 * A row left in 'failed' resumes the same way: evidence columns decide the
 * entry point, so nothing is re-created.
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
      readonly reason: 'consent_missing' | 'error';
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

    const throttle = throttleHintOf(err);
    const retryable = throttle !== undefined || isProvisionerUnavailable(err);

    if (attempt >= this.maxAttempts) {
      const detail = retriesExhaustedDetail(err, attempt, throttle);
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
    if (row.state === 'installed') return { status: 'installed', agentId };
    if (this.stopped) return { status: 'stopped', agentId };

    const provisioner = this.getProvisioner();

    // Step 1 — Entra app registration (idempotent by Graph uniqueName).
    if (!row.appId || !row.tenantId) {
      const result = await provisioner.createAppRegistration({
        displayName: row.displayName,
        tenantMode: this.tenantMode,
        uniqueName: `omadia-teams-bot-${row.botSlug}`,
        secretDisplayName: `omadia-teams-bot-${row.botSlug}`,
      });
      row = await this.store.update(agentId, {
        state: 'app_registered',
        appId: result.value.appId,
        tenantId: result.value.registration.tenantId,
        lastError: null,
      });
    } else if (STATE_RANK[row.state] < STATE_RANK.app_registered) {
      row = await this.store.update(agentId, {
        state: 'app_registered',
        lastError: null,
      });
    }

    if (this.stopped) return { status: 'stopped', agentId };

    // Step 2 — Azure bot (idempotent by bot handle). The endpoint is built by
    // the accessor module's URL builder, injected — never composed here.
    if (STATE_RANK[row.state] < STATE_RANK.bot_created) {
      const outcome = await provisioner.createBot({
        botName: row.botSlug,
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
    await this.store.update(agentId, { state: 'installed', lastError: null });
    return { status: 'installed', agentId };
  }
}

// ---------------------------------------------------------------------------
// last_error — producers and the classifier that reads them back
//
// `last_error` is an English sentence written for a human operator, and the
// operator UI needs a machine-readable version of the SAME failure so it can
// render a localized, actionable hint instead of an untranslated backend
// string. The classifier lives HERE, right next to the producers, on purpose:
// the round-trip test in `test/teamsProvisioningLastError.test.ts` builds a
// sentence with a producer and classifies it back, so editing a message
// without touching the parser breaks a colocated unit test instead of
// silently degrading the operator UI in production.
//
// FOLLOW-UP (deliberately out of scope here): the runner should persist a
// structured code alongside the sentence from the start — that needs a
// migration on `agent_teams_identities` and therefore its own unit. Until
// then this classifier is the single reader of these strings; nothing else
// may parse `last_error`.
// ---------------------------------------------------------------------------

/** Machine-readable failure classes behind a `last_error` sentence. */
export type TeamsProvisioningErrorCode =
  | 'consent_missing'
  | 'arm_not_configured'
  | 'throttled'
  | 'unknown';

/** Structured projection of one `last_error` sentence. */
export interface TeamsProvisioningErrorDetail {
  readonly code: TeamsProvisioningErrorCode;
  /** `consent_missing`: the Graph/ARM scopes an admin still has to grant. */
  readonly scopes?: readonly string[];
  /** `arm_not_configured`: the connector setup fields that are still empty. */
  readonly fields?: readonly string[];
  /** `throttled`: the API's `Retry-After` hint, when it provided one. */
  readonly retryAfterSeconds?: number;
  /** The original sentence — the UI may show it as a technical detail. */
  readonly raw: string;
}

const CONSENT_MISSING_PREFIX = 'consent_missing: ';
const ARM_NOT_CONFIGURED_PREFIX = 'arm_not_configured: ';
const THROTTLED_PREFIX = 'throttled: ';
const RETRY_AFTER_MARKER = 'retry_after_seconds=';

/** TERMINAL: Graph/ARM answered 403 and an admin has to consent. */
function consentMissingDetail(missingScopes: readonly string[]): string {
  return `${CONSENT_MISSING_PREFIX}admin consent required for scopes [${missingScopes.join(', ')}] — grant them in the customer tenant, then re-run provisioning`;
}

/** NOT terminal: the app registration exists, only the ARM leg is unconfigured. */
function armNotConfiguredDetail(missingSetupFields: readonly string[]): string {
  const fields =
    missingSetupFields.length > 0 ? missingSetupFields.join(', ') : 'ARM setup fields';
  return `${ARM_NOT_CONFIGURED_PREFIX}bot creation needs the ARM setup fields [${fields}] on the M365 connector — configure them, then re-run provisioning (the app registration is kept)`;
}

/**
 * The retry budget is spent. A throttle gets the `throttled:` prefix so the
 * operator UI can offer "retry later" instead of "something broke"; every
 * other exhausted error keeps its bare message and classifies as `unknown`.
 */
function retriesExhaustedDetail(
  err: unknown,
  attempt: number,
  throttle: { retryAfterSeconds?: number } | undefined,
): string {
  const base = `${errorMessage(err)} (gave up after ${attempt} attempts)`;
  if (throttle === undefined) return base;
  const hint =
    throttle.retryAfterSeconds !== undefined
      ? `${RETRY_AFTER_MARKER}${throttle.retryAfterSeconds}`
      : 'no Retry-After hint';
  return `${THROTTLED_PREFIX}the Microsoft API rate-limited provisioning (${hint}) — ${base}`;
}

/** `[a, b, c]` → `['a', 'b', 'c']`; anything else → `[]`. */
function parseBracketList(raw: string): readonly string[] {
  const start = raw.indexOf('[');
  const end = raw.indexOf(']', start + 1);
  if (start < 0 || end < 0) return [];
  return raw
    .slice(start + 1, end)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseRetryAfterSeconds(raw: string): number | undefined {
  const at = raw.indexOf(RETRY_AFTER_MARKER);
  if (at < 0) return undefined;
  const digits = /^\d+/.exec(raw.slice(at + RETRY_AFTER_MARKER.length));
  if (!digits) return undefined;
  const seconds = Number(digits[0]);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/**
 * Project a stored `last_error` onto {@link TeamsProvisioningErrorDetail}.
 *
 * Total by construction: an unrecognized sentence (including one written by
 * `recordEnqueueFailure`, which never uses these prefixes) classifies as
 * `unknown` with the raw text preserved — the UI always has something to
 * show, and a new message shape degrades to "technical detail" rather than
 * to a crash.
 */
export function classifyTeamsProvisioningError(
  lastError: string | null | undefined,
): TeamsProvisioningErrorDetail | null {
  if (typeof lastError !== 'string') return null;
  const raw = lastError.trim();
  if (raw.length === 0) return null;

  if (raw.startsWith(CONSENT_MISSING_PREFIX)) {
    return { code: 'consent_missing', scopes: parseBracketList(raw), raw };
  }
  if (raw.startsWith(ARM_NOT_CONFIGURED_PREFIX)) {
    return { code: 'arm_not_configured', fields: parseBracketList(raw), raw };
  }
  if (raw.startsWith(THROTTLED_PREFIX)) {
    const retryAfterSeconds = parseRetryAfterSeconds(raw);
    return {
      code: 'throttled',
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      raw,
    };
  }
  return { code: 'unknown', raw };
}

/** Test-only re-export of the producers, so the round-trip test can not drift
 *  from the sentences the runner actually writes. */
export const teamsProvisioningLastErrorProducers = {
  consentMissingDetail,
  armNotConfiguredDetail,
  retriesExhaustedDetail,
} as const;
