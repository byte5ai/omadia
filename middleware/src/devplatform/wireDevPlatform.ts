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
import { finalizeDevJob, CredentialRevokerRegistry, type FinalizeContext } from './finalizeDevJob.js';
import { DevGithubAppStore } from './githubApp/appStore.js';
import { JobTokenRegistry, mintScopedInstallationToken, revokeInstallationToken } from './githubApp/installationTokens.js';
import { GithubForgeClient, type ForgeFetch } from './githubForgeClient.js';
import { GithubIssuesTracker } from './githubIssuesTracker.js';
import { DevJobGateStore, type DevJobGate, type GateAnswer } from './pipeline/gateStore.js';
import { PhaseEngine } from './pipeline/phaseEngine.js';
import { createDevPlatformGatesRouter } from '../routes/devPlatformGates.js';
import { LocalProcessBackend } from './localProcessBackend.js';
import { DockerBackend } from './dockerBackend.js';
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
   *  job-policy endpoint AND the DockerBackend's control-plane calls. Absent ⇒
   *  that endpoint 503s and the DockerBackend is not registered. */
  daemonToken?: string;
  /** `DEV_RUNNER_DAEMON_URL` — the daemon control-plane origin the DockerBackend
   *  calls (spec §4/§5). Absent ⇒ no DockerBackend (nothing to talk to). */
  daemonUrl?: string;
  /** `DEV_PLATFORM_BACKEND` (spec §5). `docker` registers the container backend
   *  when a daemon URL + token are present; `local` skips it. Default `docker`. */
  backend?: 'docker' | 'local';
  /** `DEV_JOB_LEASE_TTL_SEC` — lease TTL a docker job requests + renews at
   *  ~TTL/3 (spec §7/§8). Default 180 in the backend. */
  leaseTtlSec?: number;
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

  // --- W2 gate keystones (spec §5) ------------------------------------------
  /** Live gate-holder resolution — the conductor roleStore's `resolve(roleKey)`.
   *  Absent ⇒ role-principal gates resolve to an empty holder set (nobody can
   *  approve, a fail-closed default); index.ts threads the real roleStore. */
  resolveRoleHolders?: (roleKey: string) => Promise<string[]>;
  /** Gate-deadline worker interval (ms). Default 60s. Injectable so a test can
   *  drive expiry fast — or bypass the timer entirely via
   *  `wired.gateDeadlineWorker.tick()`. */
  gateDeadlineIntervalMs?: number;

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
  /** Fetch seam for the scoped GitHub-App token mint/revoke (tests inject a fake).
   *  Defaults to the global fetch. */
  githubAppFetch?: import('./githubApp/installationTokens.js').TokenFetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface WiredDevPlatform {
  eventBus: DevJobEventBus;
  jobStore: DevJobStore;
  repoStore: DevRepoStore;
  credentials: DevRepoCredentialStore;
  worker: DevJobWorker;
  /**
   * Bring the platform online: re-adopt containers that outlived this process,
   * THEN start the claim loop. Callers must use this instead of
   * `worker.start()` — a worker that starts before rehydration sees a daemon
   * full of jobs it believes it does not own, and `reap()` would leave every
   * one of them running until its lease expires.
   */
  start: () => Promise<void>;
  adminRouter: ReturnType<typeof createDevPlatformRouter>;
  runnerRouter: ReturnType<typeof createDevRunnerRouter>;
  /**
   * W2 human-gate admin router (`GET /gates`, `POST /gates/:id/resolve`).
   * `mountDevPlatform` attaches it behind `requireAuth` at the same admin prefix
   * as `adminRouter`; index.ts needs no extra mount call.
   */
  gatesRouter: ReturnType<typeof createDevPlatformGatesRouter>;
  /**
   * W2 gate-deadline worker. `start()` begins the interval loop (also driven by
   * `wired.start()`); `stop()` clears it (also driven by `wired.stop()`);
   * `tick()` runs one scan-and-expire pass and returns the number of gates it
   * expired — the deterministic seam a test drives instead of waiting on the timer.
   */
  gateDeadlineWorker: { tick: () => Promise<number>; start: () => void; stop: () => void };
  backends: readonly RunnerBackend[];
  finalizeDevJob: (jobId: string, status: DevJobStatus, ctx?: FinalizeContext) => Promise<DevJob | null>;
  applyJob: (jobId: string) => Promise<{ prUrl: string }>;
  /** Stop every background loop this platform owns (claim worker + gate-deadline
   *  worker). The counterpart to `start()`; index.ts calls it on shutdown. */
  stop: () => void;
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
  const githubAppStore = new DevGithubAppStore(deps.pool, deps.vault);

  // W2 (Forge #: credential hardening): the per-job token registry. Every scoped
  // App token minted for a runner is recorded here; `finalizeDevJob` revokes them
  // (registered on the revoker registry below), and the phase engine's gate-park
  // revokes them too — one registry, both paths. Audit events go to the job's
  // event log (metadata only, never a token value).
  const tokenRegistry = new JobTokenRegistry(
    (jobId, event) => jobStore.appendHostEvent(jobId, 'token', { ...event }).then(() => undefined),
    undefined,
    deps.githubAppFetch
      ? (token, base) => revokeInstallationToken(token, base, deps.githubAppFetch)
      : undefined,
  );

  /**
   * The clone credential the runner receives. For a `github_app` repo it is a
   * freshly-minted, scoped `contents:read`, single-repo, REVOCABLE installation
   * token registered against the job — never a write credential, so hostile repo
   * code has nothing worth stealing and the token dies with the job. For a
   * device-flow/PAT repo it falls back to the stored token (W0's weaker,
   * documented scoping — those credentials are operator-provided and unchanged).
   */
  const scopedScmTokens = {
    resolve: async ({ jobId, repoId }: { jobId: string; repoId: string }): Promise<string | undefined> => {
      const repo = await repoStore.getRepo(repoId);
      if (!repo) return undefined;
      if (repo.credentialKind !== 'github_app') return credentials.resolve(repoId);

      // credential_ref = 'github_app:<appRowId>:<installationId>' (set at bind).
      const parts = repo.credentialRef.split(':');
      if (parts[0] !== 'github_app' || !parts[1] || !parts[2]) {
        throw new Error(`devplatform.bad_github_app_ref: ${repo.credentialRef}`);
      }
      const [, appRowId, installationId] = parts;
      const app = await githubAppStore.getApp(appRowId);
      if (!app) throw new Error(`devplatform.github_app_missing: ${appRowId}`);
      const secrets = await githubAppStore.getSecrets(app.appId);
      if (!secrets) throw new Error(`devplatform.github_app_secrets_missing: ${app.appId}`);

      const scoped = await mintScopedInstallationToken(
        {
          appId: app.appId,
          privateKey: secrets.privateKey,
          installationId,
          repositories: [repo.name],
          permissions: { contents: 'read' }, // read ONLY — the apply is server-side
          apiBaseUrl: app.apiBaseUrl,
        },
        deps.now ? () => deps.now!().getTime() : undefined,
        deps.githubAppFetch,
      );
      await tokenRegistry.record(jobId, scoped, {
        installationId,
        scope: 'contents:read',
        apiBaseUrl: app.apiBaseUrl,
      });
      return scoped.token;
    },
  };

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
    // Pin the base tree BEFORE the runner clones. `base_sha` is written once
    // (COALESCE), so a re-provision of the same job keeps the tree the agent
    // first saw. A forge that cannot answer must not silently produce an
    // unpinned job: the failure surfaces as a provision failure.
    prepareProvision: async (job, lease, repo) => {
      // An already-pinned job keeps its tree. `base_sha` is COALESCE'd in SQL, so
      // asking the forge again could only produce a sha that is thrown away — and
      // a forge blip on a re-provision (after an at-capacity requeue, say) would
      // then fail a job whose base was settled on the first attempt.
      if (job.baseSha) return jobStore.prepareProvision(job, lease, job.baseSha);
      const token = await credentials.resolve(repo.id);
      if (!token) throw new Error(`devplatform.repo_not_connected: ${repo.owner}/${repo.name}`);
      const baseSha = await forgeFactory(token).getRef(repo.owner, repo.name, repo.defaultBranch);
      return jobStore.prepareProvision(job, lease, baseSha);
    },
    baseUrl: deps.baseUrl,
    maxConcurrent: deps.maxConcurrentJobs,
    wallClockMs: deps.wallClockMs,
    heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
    subscriptionModeEnabled: deps.subscriptionModeEnabled,
    log,
  });

  // The single terminal choke point, bound with the worker's terminate dispatch.
  // W2: the token registry's revoker is registered here, so EVERY terminal path
  // (worker stall/wall-clock, cancel, W1 reaper, phase-engine fail/done) revokes
  // the job's scoped App tokens — Forge's "finalize has no revokers" gap.
  const revokers = new CredentialRevokerRegistry();
  revokers.register(tokenRegistry.revoker);
  const boundFinalize = (jobId: string, status: DevJobStatus, ctx?: FinalizeContext) =>
    finalizeDevJob(
      {
        store: jobStore,
        terminate: (handle) => {
          const backend = backends.find((b) => b.kind === handle.backend);
          return backend ? backend.terminate(handle) : undefined;
        },
        revokers,
        onError: (err, phase) =>
          log(`[dev-platform] finalize(${jobId}→${status}) ${phase} failed: ${errText(err)}`),
      },
      jobId,
      status,
      ctx,
    );

  const applyJob = (jobId: string) => worker.applyJob(jobId);

  // --- W2 pipeline orchestration (spec §4/§5) -------------------------------
  // The durable gate table + the stateful phase engine. The engine ties the pure
  // transition table, the review loop, the gate store, and token revocation to
  // persistence; the runner's POST /jobs/:id/phase-result routes into it.
  const gateStore = new DevJobGateStore(deps.pool, deps.now ? () => deps.now!().getTime() : undefined);

  const phaseEngine = new PhaseEngine({
    // DevJobStore already satisfies PhaseEngineStore (addArtifact / getLatestArtifact
    // / advancePhase / parkForGate / setReviewState).
    store: jobStore,
    gates: gateStore,
    // PhaseEngine's terminal choke point is the SAME boundFinalize every other
    // path uses — so a phase-driven fail/done revokes the job's scoped tokens too.
    // Adapt the signature: the engine passes a bare `reason`, boundFinalize takes
    // a FinalizeContext (`reason` lands in the status event payload).
    finalize: (jobId, status, reason) =>
      boundFinalize(jobId, status, reason !== undefined ? { reason } : undefined).then(() => undefined),
    // A parked runner is exiting: revoke its scoped token WITHOUT finalizing the
    // still-`waiting` job. Same registry revoker the terminal paths use.
    revokeTokensForPark: async (job) => {
      await tokenRegistry.revoker(job);
    },
    // The gate principal + deadline come from the repo row. gatePrincipal /
    // gateDeadlineIso are declared awaitable precisely so the wiring can read the
    // repo here (the engine only calls them on the rare clarify→park). Two reads
    // per park is acceptable — park is infrequent and correctness beats a cache
    // that could serve a stale approver after an operator edits the repo.
    gatePrincipal: async (job) => {
      const repo = await repoStore.getRepo(job.repoId);
      return repo?.approverRoleKey
        ? { kind: 'role', ref: repo.approverRoleKey }
        : { kind: 'user', ref: job.createdBy };
    },
    gateDeadlineIso: async (job) => (await repoStore.getRepo(job.repoId))?.gateDeadlineIso,
    log,
  });

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
    scmTokens: scopedScmTokens,
    finalizeDevJob: boundFinalize,
    wallClockMs: deps.wallClockMs,
    ...(deps.daemonToken ? { daemonToken: deps.daemonToken } : {}),
    ...(jobPolicyConfig ? { jobPolicyConfig } : {}),
    llmProxyRouter,
    // W2: the phase-result endpoint is mounted now that the engine exists.
    handlePhaseResult: (job, input) => phaseEngine.handlePhaseResult(job, input),
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  });

  // --- W2 human-gate admin router (spec §5) --------------------------------
  const resolveRoleHolders = deps.resolveRoleHolders ?? (async () => []);
  const gatesRouter = createDevPlatformGatesRouter({
    gates: gateStore,
    resolveRoleHolders,
    // Approval: append the operator's answers to the brief (once), persist an
    // `answers` artifact, then re-queue the job at `implement`. requeueAtPhase is
    // fenced on `await_human`, and appendToBrief is marker-idempotent, so the
    // gate router's crash self-heal can re-drive this safely.
    onApproved: async (gate, answers, resolvedBy) => {
      const wrote = await jobStore.appendToBrief(
        gate.jobId,
        briefMarker(gate),
        answersBriefSection(gate, answers, resolvedBy),
      );
      if (wrote) {
        await jobStore.addArtifact(gate.jobId, 'answers', JSON.stringify(answers), {
          gateId: gate.id,
          resolvedBy,
        });
      }
      await jobStore.requeueAtPhase(gate.jobId, 'implement');
    },
    // Rejection: record the note on the brief the same way, then cancel the job
    // through the choke point (reason `gate_rejected`). Both writes are idempotent
    // (marker guard + finalize no-op on terminal), so a re-drive is safe.
    onRejected: async (gate, note, resolvedBy) => {
      await jobStore.appendToBrief(gate.jobId, briefMarker(gate), rejectionBriefSection(gate, note, resolvedBy));
      await boundFinalize(gate.jobId, 'cancelled', { reason: 'gate_rejected' });
    },
    // A job is still parked iff it is `waiting` at `await_human` — the signal the
    // gate router uses to distinguish a crash-stranded job (self-heal) from a
    // normal concurrent resolve (409).
    isJobStuckAtGate: async (jobId) => {
      const j = await jobStore.getJob(jobId);
      return j?.status === 'waiting' && j?.phase === 'await_human';
    },
    log,
  });

  // --- W2 gate-deadline worker (spec §5) -----------------------------------
  // Expire overdue gates: claim each due gate with a CAS (`expire`), and only the
  // winner cancels the job (reason `gate_expired`) through the choke point. A
  // periodic interval that need only fire while the process is alive — safe to
  // unref (unlike a one-shot deadline that must fire while idle; see the W1 lesson).
  const gateDeadlineIntervalMs = deps.gateDeadlineIntervalMs ?? 60_000;
  let gateTimer: ReturnType<typeof setInterval> | undefined;
  const gateDeadlineTick = async (): Promise<number> => {
    let expired = 0;
    for (const due of await gateStore.listDue()) {
      const won = await gateStore.expire(due.id);
      if (!won) continue; // another worker claimed it first
      expired += 1;
      await boundFinalize(due.jobId, 'cancelled', { reason: 'gate_expired' });
    }
    return expired;
  };
  const gateDeadlineWorker = {
    tick: gateDeadlineTick,
    start: (): void => {
      if (gateTimer) return;
      gateTimer = setInterval(() => {
        void gateDeadlineTick().catch((err) =>
          log(`[dev-platform] gate deadline worker tick failed: ${errText(err)}`),
        );
      }, gateDeadlineIntervalMs);
      gateTimer.unref?.();
    },
    stop: (): void => {
      if (gateTimer) {
        clearInterval(gateTimer);
        gateTimer = undefined;
      }
    },
  };

  const wired: WiredDevPlatform = {
    eventBus,
    jobStore,
    repoStore,
    credentials,
    worker,
    start: async () => {
      await rehydrateDockerBackend(wired, log);
      worker.start();
      gateDeadlineWorker.start();
    },
    stop: () => {
      gateDeadlineWorker.stop();
      worker.stop();
    },
    adminRouter,
    runnerRouter,
    gatesRouter,
    gateDeadlineWorker,
    backends,
    finalizeDevJob: boundFinalize,
    applyJob,
  };
  return wired;
}

