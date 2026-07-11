/**
 * Epic #470 W0 — shared surface for the dev-platform admin router (spec §9).
 *
 * Holds the injected dependency interfaces, the error type + JSON helpers, the
 * session/param readers, the browser-safe view mappers, and the admission
 * guards. Split out of `devPlatform.ts` so both the job-route file and the
 * repo-route file stay under the 500-line limit and share one definition of
 * every seam. No Express routes live here.
 */

import type { Request, Response } from 'express';

import { checkBranchProtection as realCheckBranchProtection } from '../devplatform/branchProtectionCheck.js';
import type { BranchProtectionResult } from '../devplatform/branchProtectionCheck.js';
import type { DevJobEventBus } from '../devplatform/devJobEventBus.js';
import type { DevRepoConnection } from '../devplatform/devRepoCredentials.js';
import type { ListJobsFilter } from '../devplatform/devJobStore.js';
import type { FinalizeContext } from '../devplatform/finalizeDevJob.js';
import type { ApplyJobOutcome } from '../devplatform/devJobWorker.js';
import type { GitHubDeviceFlowProvider } from '../issues/githubOAuthProvider.js';
import type { DeviceFlowStore } from '../issues/deviceFlowStore.js';
import type { Ticket } from '../devplatform/githubIssuesTracker.js';
import {
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobArtifact,
  type DevJobAuthMode,
  type DevJobEvent,
  type DevJobKind,
  type DevJobSource,
  type DevJobStatus,
  type DevRepo,
  type DevRepoCredentialKind,
  type NewDevJob,
  type NewDevRepo,
  type RunnerBackendKind,
} from '../devplatform/types.js';

// ---------------------------------------------------------------------------
// Injected store / service seams.
// ---------------------------------------------------------------------------

/** The `DevRepoStore` surface the routes use. */
export interface DevPlatformRepoStore {
  createRepo(input: NewDevRepo): Promise<DevRepo>;
  listRepos(): Promise<DevRepo[]>;
  getRepo(id: string): Promise<DevRepo | null>;
  updateRepo(id: string, patch: Partial<NewDevRepo>): Promise<DevRepo | null>;
  deleteRepo(id: string): Promise<boolean>;
  setBranchProtection(id: string, ok: boolean | null): Promise<DevRepo | null>;
}

/** The `DevJobStore` surface the routes use (reads + createJob; never terminal). */
export interface DevPlatformJobStore {
  createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob>;
  getJob(id: string): Promise<DevJob | null>;
  listJobs(filter?: ListJobsFilter): Promise<DevJob[]>;
  listEvents(jobId: string, afterId?: number, limit?: number): Promise<DevJobEvent[]>;
  listArtifacts(jobId: string): Promise<DevJobArtifact[]>;
  getArtifact(id: string): Promise<DevJobArtifact | null>;
}

/** The `DevRepoCredentialStore` surface. Never returns a token to the browser —
 *  only `resolve` (server-side) hands the raw secret out. */
export interface DevPlatformCredentialStore {
  getConnection(repoId: string): Promise<DevRepoConnection>;
  resolve(repoId: string): Promise<string | undefined>;
  save(repoId: string, input: { token: string; kind: 'device_flow' | 'pat'; login?: string }): Promise<void>;
  clear(repoId: string): Promise<void>;
  stashPending(sub: string, token: string): Promise<void>;
  resolvePending(sub: string): Promise<string | undefined>;
  clearPending(sub: string): Promise<void>;
  promotePending(sub: string, repoId: string, login?: string): Promise<boolean>;
}

/** Result of the injected repo-access probe (`GET /repos/{owner}/{repo}`). */
export interface RepoAccessResult {
  ok: boolean;
  defaultBranch: string;
  login?: string;
}

/** Read-only tracker bound to one repo + token. A repo's bound tracker plugin
 *  (Jira etc.) or the built-in GitHub Issues tracker both satisfy this shape;
 *  the W3 `TrackerRegistry` resolves the right one per repo. */
export interface DevPlatformTracker {
  getTicket(issueNumber: number): Promise<Ticket>;
  /** `label` narrows to tickets carrying it (W4 tracker poller, §4). */
  listOpenTickets(opts: { limit: number; label?: string }): Promise<Ticket[]>;
}

/** Device-flow onboarding seam. Absent ⇒ the feature reports itself
 *  unconfigured (503) instead of failing mid-flow. */
export interface DevPlatformDeviceFlow {
  provider: Pick<GitHubDeviceFlowProvider, 'requestDeviceCode' | 'pollAccessToken' | 'fetchUserLogin'>;
  store: DeviceFlowStore;
  /** OAuth scopes for the dev platform. Default `['repo']` (spec §6). */
  scopes?: readonly string[];
}

