/**
 * Epic #470 W0 — the dev-platform wiring hub (spec §3/§10). `assembleDevPlatform`
 * constructs the whole subsystem from the shared Postgres pool + vault and a
 * handful of config values; `mountDevPlatform` attaches its two routers to an
 * Express app with the ONE authentication invariant the epic hinges on:
 *
 *   - the admin router (`/api/v1/admin/dev-platform`) sits behind `requireAuth`.
 *   - the runner router (`/api/v1/dev-runner`) does NOT. Its only authentication
 *     is the per-job bearer token verified inside the router. A blanket session
 *     guard here would be a full auth bypass (the runner has no session), so the
 *     runner mount is deliberately guard-free. The e2e test asserts exactly this.
 *
 * index.ts calls both behind `DEV_PLATFORM_ENABLED`; the e2e test calls them
 * against a real DB with injected fakes (a fake backend that drives phone-home,
 * a stub forge), so the auth-bypass assertion is about the code index runs.
 */

import { parseGitIdentity } from './diffApplyService.js';
import { DiffApplyService, type ApplyInput, type ApplyResult } from './diffApplyService.js';
import { DevJobEventBus } from './devJobEventBus.js';
import { DevJobStore } from './devJobStore.js';
import { DevJobWorker, type DevJobApplyService } from './devJobWorker.js';
import { DevRepoCredentialStore } from './devRepoCredentials.js';
import { DevRepoStore } from './devRepoStore.js';
import { finalizeDevJob, type FinalizeContext } from './finalizeDevJob.js';
import { GithubForgeClient, type ForgeFetch } from './githubForgeClient.js';
import { GithubIssuesTracker } from './githubIssuesTracker.js';
import { LocalProcessBackend } from './localProcessBackend.js';
import type { ForgeClient } from './forgeClient.js';
import type { DevJob, DevJobStatus, RunnerBackend } from './types.js';
import type { SecretVault } from '../secrets/vault.js';
import { createDevPlatformRouter } from '../routes/devPlatform.js';
import type {
  DevPlatformDeviceFlow,
  DevPlatformTracker,
  RepoAccessResult,
} from '../routes/devPlatformShared.js';
import { createDevRunnerRouter } from '../routes/devRunnerApi.js';
import type { Pool } from 'pg';
import type { Express, RequestHandler } from 'express';

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

export interface WireDevPlatformDeps {
  pool: Pool;
  vault: SecretVault;
  /** Where the runner phones home (`DEV_PLATFORM_RUNNER_BASE_URL`). */
  baseUrl: string;
  cliBin: string;
  wallClockMs: number;
  heartbeatTimeoutMs: number;
  maxConcurrentJobs: number;
  /** `DEV_PLATFORM_COMMIT_AUTHOR` — `Name <email>`. */
  commitAuthor: string;
  subscriptionModeEnabled: boolean;
  workspaceDir: string;
  unsafeLocal: boolean;
  localUid?: number | undefined;
  /** Absolute path to the built shim entry (`dev-runner-shim/dist/src/index.js`). */
  shimEntry: string;

