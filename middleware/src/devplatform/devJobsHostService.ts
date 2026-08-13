/**
 * Read-side dev-job service: descriptor/event projection over `DevJobStore`.
 *
 * HISTORY — this used to be the concrete `'devJobs'` host service backing the
 * `ctx.devJobs` plugin accessor. That accessor never had a provider or a
 * consumer and threw on every call, so it was deleted
 * (`specs/470-dev-platform-plugin/dormant-capabilities.md` §2). What survived
 * is exactly the part the chat surface already used.
 *
 * Shed with the accessor, because every one of them existed only for the
 * plugin path:
 *   - `listGrantedRepoIds` + the `grants` dep (`dev_repo_plugin_grants`)
 *   - `createJob` (hardcoded `source:'plugin'` / `created_by:'plugin:<id>'`)
 *     and with it the `repoStore`, `resolveJobPlacement` and `mintRunnerToken`
 *     deps — the chat surface creates jobs itself with `source:'chat'`
 *   - `cancelJob(jobId, requestedByPluginId)` and its `finalize` dep — the
 *     `requestedByPluginId` creator check has no meaning without plugin
 *     callers, and the chat surface never cancelled through here (it passed an
 *     always-throwing `finalize` stub)
 *
 * The sole consumer is `chatDevJobService.ts`, which calls `getJob`,
 * `listJobs` and `listJobEvents`. Its own authorization envelope
 * (`allowedRepoIds` ∩ `isPermittedLauncher`) sits ON TOP of this layer — this
 * unit performs no authorization of its own beyond honouring the `repoIds`
 * scope it is handed.
 */

import type { DevJobDescriptor, DevJobEventRecord } from './devJobTypes.js';
import type { DevJob, DevJobEvent, DevJobStatus } from './types.js';

/** Narrow read surface of `DevJobStore` this service needs. */
export interface DevJobsHostJobStore {
  getJob(id: string): Promise<DevJob | null>;
  listJobs(filter?: {
    repoId?: string;
    repoIds?: readonly string[];
    status?: DevJobStatus;
    limit?: number;
  }): Promise<DevJob[]>;
  listEvents(jobId: string, afterId?: number, limit?: number): Promise<DevJobEvent[]>;
}

/**
 * Repo-scoped read surface over dev jobs. `listJobs` is scoped by the caller;
 * `getJob` / `listJobEvents` are UNSCOPED by design — the caller resolves the
 * descriptor's `repoId` against its own authorization envelope (see
 * `chatDevJobService.getJob`).
 */
export interface DevJobsHostService {
  getJob(jobId: string): Promise<DevJobDescriptor | undefined>;
  /** Scope is narrowed to `repoIds` by the caller. */
  listJobs(filter: {
    repoIds: readonly string[];
    status?: DevJobStatus;
  }): Promise<readonly DevJobDescriptor[]>;
  listJobEvents(jobId: string, afterId?: number): Promise<readonly DevJobEventRecord[]>;
}

export interface DevJobsHostServiceDeps {
  jobStore: DevJobsHostJobStore;
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
  return {
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
      // Scope to the caller's repos IN SQL (before LIMIT), so a caller's own
      // jobs can never be silently dropped behind other repos' rows under the
      // store limit (Forge W3 — the earlier list-all-then-narrow could omit
      // them). The in-memory `scope` filter is kept as defense-in-depth against
      // a store that ignores the filter.
      const jobs = await deps.jobStore.listJobs({
        repoIds: [...scope],
        ...(filter.status ? { status: filter.status } : {}),
      });
      return jobs.filter((j) => scope.has(j.repoId)).map(toDescriptor);
    },

    async listJobEvents(
      jobId: string,
      afterId?: number,
    ): Promise<readonly DevJobEventRecord[]> {
      const events = await deps.jobStore.listEvents(jobId, afterId);
      return events.map(toEventRecord);
    },
  };
}
