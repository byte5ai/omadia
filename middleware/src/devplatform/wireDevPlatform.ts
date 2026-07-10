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
import { createLlmProxyRouter, type LlmModelPolicy } from './llmProxy.js';
import type { DeriveJobPolicyConfig } from './deriveJobPolicy.js';
import type { Pool } from 'pg';
import type { Express, RequestHandler, Router as ExpressRouter } from 'express';

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_LLM_UPSTREAM_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_LLM_PROVIDER = 'anthropic';
/** Vault namespace the dev-platform provider keys live under (spec §6b). */
const DEV_PLATFORM_VAULT_AGENT = 'core:dev-platform';

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

  // --- W1 keystones: daemon job-policy endpoint + LLM proxy (spec §4/§6b) ----
  /** `DEV_RUNNER_DAEMON_TOKEN` — the daemon's shared bearer for the internal
   *  job-policy endpoint. Absent ⇒ that endpoint 503s (daemon not wired). */
  daemonToken?: string;
  /** Digest-pinned runner image (`DEV_RUNNER_DEFAULT_IMAGE`). Absent ⇒ the
   *  job-policy endpoint 503s (nothing to derive an image from). */
  runnerImage?: string;
  /** Operator egress default (`DEV_EGRESS_BASE_ALLOWLIST`). */
  egressBaseAllowlist?: readonly string[];
  /** Hostname the job container reaches the middleware on. Defaults to the host
   *  of `baseUrl`. */
  middlewareHost?: string;
  /** LLM-proxy config (spec §6b). The proxy router is ALWAYS mounted (its `GET /`
   *  probe must answer 2xx); these tune the model gate + upstream. */
  llm?: {
    /** Vault provider segment. Default `anthropic`. */
    provider?: string;
    /** Upstream origin. Default `https://api.anthropic.com`. */
    upstreamBaseUrl?: string;
    /** Exact model ids a job may call. Empty/absent ⇒ the proxy 500s "no policy". */
    allowedModels?: readonly string[];
    /** `ANTHROPIC_BASE_URL` handed to api_key jobs. Defaults to `<baseUrl>/api/v1/dev-runner/llm`. */
    proxyBaseUrl?: string;
    /** Test seams. */
    fetchImpl?: typeof fetch;
    resolvePolicy?: (agentKind: string) => Promise<LlmModelPolicy | null>;
    resolveProviderKey?: (provider: string) => Promise<string | undefined>;
    onAccountingError?: (err: unknown, ctx: { jobId: string; tokensIn: number; tokensOut: number }) => void;
  };

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

  // --- W1 keystones: job-policy config + the always-mounted LLM proxy --------
  const middlewareHost = deps.middlewareHost ?? hostOf(deps.baseUrl);
  const llmProxyBaseUrl =
    deps.llm?.proxyBaseUrl ?? `${deps.baseUrl.replace(/\/+$/, '')}/api/v1/dev-runner/llm`;
  // Present ONLY when a runner image is configured; otherwise the internal
  // job-policy endpoint 503s (there is no image to derive), matching its contract.
  const jobPolicyConfig: DeriveJobPolicyConfig | undefined = deps.runnerImage
    ? {
        middlewareHost,
        baseAllowlist: deps.egressBaseAllowlist ?? [],
        image: deps.runnerImage,
        llmProxyBaseUrl,
      }
    : undefined;

  const llmProvider = deps.llm?.provider ?? DEFAULT_LLM_PROVIDER;
  const llmUpstreamBaseUrl = deps.llm?.upstreamBaseUrl ?? DEFAULT_LLM_UPSTREAM_BASE_URL;
  const llmAllowedModels = deps.llm?.allowedModels ?? [];
  const resolvePolicy =
    deps.llm?.resolvePolicy ??
    (async (): Promise<LlmModelPolicy | null> =>
      llmAllowedModels.length === 0
        ? null // unconfigured ⇒ proxy answers 500 "no LLM policy"
        : { provider: llmProvider, upstreamBaseUrl: llmUpstreamBaseUrl, allowedModels: llmAllowedModels });
  const resolveProviderKey =
    deps.llm?.resolveProviderKey ??
    ((provider: string) => deps.vault.get(DEV_PLATFORM_VAULT_AGENT, `llm/${provider}/api_key`));

  const llmProxyRouter: ExpressRouter = createLlmProxyRouter({
    resolveJobByToken: (token) => jobStore.resolveJobByToken(token),
    resolvePolicy,
    resolveProviderKey,
    addJobUsage: (jobId, tokensIn, tokensOut) => jobStore.addJobUsage(jobId, tokensIn, tokensOut),
    ...(deps.llm?.fetchImpl ? { fetchImpl: deps.llm.fetchImpl } : {}),
    ...(deps.llm?.onAccountingError ? { onAccountingError: deps.llm.onAccountingError } : {}),
    log,
  });

  const runnerRouter = createDevRunnerRouter({
    store: jobStore,
    repos: repoStore,
    scmTokens: credentials,
    finalizeDevJob: boundFinalize,
    wallClockMs: deps.wallClockMs,
    ...(deps.daemonToken ? { daemonToken: deps.daemonToken } : {}),
    ...(jobPolicyConfig ? { jobPolicyConfig } : {}),
    llmProxyRouter,
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

/** Hostname of a base URL, used as the implicit egress-allowlist middleware host.
 *  Falls back to the raw string if it does not parse (an operator-supplied host). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}
