/**
 * W2-2 (issue #543, rescoped) — `dev_job` as the FIRST implementor of the
 * generic long-running task seam (`@omadia/orchestrator`'s `TaskStore`).
 *
 * ## Why this is an adapter and not a rewrite
 *
 * The seam was extracted FROM `devJobStore` + `devJobOrchestratorTool`, so
 * proving it is a faithful description of dev_job's semantics means driving
 * dev_job's real claim/lease, event tail, and terminal transition THROUGH the
 * seam's interface and getting identical behaviour. That is what this file does.
 *
 * It is deliberately ADDITIVE and INSERT-ONLY with respect to the dev platform:
 * not one line of `devJobStore.ts` or `devJobOrchestratorTool.ts` changes, no
 * migration is added, and `dev_job_start` / `dev_job_status` / `dev_job_list`
 * keep their exact result contracts (`{"status":"job_started",…}` still parses in
 * `web-ui/app/_components/devjobs/devJobChatCardState.ts`). There is open work
 * extracting the dev platform into an installable plugin (PR #536 merged, #538
 * open); keeping this file separate means that extraction moves one new file
 * rather than resolving conflicts inside two hot ones.
 *
 * ## Status projection
 *
 * dev_job's ten-value `DevJobStatus` projects DOWN onto the seam's four-value
 * MCP-Tasks-shaped vocabulary. Nothing is lost that a caller needs: the precise
 * dev_job status remains readable via `dev_job_status`, and `TaskDescriptor.phase`
 * carries the pipeline phase.
 *
 *   queued | provisioning | running | applying  ->  working
 *   waiting                                     ->  input_required
 *   done                                        ->  completed
 *   failed | cancelled | stalled | budget_exceeded -> failed
 *
 * `cancelled` maps to `failed` rather than `completed` because from the caller's
 * point of view the work did not produce its result — the seam's vocabulary has
 * no "cancelled", and reporting a cancel as `completed` would make a poll claim
 * a result that does not exist.
 *
 * ## The one intentional divergence: `finish` fencing
 *
 * The seam's `finish` is lease-fenced. dev_job's `finishTerminal` deliberately is
 * NOT — "cancel routes and the reaper legitimately finalize jobs they do not
 * lease" (`devJobStore.ts`). This adapter honours BOTH: a write is accepted when
 * the presented lease matches, OR when the job currently holds no lease at all
 * (the administrative/reaper case). A write presenting a lease that does not
 * match a lease the job DOES hold is rejected with `TaskLeaseLostError` — which
 * is the property the fence exists for, and the one the conformance test pins.
 */

import {
  TaskLeaseLostError,
  TASK_LEASE_UUID_RE,
  type NewTaskInput,
  type TaskDescriptor,
  type TaskEventRecord,
  type TaskListFilter,
  type TaskLifecycleStatus,
  type TaskReapOptions,
  type TaskReapResult,
  type TaskStore,
  type TerminalTaskPatch,
} from '@omadia/orchestrator';

import type { DevJobSweepScope, ListJobsFilter } from './devJobStore.js';
import type {
  DevJob,
  DevJobEvent,
  DevJobStatus,
  NewDevJob,
} from './types.js';

// ---------------------------------------------------------------------------
// Projection.
// ---------------------------------------------------------------------------

/** dev_job status -> seam status. Exhaustive by construction: the `Record` key
 *  type is `DevJobStatus`, so adding a status to the union fails the build here
 *  until it is projected, instead of silently defaulting to something wrong. */
const STATUS_PROJECTION: Record<DevJobStatus, TaskLifecycleStatus> = {
  queued: 'working',
  provisioning: 'working',
  running: 'working',
  applying: 'working',
  waiting: 'input_required',
  done: 'completed',
  failed: 'failed',
  cancelled: 'failed',
  stalled: 'failed',
  budget_exceeded: 'failed',
};

export function projectDevJobStatus(status: DevJobStatus): TaskLifecycleStatus {
  return STATUS_PROJECTION[status];
}

/**
 * dev_job -> TaskDescriptor.
 *
 * `result` is rendered as compact JSON of the dev_job result (outcome + refs),
 * NOT the diff or transcript: those live in artifacts behind an authorized route,
 * and copying them here would put unbounded, PII-bearing content on a poll path.
 */
export function toTaskDescriptor(job: DevJob): TaskDescriptor {
  return {
    id: job.id,
    kind: job.kind,
    status: projectDevJobStatus(job.status),
    phase: job.phase,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    endedAt: job.endedAt,
    claimedBy: job.claimedBy,
    lastHeartbeatAt: job.lastHeartbeatAt,
    result: job.result ? JSON.stringify(job.result) : null,
    error: job.error,
    // No per-caller owner is tracked here: these tasks are operator-initiated
    // through an already-authenticated admin surface, not started by arbitrary
    // tool callers. `null` means "this implementor scopes no reads", which the
    // tool layer treats as unowned rather than as owned-by-nobody.
    createdBy: null,
  };
}

/** dev_job event -> seam event. `id` is the seam's `seq`: it is the monotonic
 *  IDENTITY column dev_job's own SSE uses, whereas dev_job's `seq` restarts per
 *  provision and would go backwards across a re-provision. */
