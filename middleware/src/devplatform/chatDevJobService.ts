/**
 * Epic #470 W3 §3 — concrete {@link ChatDevJobService} for the built-in
 * orchestrator tools (`devJobOrchestratorTool.ts`).
 *
 * Binds the chat-agent dev-job surface to the real stores + the chat session's
 * operator identity. Boot constructs one per session with:
 *   - `caller` — the session identity (`{ sub, email, role }`, from the same
 *     session reader the admin routes use).
 *   - `allowedRepoIds` — the repos the operator enabled for THIS agent
 *     (agent-config dev-jobs grant; the per-agent availability envelope).
 *   - `isPermittedLauncher` — injected so this module does not import the routes
 *     layer (avoids a `routes → devplatform` import cycle). Boot passes the
 *     canonical `devPlatformShared.isPermittedLauncher`.
 *   - `resolveJobPlacement` — the SAME placement seam boot feeds
 *     `createDevJobsHostService`, so W0/W2 launcher-admissibility stays a single
 *     source of truth.
 *
 * Authorization model (documented for the report): a chat session is driven by
 * a HUMAN operator, so the correct gate is the **W0 launch-authorization**
 * (`isPermittedLauncher`: repo creator OR holder of an `allowed_launchers`
 * role) keyed on the session identity — NOT the `ctx.devJobs` per-plugin grant
 * model, which keys on a plugin id a chat turn does not have. That launch check
 * is further narrowed by the agent-config `allowedRepoIds` envelope. Fail-closed
 * throughout: empty grant ⇒ nothing resolves; every read intersects
 * `allowedRepoIds ∩ isPermittedLauncher` before returning anything.
 *
 * Reuse: the READ paths (getJob / listJobs / listJobEvents) delegate to the
 * ctx.devJobs host service (`createDevJobsHostService`) — same descriptor
 * mapping + in-memory repo scoping. Only `startJob` is bespoke: the host
 * service hardcodes `source:'plugin'` + a plugin `createdBy`, so a chat job
 * (`source:'chat'`, `createdBy = caller.sub`) is created against the store
 * directly, mirroring the admin `POST /jobs` launch path.
 */

import type { DevJobDescriptor, DevJobStatus } from '@omadia/plugin-api';

import type { DevJobsHostService } from '../platform/pluginContext.js';

import { createDevJobsHostService } from './devJobsHostService.js';
import type {
  ChatDevJobService,
  DevJobStatusResult,
} from './devJobOrchestratorTool.js';
import { mintRunnerToken as defaultMintRunnerToken } from './jobToken.js';
import type {
  DevJob,
  DevJobAuthMode,
  DevJobEvent,
  DevRepo,
  NewDevJob,
  RunnerBackendKind,
} from './types.js';

/** The chat session's operator identity (mirrors `DevPlatformCaller`). */
export interface ChatDevJobCaller {
  readonly sub: string;
  readonly email: string;
  readonly role: string;
}

/** Narrow store surfaces this service needs (mirror the route seams). */
export interface ChatDevJobRepoStore {
  getRepo(id: string): Promise<DevRepo | null>;
  listRepos(): Promise<DevRepo[]>;
}

export interface ChatDevJobJobStore {
  createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob>;
  getJob(id: string): Promise<DevJob | null>;
  listJobs(filter?: {
    repoId?: string;
    status?: DevJobStatus;
    limit?: number;
  }): Promise<DevJob[]>;
  listEvents(jobId: string, afterId?: number, limit?: number): Promise<DevJobEvent[]>;
}

export interface ChatDevJobServiceDeps {
  repoStore: ChatDevJobRepoStore;
  jobStore: ChatDevJobJobStore;
  /** The chat session's operator identity. */
  caller: ChatDevJobCaller;
  /** Repos the operator enabled for this agent (agent-config dev-jobs grant). */
  allowedRepoIds: readonly string[];
  /** W0 launch-authorization predicate (creator OR allowed_launchers role). */
  isPermittedLauncher: (repo: DevRepo, caller: ChatDevJobCaller) => boolean;
  /** Backend/authMode placement — the same seam boot feeds the host service. */
  resolveJobPlacement: (repo: DevRepo) => {
    backend: RunnerBackendKind;
    authMode?: DevJobAuthMode;
  };
  /** Override for tests; defaults to the real one-time token minter. */
  mintRunnerToken?: () => { hash: string };
}