  // --- optional / test seams ------------------------------------------------
  /** Override the backend list (tests inject a fake shim-driving backend). When
   *  omitted, the local backend is built iff `unsafeLocal` + `localUid`. */
  backends?: readonly RunnerBackend[];
  /** Build a forge for a resolved repo token. Default: real `GithubForgeClient`. */
  forgeFactory?: (token: string) => ForgeClient;
  /** Full apply-service override (tests inject one bound to a stub forge). */
  applyService?: DevJobApplyService;
  /** Device-flow onboarding (optional; PAT onboarding works without it). */
  deviceFlow?: DevPlatformDeviceFlow;
  githubApiBaseUrl?: string;
  forgeFetch?: ForgeFetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface WiredDevPlatform {
  eventBus: DevJobEventBus;
  jobStore: DevJobStore;
  repoStore: DevRepoStore;
  credentials: DevRepoCredentialStore;
  worker: DevJobWorker;
  adminRouter: ReturnType<typeof createDevPlatformRouter>;
  runnerRouter: ReturnType<typeof createDevRunnerRouter>;
  backends: readonly RunnerBackend[];
  finalizeDevJob: (jobId: string, status: DevJobStatus, ctx?: FinalizeContext) => Promise<DevJob | null>;
  applyJob: (jobId: string) => Promise<{ prUrl: string }>;
}

/** Build every dev-platform object from the shared pool + vault. Pure assembly —
 *  no side effects, no listening; the caller mounts + starts the worker. */
export function assembleDevPlatform(deps: WireDevPlatformDeps): WiredDevPlatform {
  const log = deps.log ?? (() => {});
  const apiBaseUrl = deps.githubApiBaseUrl ?? DEFAULT_GITHUB_API_BASE;

  const eventBus = new DevJobEventBus();
  const jobStore = new DevJobStore(deps.pool, { eventBus });
  const repoStore = new DevRepoStore(deps.pool);
  const credentials = new DevRepoCredentialStore(deps.vault);

  const forgeFactory =
    deps.forgeFactory ?? ((token: string) => new GithubForgeClient({ token, apiBaseUrl, fetch: deps.forgeFetch }));

  // Per-apply forge: W0 commits with the repo's OWN credential, resolved and used
  // host-side only (spec §8). The worker hands us owner/name, so we look the repo
  // row up to reach its Vault-stored token — no write token ever touches a runner.
  const applyService: DevJobApplyService =
    deps.applyService ??
    {
      apply: async (input: ApplyInput): Promise<ApplyResult> => {
        const repo = (await repoStore.listRepos()).find(
          (r) => r.owner === input.repo.owner && r.name === input.repo.name,
        );
        if (!repo) throw new Error(`devplatform.repo_not_found: ${input.repo.owner}/${input.repo.name}`);
        const token = await credentials.resolve(repo.id);
        if (!token) throw new Error(`devplatform.repo_not_connected: ${repo.owner}/${repo.name}`);
        const service = new DiffApplyService({
          forge: forgeFactory(token),
          author: parseGitIdentity(deps.commitAuthor),
        });
        return service.apply(input);
      },
    };

  const backends = deps.backends ?? buildBackends(deps, log);

  const worker = new DevJobWorker({
    store: jobStore,
    repoStore,
    backends,
    applyService,
    prepareProvision: (job, lease) => jobStore.prepareProvision(job, lease),
    baseUrl: deps.baseUrl,
    maxConcurrent: deps.maxConcurrentJobs,
    wallClockMs: deps.wallClockMs,
    heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
    subscriptionModeEnabled: deps.subscriptionModeEnabled,
    log,
  });

  // The single terminal choke point, bound with the worker's terminate dispatch.
  const boundFinalize = (jobId: string, status: DevJobStatus, ctx?: FinalizeContext) =>
    finalizeDevJob(
      {
        store: jobStore,
        terminate: (handle) => {
          const backend = backends.find((b) => b.kind === handle.backend);
          return backend ? backend.terminate(handle) : undefined;
        },
        onError: (err, phase) =>
          log(`[dev-platform] finalize(${jobId}→${status}) ${phase} failed: ${errText(err)}`),
      },
      jobId,
      status,
      ctx,
    );

  const applyJob = (jobId: string) => worker.applyJob(jobId);

  const adminRouter = createDevPlatformRouter({
    repoStore,
    jobStore,
    credentials,
    eventBus,
    probeRepoAccess: makeProbeRepoAccess(apiBaseUrl, deps.forgeFetch),
    makeIssuesTracker: makeIssuesTrackerFactory(apiBaseUrl),
    finalizeDevJob: boundFinalize,
    applyJob,
    subscriptionModeEnabled: deps.subscriptionModeEnabled,
    ...(deps.deviceFlow ? { deviceFlow: deps.deviceFlow } : {}),
    log,
  });

  const runnerRouter = createDevRunnerRouter({
    store: jobStore,
    repos: repoStore,
    scmTokens: credentials,
    finalizeDevJob: boundFinalize,
    wallClockMs: deps.wallClockMs,
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  });

  return {
    eventBus,
    jobStore,
    repoStore,
    credentials,
    worker,
    adminRouter,
    runnerRouter,
    backends,
    finalizeDevJob: boundFinalize,
    applyJob,
  };
}

/**
 * Mount the two routers. The runner router is mounted WITHOUT any auth
 * middleware — its only authentication is the per-job bearer token (a session
 * guard here would lock out the runner, which has no session, and is a full auth
 * bypass in the other direction if it were mistaken for the gate). The admin
 * router is mounted behind `requireAuth`.
 */
export function mountDevPlatform(
  app: Pick<Express, 'use'>,
  requireAuth: RequestHandler,
  wired: WiredDevPlatform,
  log: (msg: string) => void = () => {},
): void {
  // Job-token-gated phone-home surface — NO requireAuth. See the header + e2e test.
  app.use('/api/v1/dev-runner', wired.runnerRouter);
  log('[dev-platform] runner router mounted at /api/v1/dev-runner (job-token auth only, no session guard)');

  // Auth-gated operator admin surface.
  app.use('/api/v1/admin/dev-platform', requireAuth, wired.adminRouter);
  log('[dev-platform] admin router mounted at /api/v1/admin/dev-platform (requireAuth)');
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function buildBackends(deps: WireDevPlatformDeps, log: (msg: string) => void): readonly RunnerBackend[] {
  // W0 ships only the LocalProcessBackend, and only when the operator has
  // acknowledged the jail. Without it there is no backend and a claimed job
  // fails `no_backend` (until W1's DockerBackend). The backend constructor
  // enforces the uid; config's boot refusal already guarantees the uid is set.
  if (!deps.unsafeLocal) return [];
  return [
    new LocalProcessBackend({
      unsafeLocalAck: true,
      localUid: deps.localUid ?? 0,
      workspaceDir: deps.workspaceDir,
      shimEntry: deps.shimEntry,
      cliBin: deps.cliBin,
      log,
    }),
  ];
}

/** Adapt the repo-bound `GithubIssuesTracker` to the route's `DevPlatformTracker`
 *  (which carries the repo, so `getTicket(n)` binds it here). */
function makeIssuesTrackerFactory(
  apiBaseUrl: string,
): (opts: { owner: string; name: string; token: string }) => DevPlatformTracker {
  return ({ owner, name, token }) => {
    const tracker = new GithubIssuesTracker({ token, apiBaseUrl });
    return {
      getTicket: (issueNumber) => tracker.getTicket({ owner, name }, issueNumber),
      listOpenTickets: (opts) => tracker.listOpenTickets({ owner, name }, opts),
    };
  };
}

/** `GET /repos/{owner}/{repo}` to validate operator access + capture the default
 *  branch (spec §6). Hand-rolled fetch, house style; never echoes the response
 *  body or the token on failure. */
function makeProbeRepoAccess(
  apiBaseUrl: string,
  forgeFetch: ForgeFetch | undefined,
): (input: { owner: string; name: string; token: string }) => Promise<RepoAccessResult> {
  const doFetch: ForgeFetch =
    forgeFetch ??
    (async (url, init) => {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });
  return async ({ owner, name, token }) => {
    const res = await doFetch(`${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'omadia-dev-platform',
      },
    });
    if (!res.ok) return { ok: false, defaultBranch: 'main' };
    const data = (await res.json()) as { default_branch?: unknown; owner?: { login?: unknown } };
    const login = typeof data.owner?.login === 'string' ? data.owner.login : undefined;
    return {
      ok: true,
      defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : 'main',
      ...(login ? { login } : {}),
    };
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