export interface DevPlatformRouterDeps {
  repoStore: DevPlatformRepoStore;
  jobStore: DevPlatformJobStore;
  credentials: DevPlatformCredentialStore;
  eventBus: DevJobEventBus;
  /** Validate operator access to a repo and capture its default branch (spec §6). */
  probeRepoAccess: (input: { owner: string; name: string; token: string }) => Promise<RepoAccessResult>;
  /** Build a tracker for one repo (the index unit resolves the token). */
  makeIssuesTracker: (opts: { owner: string; name: string; token: string }) => DevPlatformTracker;
  /** Bound `finalizeDevJob` — the ONLY terminal-transition path (spec §4). */
  finalizeDevJob: (jobId: string, status: DevJobStatus, ctx?: FinalizeContext) => Promise<DevJob | null>;
  /** Host-side apply retry (`POST /jobs/:id/apply`). `gated` ⇒ the diff policy
   *  parked the job for a human (spec §6) instead of opening a PR. */
  applyJob: (jobId: string) => Promise<ApplyJobOutcome>;
  /** Q4 admission flag (`DEV_PLATFORM_SUBSCRIPTION_MODE`). */
  subscriptionModeEnabled: boolean;
  deviceFlow?: DevPlatformDeviceFlow;
  /** Branch-protection probe. Default: the real `checkBranchProtection`. */
  checkBranchProtection?: (input: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
  }) => Promise<BranchProtectionResult>;
  /** Build the https clone URL. Default `https://github.com/<owner>/<name>.git`. */
  cloneUrlFor?: (owner: string, name: string) => string;
  /** SSE heartbeat interval. Default 25 000 ms; tests pass 0 to disable. */
  heartbeatMs?: number;
  setTimer?: (fn: () => void, ms: number) => { unref(): void } | NodeJS.Timeout;
  clearTimer?: (timer: ReturnType<NonNullable<DevPlatformRouterDeps['setTimer']>>) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Caller identity read from the verified session. */
export interface DevPlatformCaller {
  sub: string;
  email: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Errors + JSON helpers.
// ---------------------------------------------------------------------------

/** A domain error carrying its HTTP status and a `devplatform.` code. Its public
 *  message never carries a secret, an upstream body, or a stack. */
export class DevPlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DevPlatformError';
  }
}

/** `{ code, message }` — codes prefixed `devplatform.`. */
export function sendError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof DevPlatformError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  res.status(500).json({ code: 'devplatform.internal', message: 'internal error' });
}

/** Wrap an async handler so a thrown `DevPlatformError` becomes its status and
 *  anything else becomes an opaque 500. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => sendError(res, err));
  };
}

// ---------------------------------------------------------------------------
// Session, params, launch authorization.
// ---------------------------------------------------------------------------

/** Read the verified caller, or throw 401 (defence-in-depth under requireAuth). */
export function requireCaller(req: Request): DevPlatformCaller {
  const s = req.session;
  const sub = typeof s?.sub === 'string' ? s.sub : '';
  if (!sub) throw new DevPlatformError(401, 'devplatform.unauthorized', 'no session');
  return {
    sub,
    email: typeof s?.email === 'string' ? s.email : '',
    role: typeof s?.role === 'string' ? s.role : '',
  };
}

/** `req.params[k]` is `string | string[]` under this express typing; a repeated
 *  param arrives as an array — treat anything but a single non-empty string as
 *  missing rather than coercing it. */
export function readParam(req: Request, key: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : '';
}

/**
 * A caller may launch a job against a repo when they created it or hold one of
 * its `allowed_launchers` role keys (spec §6). Empty launchers ⇒ creator only,
 * exactly as the migration comments it.
 */
export function isPermittedLauncher(repo: DevRepo, caller: DevPlatformCaller): boolean {
  // The creator always may. Otherwise the caller must hold a ROLE named in the
  // allowlist. Spec §6 defines allowed_launchers as role keys, so this matches
  // only caller.role — not sub or email. Folding those in would let an operator
  // whose opaque sub or IdP-controlled email happened to equal an allowlist
  // entry launch unintended, a cross-namespace match. Empty role never matches.
  if (repo.createdBy === caller.sub) return true;
  if (caller.role.length === 0) return false;
  return repo.allowedLaunchers.includes(caller.role);
}

// ---------------------------------------------------------------------------
// Browser-safe views.
// ---------------------------------------------------------------------------