/** The idempotency marker for a gate's brief section — present in every section
 *  we append for that gate (approval or rejection), so `appendToBrief` skips a
 *  self-heal re-drive. A gate resolves OR rejects exactly once, so one marker per
 *  gate is sufficient. */
function briefMarker(gate: DevJobGate): string {
  return `(gate ${gate.id}`;
}

/** The `## Operator answers` brief section (spec §5). Questions are matched to
 *  answers by id; an answer with no matching question still lists its text. */
function answersBriefSection(gate: DevJobGate, answers: readonly GateAnswer[], resolvedBy: string): string {
  const at = gate.resolvedAt ?? new Date().toISOString();
  const lines = answers.map((a, i) => {
    const q = gate.questions.find((qq) => qq.id === a.questionId);
    return `Q${String(i + 1)}: ${q?.text ?? a.questionId}\nA${String(i + 1)}: ${a.text}`;
  });
  return `\n\n## Operator answers (gate ${gate.id}, resolved by ${resolvedBy} at ${at})\n${lines.join('\n')}\n`;
}

/** The `## Operator rejection` brief section — the note stored the same way on
 *  the cancelled job (spec §5). */
function rejectionBriefSection(gate: DevJobGate, note: string | undefined, resolvedBy: string): string {
  const at = gate.resolvedAt ?? new Date().toISOString();
  return `\n\n## Operator rejection (gate ${gate.id}, resolved by ${resolvedBy} at ${at})\nNote: ${note ?? '(none)'}\n`;
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

  // W2 human-gate surface — same admin prefix, same session guard. Express runs
  // both routers for the prefix; their paths do not collide (`/gates*` vs the
  // admin router's repo/job paths).
  app.use('/api/v1/admin/dev-platform', requireAuth, wired.gatesRouter);
  log('[dev-platform] gates router mounted at /api/v1/admin/dev-platform (requireAuth)');
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function buildBackends(deps: WireDevPlatformDeps, log: (msg: string) => void): readonly RunnerBackend[] {
  const backends: RunnerBackend[] = [];

  // W1 shipping path: the DockerBackend, selected by DEV_PLATFORM_BACKEND=docker
  // (the default) and registered ONLY when a daemon URL + token are configured —
  // without both there is nothing to talk to, so it stays unregistered rather
  // than throwing at boot (secure default: off until the operator sets the token).
  if ((deps.backend ?? 'docker') === 'docker' && deps.daemonUrl && deps.daemonToken) {
    backends.push(
      new DockerBackend({
        daemonUrl: deps.daemonUrl,
        daemonToken: deps.daemonToken,
        ...(deps.leaseTtlSec !== undefined ? { leaseTtlSec: deps.leaseTtlSec } : {}),
        log,
      }),
    );
    log('[dev-platform] DockerBackend registered (kind=docker) — the container execution path');
  }

  // W0 skeleton: the LocalProcessBackend, and ONLY when the operator has
  // acknowledged the jail (DEV_PLATFORM_UNSAFE_LOCAL). W1 demotes it to an escape
  // hatch so it never becomes the permanent crutch the epic names as a risk. The
  // backend constructor enforces the uid; config's boot refusal guarantees it.
  if (deps.unsafeLocal) {
    backends.push(
      new LocalProcessBackend({
        unsafeLocalAck: true,
        localUid: deps.localUid ?? 0,
        workspaceDir: deps.workspaceDir,
        shimEntry: deps.shimEntry,
        cliBin: deps.cliBin,
        log,
      }),
    );
  }

  return backends;
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

/**
 * Re-adopt the docker jobs this middleware was running before it restarted.
 *
 * `DockerBackend.reap()` answers "which jobs does the middleware still believe are
 * running that the daemon has lost?" — a question that needs BOTH views. The
 * daemon's view survives a restart (it rebuilds from docker labels); the
 * middleware's lives in memory and does not. Without this, a restarted middleware
 * reaps nothing and a job whose container died stays `running` in the database
 * for as long as the process lives.
 *
 * A handle that does not narrow to this backend's shape is skipped loudly rather
 * than adopted: it belongs to another backend, or the row is damaged.
 */
export async function rehydrateDockerBackend(
  wired: WiredDevPlatform,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const docker = wired.backends.find((b): b is DockerBackend => b instanceof DockerBackend);
  if (!docker) return 0;

  const active: DevJob[] = [];
  for (const status of ['provisioning', 'running', 'applying'] as const) {
    active.push(...(await wired.jobStore.listJobs({ status })));
  }
  const rows = active
    .filter((j) => j.backend === 'docker')
    .map((j) => ({ id: j.id, runnerHandle: j.runnerHandle ?? null }));

  const { adopted, skipped } = await docker.rehydrate(rows);
  if (skipped > 0) log(`[dev-platform] docker rehydrate: ${String(skipped)} handle(s) skipped`);
  return adopted;
}