export function toTaskEvent(ev: DevJobEvent): TaskEventRecord {
  const message = ev.payload['message'];
  return {
    seq: ev.id,
    ts: ev.ts,
    type: ev.type,
    message: typeof message === 'string' ? message : JSON.stringify(ev.payload),
  };
}

// ---------------------------------------------------------------------------
// Injected surfaces — narrow reads of the real stores (mirrors the route seams
// in `chatDevJobService.ts`, so a test can drive this with fakes).
// ---------------------------------------------------------------------------

/** The subset of `DevJobStore` this adapter uses. */
export interface DevJobTaskJobStore {
  createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob>;
  getJob(id: string): Promise<DevJob | null>;
  listJobs(filter?: ListJobsFilter): Promise<DevJob[]>;
  claimNextQueued(claimedBy: string): Promise<DevJob | null>;
  touchHeartbeat(jobId: string): Promise<boolean>;
  appendEvents(
    jobId: string,
    provision: number,
    events: readonly { seq: number; type: string; payload: Record<string, unknown> }[],
  ): Promise<number>;
  findStalled(cutoff: Date, scope?: DevJobSweepScope): Promise<DevJob[]>;
  /** Optional so a unit-test fake need not implement it; absent ⇒ empty tail. */
  listEvents?(
    jobId: string,
    afterId?: number,
    limit?: number,
  ): Promise<DevJobEvent[]>;
}

export interface DevJobTaskStoreDeps {
  readonly jobStore: DevJobTaskJobStore;
  /**
   * How a task is created. Bound by the caller to the SAME launch path chat
   * uses (`ChatDevJobService.startJob`) so this adapter never duplicates launch
   * authorization — a repo the operator may not launch on stays unreachable.
   */
  readonly createJob: (input: unknown) => Promise<DevJob>;
  /**
   * The terminal transition. Bound to `finalizeDevJob` so the brand-gated single
   * choke point is preserved: this adapter cannot and does not call
   * `DevJobStore.finishTerminal` itself.
   */
  readonly finalize: (
    jobId: string,
    status: DevJobStatus,
    patch: { error?: string },
  ) => Promise<DevJob | null>;
  /** Terminal-row purge, bound to `DevRetentionRunner.purgeTerminalJobs`. */
  readonly purgeTerminalJobs?: (
    olderThanDays: number,
    now: Date,
  ) => Promise<number>;
  /**
   * W3-A — narrows `reapOrphans`' stalled sweep. OMITTED in production, where the
   * reaper is deliberately database-global (see {@link DevJobSweepScope}).
   *
   * Set at CONSTRUCTION rather than per call because `reapOrphans` implements the
   * generic {@link TaskStore} contract, whose `TaskReapOptions` must stay free of
   * dev-platform concepts like a repo id.
   */
  readonly sweepScope?: DevJobSweepScope;
}

const MS_PER_DAY = 86_400_000;

/** Host/control-plane event provision (`devJobStore.HOST_EVENT_PROVISION`). */
const HOST_PROVISION = 0;

/**
 * Build the `dev_job` view of the {@link TaskStore} seam.
 *
 * Every method delegates; nothing is reimplemented. That is the point — the
 * conformance test drives real dev_jobs rows through this and asserts the
 * behaviour is byte-for-byte the behaviour `devJobStore.pg.test.ts` already
 * pins for the same operations.
 */