function toDescriptor(j: DevJob): DevJobDescriptor {
  return {
    id: j.id,
    repoId: j.repoId,
    kind: j.kind,
    status: j.status,
    phase: j.phase,
    ...(j.branch ? { branch: j.branch } : {}),
    ...(j.prUrl ? { prUrl: j.prUrl } : {}),
    createdAt: j.createdAt,
  };
}

export function createChatDevJobService(
  deps: ChatDevJobServiceDeps,
): ChatDevJobService {
  const mint =
    deps.mintRunnerToken ?? (() => ({ hash: defaultMintRunnerToken().hash }));
  const allowed = new Set(deps.allowedRepoIds);

  // Reuse the ctx.devJobs host service for the READ paths. Its plugin-shaped
  // create/cancel are never called here, so `grants`/`finalize` are inert stubs.
  const host: DevJobsHostService = createDevJobsHostService({
    jobStore: deps.jobStore,
    repoStore: deps.repoStore,
    grants: { listRepoIdsForPlugin: async (): Promise<string[]> => [] },
    finalize: async (): Promise<void> => {
      throw new Error('chatDevJobService: finalize is not used by the chat surface');
    },
    resolveJobPlacement: deps.resolveJobPlacement,
    ...(deps.mintRunnerToken ? { mintRunnerToken: deps.mintRunnerToken } : {}),
  });

  /** Ids of repos the caller is authorized to launch on: granted ∩ launchable. */
  async function authorizedRepos(): Promise<DevRepo[]> {
    if (allowed.size === 0) return [];
    const repos = await deps.repoStore.listRepos();
    return repos.filter(
      (r) => allowed.has(r.id) && deps.isPermittedLauncher(r, deps.caller),
    );
  }

  return {
    async resolveLaunchableRepo(ref) {
      const repos = await authorizedRepos();
      const byId = repos.find((r) => r.id === ref);
      if (byId) return { repoId: byId.id, repoName: byId.name };
      const byName = repos.filter((r) => r.name === ref);
      if (byName.length === 1) {
        const only = byName[0]!;
        return { repoId: only.id, repoName: only.name };
      }
      // Ambiguous name, or not in the authorized set: refuse (no oracle).
      return null;
    },

    async startJob(input) {
      const repo = await deps.repoStore.getRepo(input.repoId);
      // Defense in depth: re-check the launch authorization at create time — a
      // model must never create a job on a repo it (the operator) can't launch.
      if (
        !repo ||
        !allowed.has(repo.id) ||
        !deps.isPermittedLauncher(repo, deps.caller)
      ) {
        throw new Error(
          `repository "${input.repoId}" is not authorized for this session`,
        );
      }
      const placement = deps.resolveJobPlacement(repo);
      const minted = mint();
      const job = await deps.jobStore.createJob({
        repoId: repo.id,
        kind: input.kind,
        brief: input.brief,
        source: 'chat',
        sourceRef: input.sourceRef ?? null,
        backend: placement.backend,
        // Chat is never admin, and subscription auth is admin-only (spec §6b),
        // so a chat job always runs on the api_key credential mode.
        authMode: 'api_key',
        createdBy: deps.caller.sub,
        runnerTokenHash: minted.hash,
      });
      return toDescriptor(job);
    },

    async getJob(jobId): Promise<DevJobStatusResult | null> {
      const descriptor = await host.getJob(jobId);
      if (!descriptor) return null;
      if (!allowed.has(descriptor.repoId)) return null;
      const repo = await deps.repoStore.getRepo(descriptor.repoId);
      if (!repo || !deps.isPermittedLauncher(repo, deps.caller)) return null;
      const recentEvents = await host.listJobEvents(jobId);
      return { descriptor, recentEvents };
    },

    async listJobs(filter) {
      const scope = (await authorizedRepos()).map((r) => r.id);
      if (scope.length === 0) return [];
      if (filter.repoId && !scope.includes(filter.repoId)) return [];
      const repoIds = filter.repoId ? [filter.repoId] : scope;
      return host.listJobs({
        repoIds,
        ...(filter.status ? { status: filter.status } : {}),
      });
    },
  };
}