/** Repo view (spec §9). Carries a credential STATUS, never the token, and never
 *  the internal Vault `credentialRef`. */
export interface DevRepoView {
  id: string;
  forgeKind: string;
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  trackerKind: string | null;
  trackerConfig: Record<string, unknown>;
  allowedTriggers: string[];
  allowedLaunchers: string[];
  egressAllowlist: string[];
  runsTests: boolean;
  branchProtectionOk: boolean | null;
  branchProtectionCheckedAt: string | null;
  /** W4 per-repo cost budget (`0027`); null ⇒ fall back to the config default. */
  budgetCostUsd: number | null;
  /** W4 webhook trigger config (`0027`). The label whose application fires a job. */
  triggerLabel: string;
  /** W4 per-repo webhook kill switch (`0027`). */
  webhookEnabled: boolean;
  /** W4 sender allowlist (`0027`); EMPTY ⇒ webhook triggers are OFF for the repo. */
  webhookSenders: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  credential: { kind: DevRepoCredentialKind; login: string | null; isSet: boolean };
}

export function toRepoView(repo: DevRepo, conn: DevRepoConnection): DevRepoView {
  return {
    id: repo.id,
    forgeKind: repo.forgeKind,
    owner: repo.owner,
    name: repo.name,
    cloneUrl: repo.cloneUrl,
    defaultBranch: repo.defaultBranch,
    trackerKind: repo.trackerKind,
    trackerConfig: repo.trackerConfig,
    allowedTriggers: repo.allowedTriggers,
    allowedLaunchers: repo.allowedLaunchers,
    egressAllowlist: repo.egressAllowlist,
    runsTests: repo.runsTests,
    branchProtectionOk: repo.branchProtectionOk,
    branchProtectionCheckedAt: repo.branchProtectionCheckedAt,
    budgetCostUsd: repo.budgetCostUsd ?? null,
    triggerLabel: repo.triggerLabel,
    webhookEnabled: repo.webhookEnabled,
    webhookSenders: repo.webhookSenders,
    createdBy: repo.createdBy,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    credential: {
      kind: conn.kind ?? repo.credentialKind,
      login: conn.login ?? null,
      isSet: conn.connected,
    },
  };
}

/** Job view (spec §9). Omits the runner-token hash and the lease fields; usage
 *  counts are exposed under `input`/`output` (no `token`-named key). */