export function createDevJobTaskStore(deps: DevJobTaskStoreDeps): TaskStore {
  const { jobStore } = deps;

  /**
   * Resolve a job for a fenced write. Accepts the write when the lease matches,
   * or when the job holds NO lease (the administrative / reaper case dev_job
   * legitimately relies on — see the module header). Rejects a mismatched lease.
   */
  async function fenced(id: string, lease: string): Promise<DevJob> {
    const job = await jobStore.getJob(id);
    if (!job) throw new TaskLeaseLostError(id);
    if (job.claimedBy !== null && job.claimedBy !== lease) {
      throw new TaskLeaseLostError(id);
    }
    return job;
  }

  return {
    async create(input: NewTaskInput): Promise<TaskDescriptor> {
      const job = await deps.createJob(input.input);
      return toTaskDescriptor(job);
    },

    async get(id: string): Promise<TaskDescriptor | null> {
      const job = await jobStore.getJob(id);
      return job ? toTaskDescriptor(job) : null;
    },

    async list(filter: TaskListFilter = {}): Promise<readonly TaskDescriptor[]> {
      // The seam's four-value status is a MANY-to-one projection, so it cannot be
      // pushed into SQL as a single `status =`. Fetch and project, then filter —
      // with the limit applied AFTER projection so a `working` filter cannot
      // silently return fewer rows than exist because terminal rows ate the LIMIT.
      const jobs = await jobStore.listJobs({ limit: 500 });
      let out = jobs.map(toTaskDescriptor);
      if (filter.kind !== undefined) out = out.filter((d) => d.kind === filter.kind);
      if (filter.status !== undefined) {
        out = out.filter((d) => d.status === filter.status);
      }
      const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), 500);
      return out.slice(0, limit);
    },

    async eventTail(id: string, limit: number): Promise<readonly TaskEventRecord[]> {
      const n = Math.min(Math.max(1, Math.trunc(limit)), 2000);
      const events = (await jobStore.listEvents?.(id, undefined, 2000)) ?? [];
      return events.slice(-n).map(toTaskEvent);
    },

    async claimNextPending(
      lease: string,
      kind?: string,
      taskId?: string,
    ): Promise<{ descriptor: TaskDescriptor; input: unknown } | null> {
      if (!TASK_LEASE_UUID_RE.test(lease)) {
        throw new TypeError(`claimNextPending: lease must be a UUID (got '${lease}')`);
      }
      const job = await jobStore.claimNextQueued(lease);
      if (!job) return null;
      // The `taskId` claim hint is ADVISORY and this store cannot honour it:
      // `claimNextQueued` is a bare `FOR UPDATE SKIP LOCKED` pool pop with no id
      // predicate, and dev_job exposes no release primitive, so narrowing here
      // would mean claiming a job and then abandoning it under a live lease —
      // exactly the strand the hint exists to prevent. The seam contract
      // therefore makes the RETURNED descriptor authoritative and requires the
      // caller to follow its claim through; the hint is recorded as observed and
      // deliberately not applied.
      void taskId;
      // dev_job's claim is not kind-filtered (its worker claims any queued job).
      // Surfacing that honestly: a kind filter the underlying store cannot honour
      // is reported as "nothing to claim" rather than silently claiming the wrong
      // kind and handing it to the wrong executor.
      if (kind !== undefined && job.kind !== kind) return null;
      return { descriptor: toTaskDescriptor(job), input: { jobId: job.id } };
    },

    async heartbeat(id: string, lease: string): Promise<void> {
      await fenced(id, lease);
      const ok = await jobStore.touchHeartbeat(id);
      // 0 rows ⇒ the job went terminal between the read and the write.
      if (!ok) throw new TaskLeaseLostError(id);
    },

    async setPhase(id: string, lease: string, phase: string): Promise<void> {
      // Phase transitions in dev_job are `advancePhase(from, to)` — fenced on the
      // phase being LEFT, which a generic `setPhase(to)` cannot express without
      // re-reading and racing. dev_job's pipeline owns its own phase machine
      // (`phaseEngine.ts`), so the seam does not get to drive it: this is a
      // deliberate no-op after the fence check, not a silent failure.
      await fenced(id, lease);
      void phase;
    },

    async appendEvents(
      id: string,
      lease: string,
      events: readonly { type: string; message: string }[],
    ): Promise<void> {
      if (events.length === 0) return;
      await fenced(id, lease);
      // Host-emitted events use provision 0 and a per-batch seq, matching
      // `finalizeDevJob`'s own status writes.
      await jobStore.appendEvents(
        id,
        HOST_PROVISION,
        events.map((e, i) => ({
          seq: i,
          // dev_job validates its event type union; anything the seam does not
          // map is recorded as a `log` line rather than throwing away the batch.
          type: e.type === 'status' || e.type === 'phase' ? e.type : 'log',
          payload: { message: e.message },
        })),
      );
    },

    async finish(
      id: string,
      lease: string,
      patch: TerminalTaskPatch,
    ): Promise<TaskDescriptor> {
      await fenced(id, lease);
      const devStatus: DevJobStatus = patch.status === 'completed' ? 'done' : 'failed';
      const job = await deps.finalize(id, devStatus, {
        ...(patch.error !== undefined ? { error: patch.error } : {}),
      });
      if (!job) throw new TaskLeaseLostError(id);
      return toTaskDescriptor(job);
    },

    async requireInput(id: string, lease: string): Promise<TaskDescriptor> {
      // dev_job reaches `input_required` only via its own gate machine (the W2
      // plan gate parks the job at `await_human` with status `waiting`), and the
      // gate must be attributable to a HUMAN — never to a model turn. So the seam
      // is NOT given a way to open one; it can only observe the projection.
      const job = await fenced(id, lease);
      return toTaskDescriptor(job);
    },

    async reapOrphans(opts: TaskReapOptions): Promise<TaskReapResult> {
      const now = opts.now ?? new Date();
      const cutoff = new Date(now.getTime() - opts.staleAfterMs);
      const stalled = await jobStore.findStalled(
        cutoff,
        ...(deps.sweepScope ? ([deps.sweepScope] as const) : ([] as const)),
      );
      let staleFailed = 0;
      for (const job of stalled) {
        const finished = await deps.finalize(job.id, 'stalled', {
          error:
            'task abandoned: no worker heartbeat within the orphan window ' +
            '(worker crashed, restarted, or was never started)',
        });
        if (finished) staleFailed += 1;
      }
      const purged = deps.purgeTerminalJobs
        ? await deps.purgeTerminalJobs(
            Math.max(1, Math.ceil(opts.purgeTerminalAfterMs / MS_PER_DAY)),
            now,
          )
        : 0;
      return { staleFailed, purged };
    },
  };
}
