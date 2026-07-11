/**
 * Epic #470 W3 — concrete 'devJobs' host service backing `ctx.devJobs`.
 *
 * Registered in the kernel ServiceRegistry under the name `'devJobs'` by the
 * dev-platform boot module; the plugin-side `createPluginDevJobsAccessor`
 * resolves it lazily and layers the repo-scoping / no-existence-oracle contract
 * on top (see src/platform/pluginContext.ts).
 *
 * This layer owns the two facts the accessor cannot see from a descriptor:
 *   1. the granted-repo set (`dev_repo_plugin_grants`, via the grant store), and
 *   2. the job creator (`dev_jobs.created_by`), used to enforce "only jobs this
 *      plugin created" on cancel.
 *
 * Job-placement policy (backend / authMode admissibility) is injected as
 * `resolveJobPlacement` so W0/W2 keep a single source of truth for it — this
 * unit does not re-implement launcher policy.
 */

import type {
  DevJobCreateRequest,
  DevJobDescriptor,
  DevJobEventRecord,
  DevJobStatus,
} from '@omadia/plugin-api';

import type { DevJobsHostService } from '../platform/pluginContext.js';

import { mintRunnerToken as defaultMintRunnerToken } from './jobToken.js';
import type {
  DevJob,
  DevJobAuthMode,
  DevJobEvent,
  DevRepo,
  NewDevJob,
  RunnerBackendKind,
} from './types.js';

/** `dev_jobs.created_by` marker for a plugin-created job. The `source='plugin'`
 *  column records provenance; this marker records WHICH plugin, so cancel can
 *  enforce single-creator ownership. */
export const PLUGIN_CREATED_BY_PREFIX = 'plugin:';

export function pluginCreatedByMarker(pluginId: string): string {
  return `${PLUGIN_CREATED_BY_PREFIX}${pluginId}`;
}

/** Thrown by `cancelJob` when a plugin tries to cancel a job it did not create. */
export class DevJobNotCreatedByPluginError extends Error {
  constructor(jobId: string, pluginId: string) {
    super(`dev job "${jobId}" was not created by plugin "${pluginId}"`);
    this.name = 'DevJobNotCreatedByPluginError';
  }
}

/** Narrow read/write surface of `DevJobStore` this service needs. */
export interface DevJobsHostJobStore {
  createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob>;
  getJob(id: string): Promise<DevJob | null>;
  listJobs(filter?: {
    repoId?: string;
    status?: DevJobStatus;
    limit?: number;
  }): Promise<DevJob[]>;
  listEvents(jobId: string, afterId?: number, limit?: number): Promise<DevJobEvent[]>;
}

export interface DevJobsHostRepoStore {
  getRepo(id: string): Promise<DevRepo | null>;
}

export interface DevJobsHostGrantStore {
  listRepoIdsForPlugin(pluginId: string): Promise<string[]>;
}

export interface DevJobsHostServiceDeps {
  jobStore: DevJobsHostJobStore;
  repoStore: DevJobsHostRepoStore;
  grants: DevJobsHostGrantStore;
  /** Bound terminal-transition choke point (finalizeDevJob) used by cancel. */
  finalize: (
    jobId: string,
    status: DevJobStatus,
    ctx: { reason?: string },
  ) => Promise<void>;
  /** Resolve backend + authMode for a plugin-created job on this repo. Injected
   *  so W0/W2 launcher-admissibility policy stays authoritative in one place. */
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

function toEventRecord(e: DevJobEvent): DevJobEventRecord {
  return { id: e.id, at: e.ts, type: e.type, payload: e.payload };
}

export function createDevJobsHostService(
  deps: DevJobsHostServiceDeps,
): DevJobsHostService {
  const mint = deps.mintRunnerToken ?? (() => ({ hash: defaultMintRunnerToken().hash }));

  return {
    async listGrantedRepoIds(pluginId: string): Promise<readonly string[]> {
      return deps.grants.listRepoIdsForPlugin(pluginId);
    },

    async createJob(
      input: DevJobCreateRequest & { createdBy: { kind: 'plugin'; id: string } },
    ): Promise<DevJobDescriptor> {
      const repo = await deps.repoStore.getRepo(input.repoId);
      if (!repo) {
        throw new Error(`dev repo "${input.repoId}" not found`);
      }
      const placement = deps.resolveJobPlacement(repo);
      const minted = mint();
      const job = await deps.jobStore.createJob({
        repoId: input.repoId,
        kind: input.kind,
        brief: input.brief,
        source: 'plugin',
        sourceRef: input.sourceRef ?? null,
        backend: placement.backend,
        authMode: placement.authMode ?? 'api_key',
        createdBy: pluginCreatedByMarker(input.createdBy.id),
        runnerTokenHash: minted.hash,
      });
      return toDescriptor(job);
    },

    async getJob(jobId: string): Promise<DevJobDescriptor | undefined> {
      const job = await deps.jobStore.getJob(jobId);
      return job ? toDescriptor(job) : undefined;
    },

    async listJobs(filter: {
      repoIds: readonly string[];
      status?: DevJobStatus;
    }): Promise<readonly DevJobDescriptor[]> {
      const scope = new Set(filter.repoIds);
      if (scope.size === 0) return [];
      // v1: list (optionally status-filtered) then narrow to the granted repo
      // set in memory — mirrors the admin GET /jobs launcher-scoping. The store
      // limit caps the scan; a per-repo fan-out can replace this if a plugin
      // ever holds a large grant set.
      const jobs = await deps.jobStore.listJobs(
        filter.status ? { status: filter.status } : {},
      );
      return jobs.filter((j) => scope.has(j.repoId)).map(toDescriptor);
    },

    async listJobEvents(
      jobId: string,
      afterId?: number,
    ): Promise<readonly DevJobEventRecord[]> {
      const events = await deps.jobStore.listEvents(jobId, afterId);
      return events.map(toEventRecord);
    },

    async cancelJob(jobId: string, requestedByPluginId: string): Promise<void> {
      const job = await deps.jobStore.getJob(jobId);
      if (!job) {
        throw new Error(`dev job "${jobId}" not found`);
      }
      // Single-creator ownership: only the plugin that created the job may
      // cancel it. The accessor has already confirmed the repo is granted.
      if (job.createdBy !== pluginCreatedByMarker(requestedByPluginId)) {
        throw new DevJobNotCreatedByPluginError(jobId, requestedByPluginId);
      }
      await deps.finalize(jobId, 'cancelled', {
        reason: `cancelled by plugin ${requestedByPluginId}`,
      });
    },
  };
}