export interface DevJobView {
  id: string;
  repoId: string;
  kind: DevJobKind;
  brief: string;
  source: DevJobSource;
  sourceRef: string | null;
  baseSha: string | null;
  backend: RunnerBackendKind;
  agentKind: string;
  authMode: DevJobAuthMode;
  provision: number;
  phase: string;
  status: DevJobStatus;
  branch: string | null;
  prUrl: string | null;
  result: { outcome: string; summary?: string; diffArtifactId?: string; error?: string } | null;
  error: string | null;
  usage: {
    input: number;
    output: number;
    costUsd: number;
    /** W4 effective per-job cost budget override, or null when it falls back to
     *  the repo budget / config default (spec §5). */
    budgetCostUsd: number | null;
    estimated: boolean;
  };
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export function toJobView(job: DevJob): DevJobView {
  const r = job.result;
  return {
    id: job.id,
    repoId: job.repoId,
    kind: job.kind,
    brief: job.brief,
    source: job.source,
    sourceRef: job.sourceRef,
    baseSha: job.baseSha,
    backend: job.backend,
    agentKind: job.agentKind,
    authMode: job.authMode,
    provision: job.provision,
    phase: job.phase,
    status: job.status,
    branch: job.branch,
    prUrl: job.prUrl,
    result: r
      ? {
          outcome: r.outcome,
          ...(r.summary !== undefined ? { summary: r.summary } : {}),
          ...(r.diffArtifactId !== undefined ? { diffArtifactId: r.diffArtifactId } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
        }
      : null,
    error: job.error,
    usage: {
      input: job.tokensIn,
      output: job.tokensOut,
      costUsd: job.costUsd,
      budgetCostUsd: job.budgetCostUsd,
      // W4: exact when metered from provider usage at the proxy; estimated only
      // for subscription-CLI jobs (the shim sets `usage_estimated`). The result
      // fallback preserves the pre-W4 self-declared flag.
      estimated: job.usageEstimated || (r?.usage?.estimated ?? false),
    },
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    updatedAt: job.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Admission guards (spec §6b + §5). Exported so they can be unit-tested with a
// non-admin `source` directly — the route always creates `source:'admin'`, so
// the non-admin refusals are only reachable through these functions.
// ---------------------------------------------------------------------------

/** The jailed local backend executes no repo code, so it is admitted only for a
 *  no-exec repo and only from the admin path (spec §1/§5). */
export function assertLocalBackendAdmissible(
  job: { backend: RunnerBackendKind; source: DevJobSource },
  repo: { runsTests: boolean },
): void {
  if (job.backend !== 'local') return;
  if (repo.runsTests) {
    throw new DevPlatformError(
      422,
      'devplatform.local_backend_requires_no_exec',
      'the local backend cannot run a repo whose tests execute; use the container backend',
    );
  }
  if (job.source !== 'admin') {
    throw new DevPlatformError(
      422,
      'devplatform.local_backend_admin_only',
      'the local backend accepts admin-initiated jobs only',
    );
  }
}

/** Subscription jobs carry the operator credential inside the runner, so they
 *  are admitted only where no repo code executes beside it (spec §6b / Q4). This
 *  is the route half; the worker enforces the same check at the boundary. */
export function assertAuthModeAdmissible(
  job: { authMode: DevJobAuthMode; source: DevJobSource; backend: RunnerBackendKind },
  repo: { runsTests: boolean },
  cfg: { subscriptionModeEnabled: boolean },
): void {
  if (job.authMode !== 'subscription') return;
  if (!cfg.subscriptionModeEnabled) {
    throw new DevPlatformError(422, 'devplatform.subscription_disabled', 'subscription auth mode is disabled');
  }
  if (repo.runsTests) {
    throw new DevPlatformError(
      422,
      'devplatform.subscription_requires_no_exec',
      'subscription auth mode requires a repo whose tests do not execute',
    );
  }
  if (job.source !== 'admin') {
    throw new DevPlatformError(422, 'devplatform.subscription_operator_only', 'subscription auth mode is admin-only');
  }
  if (job.backend === 'fly') {
    throw new DevPlatformError(
      422,
      'devplatform.subscription_backend_unsupported',
      'subscription auth mode is not supported on the fly backend',
    );
  }
}

// ---------------------------------------------------------------------------
// Misc shared helpers.
// ---------------------------------------------------------------------------

/** The jailed local backend runs neither install nor tests (spec §1/§5). */
export function deriveCapabilities(
  backend: RunnerBackendKind,
  runsTests: boolean,
): { installDeps: boolean; runTests: boolean } {
  if (backend === 'local') return { installDeps: false, runTests: false };
  return { installDeps: true, runTests: runsTests };
}

/** A terminal `status` event ends the SSE stream (spec §9). */
export function isTerminalStatusEvent(ev: DevJobEvent): boolean {
  if (ev.type !== 'status') return false;
  const s = (ev.payload as { status?: unknown }).status;
  return typeof s === 'string' && isTerminalDevJobStatus(s);
}

/** The branch-protection default, shared by the repo routes. */
export const defaultCheckBranchProtection = realCheckBranchProtection;

// ---------------------------------------------------------------------------
// Job load + authorization helpers.
// ---------------------------------------------------------------------------

export async function loadJob(deps: DevPlatformRouterDeps, req: Request): Promise<DevJob> {
  const id = readParam(req, 'id');
  if (!id) throw new DevPlatformError(400, 'devplatform.invalid_id', 'missing :id');
  const job = await deps.jobStore.getJob(id);
  if (!job) throw new DevPlatformError(404, 'devplatform.job_not_found', 'no such job');
  return job;
}

/** Authorize a caller against the repo owning a given job id (for /artifacts/:id). */
export async function callerMayReadRepo(
  deps: DevPlatformRouterDeps,
  jobId: string,
  caller: DevPlatformCaller,
): Promise<boolean> {
  const job = await deps.jobStore.getJob(jobId);
  if (!job) return false;
  const repo = await deps.repoStore.getRepo(job.repoId);
  return Boolean(repo && isPermittedLauncher(repo, caller));
}

/**
 * Load a job AND authorize the caller against its repository. The launcher gate
 * that protects who may START a job must equally protect who may read, stream,
 * cancel, or apply one — events carry another operator's agent output and egress
 * targets. A missing and an unauthorized job return the SAME 404 (no id oracle).
 */
export async function loadAuthorizedJob(
  deps: DevPlatformRouterDeps,
  req: Request,
  caller: DevPlatformCaller,
): Promise<DevJob> {
  const job = await loadJob(deps, req);
  const repo = await deps.repoStore.getRepo(job.repoId);
  if (!repo || !isPermittedLauncher(repo, caller)) {
    throw new DevPlatformError(404, 'devplatform.job_not_found', 'no such job');
  }
  return job;
}

