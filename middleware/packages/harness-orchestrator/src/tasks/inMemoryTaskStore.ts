/**
 * W2-2 — process-local {@link TaskStore}.
 *
 * The reference implementor of the seam's claim/lease semantics, and the
 * backing store for consumers that have no table of their own yet.
 *
 * ## Why in-memory, deliberately
 *
 * W2-2 is a seam EXTRACTION with no schema change: migrations `0031`/`0032` are
 * taken by parallel units, and adding a `tasks` table here would collide. A
 * durable second implementor is the follow-up. The consequence is honest and
 * bounded: tasks held here do not survive a restart, so a restart is treated
 * exactly like a crashed worker — the state is simply gone and the model's
 * `<tool>_status` poll answers "not found". A Postgres-backed implementor is
 * unaffected.
 *
 * ## Atomicity
 *
 * Node runs one JS task at a time, so `claimNextPending`'s read-then-stamp is
 * atomic by construction: nothing can interleave between picking the candidate
 * and writing its lease because there is no `await` between them. That is the
 * same guarantee `FOR UPDATE SKIP LOCKED` buys the Postgres implementor, for a
 * single process. It does NOT hold across processes — which is precisely why the
 * lease fence below still exists and still throws.
 */

import { randomUUID } from 'node:crypto';

import {
  TASK_LEASE_UUID_RE,
  TaskLeaseLostError,
  isTerminalTaskStatus,
  type NewTaskInput,
  type TaskDescriptor,
  type TaskEventRecord,
  type TaskListFilter,
  type TaskReapOptions,
  type TaskReapResult,
  type TaskStore,
  type TerminalTaskPatch,
} from './taskTypes.js';

/** Per-task event cap. The tail is for "what is it doing", not an audit log,
 *  so old lines are dropped. */
const DEFAULT_MAX_EVENTS = 200;

/**
 * Soft ceiling on retained tasks. NOT a hard bound, and calling it one was
 * wrong: `evictIfOverCapacity` only ever drops TERMINAL rows (evicting a live
 * task would strand its worker and make the model's next poll say "not found"
 * about work that is still running). So the map is bounded at this size only
 * while terminal rows are available to sacrifice — with N live tasks and no
 * terminal ones it grows to N regardless. The real bound on live rows is the
 * orphan sweep, which turns them terminal; this constant bounds the debris the
 * sweep has not yet purged. Oldest terminal tasks evict first.
 */
const DEFAULT_MAX_TASKS = 500;

interface TaskRow {
  descriptor: TaskDescriptor;
  input: unknown;
  createdBy: string | null;
  events: TaskEventRecord[];
  nextSeq: number;
}

export interface InMemoryTaskStoreOptions {
  readonly maxEvents?: number;
  readonly maxTasks?: number;
  /** Injected clock. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly rows = new Map<string, TaskRow>();
  private readonly maxEvents: number;
  private readonly maxTasks: number;
  private readonly clock: () => number;

  constructor(opts: InMemoryTaskStoreOptions = {}) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxTasks = opts.maxTasks ?? DEFAULT_MAX_TASKS;
    this.clock = opts.clock ?? ((): number => Date.now());
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * Resolve a row for a lease-fenced write. Throws {@link TaskLeaseLostError}
   * when the task is gone, already terminal, or owned by a different lease —
   * the three cases that must all read as "you no longer own this".
   */
  private fenced(id: string, lease: string): TaskRow {
    const row = this.rows.get(id);
    if (!row) throw new TaskLeaseLostError(id);
    // Terminal immutability. Load-bearing, NOT redundant with the lease check
    // below: `reapOrphans` deliberately does NOT clear `claimedBy` when it fails
    // an abandoned task, so a zombie worker that wakes up afterwards still
    // presents a MATCHING lease. This guard is the only thing stopping it from
    // resurrecting or overwriting an outcome the reaper already recorded.
    if (isTerminalTaskStatus(row.descriptor.status)) {
      throw new TaskLeaseLostError(id);
    }
    if (row.descriptor.claimedBy !== lease) throw new TaskLeaseLostError(id);
    return row;
  }

  async create(input: NewTaskInput): Promise<TaskDescriptor> {
    this.evictIfOverCapacity();
    const ts = this.nowIso();
    const descriptor: TaskDescriptor = {
      id: randomUUID(),
      kind: input.kind,
      status: 'working',
      phase: input.phase ?? 'queued',
      createdAt: ts,
      updatedAt: ts,
      endedAt: null,
      claimedBy: null,
      lastHeartbeatAt: null,
      result: null,
      error: null,
      createdBy: input.createdBy ?? null,
    };
    this.rows.set(descriptor.id, {
      descriptor,
      input: input.input,
      createdBy: input.createdBy ?? null,
      events: [],
      nextSeq: 1,
    });
    return descriptor;
  }

  async get(id: string): Promise<TaskDescriptor | null> {
    return this.rows.get(id)?.descriptor ?? null;
  }

  async list(filter: TaskListFilter = {}): Promise<readonly TaskDescriptor[]> {
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), 500);
    const out: TaskDescriptor[] = [];
    for (const row of this.rows.values()) {
      if (filter.kind !== undefined && row.descriptor.kind !== filter.kind) continue;
      if (filter.status !== undefined && row.descriptor.status !== filter.status) {
        continue;
      }
      if (filter.createdBy !== undefined && row.createdBy !== filter.createdBy) {
        continue;
      }
      out.push(row.descriptor);
    }
    // Newest first — the contract's list order, equivalent to a SQL-backed
    // implementor's `ORDER BY created_at DESC`.
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out.slice(0, limit);
  }

  async eventTail(id: string, limit: number): Promise<readonly TaskEventRecord[]> {
    const row = this.rows.get(id);
    if (!row) return [];
    const n = Math.min(Math.max(1, Math.trunc(limit)), this.maxEvents);
    return row.events.slice(-n);
  }

  async claimNextPending(
    lease: string,
    kind?: string,
    taskId?: string,
  ): Promise<{ descriptor: TaskDescriptor; input: unknown } | null> {
    if (!TASK_LEASE_UUID_RE.test(lease)) {
      throw new TypeError(`claimNextPending: lease must be a UUID (got '${lease}')`);
    }
    // `taskId` narrows the candidate set to exactly one row, which is what makes
    // a per-task runner claim ITS OWN task instead of the pool head. Without it
    // two runners started for two same-kind tasks cross their claims (each takes
    // the other's) — and the crossed pair used to be dropped unfinished under
    // live leases until the reaper failed them 15 minutes later.
    // Oldest-first, mirroring `claimNextQueued`'s `ORDER BY created_at LIMIT 1`.
    let candidate: TaskRow | undefined;
    for (const row of this.rows.values()) {
      const d = row.descriptor;
      if (d.status !== 'working' || d.claimedBy !== null) continue;
      if (kind !== undefined && d.kind !== kind) continue;
      if (taskId !== undefined && d.id !== taskId) continue;
      if (!candidate || d.createdAt < candidate.descriptor.createdAt) candidate = row;
    }
    if (!candidate) return null;
    // No `await` between the scan above and this write — the claim is atomic
    // within this process, which is what makes double-claiming impossible here.
    const ts = this.nowIso();
    candidate.descriptor = {
      ...candidate.descriptor,
      claimedBy: lease,
      lastHeartbeatAt: ts,
      updatedAt: ts,
    };
    return { descriptor: candidate.descriptor, input: candidate.input };
  }

  async heartbeat(id: string, lease: string): Promise<void> {
    const row = this.fenced(id, lease);
    const ts = this.nowIso();
    row.descriptor = { ...row.descriptor, lastHeartbeatAt: ts, updatedAt: ts };
  }

  async setPhase(id: string, lease: string, phase: string): Promise<void> {
    const row = this.fenced(id, lease);
    row.descriptor = { ...row.descriptor, phase, updatedAt: this.nowIso() };
  }

  async appendEvents(
    id: string,
    lease: string,
    events: readonly { type: string; message: string }[],
  ): Promise<void> {
    const row = this.fenced(id, lease);
    if (events.length === 0) return;
    const ts = this.nowIso();
    for (const ev of events) {
      row.events.push({ seq: row.nextSeq, ts, type: ev.type, message: ev.message });
      row.nextSeq += 1;
    }
    if (row.events.length > this.maxEvents) {
      row.events.splice(0, row.events.length - this.maxEvents);
    }
    row.descriptor = { ...row.descriptor, lastHeartbeatAt: ts, updatedAt: ts };
  }

  async finish(
    id: string,
    lease: string,
    patch: TerminalTaskPatch,
  ): Promise<TaskDescriptor> {
    const row = this.fenced(id, lease);
    const ts = this.nowIso();
    row.descriptor = {
      ...row.descriptor,
      status: patch.status,
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      result: patch.result ?? null,
      error: patch.error ?? null,
      endedAt: ts,
      updatedAt: ts,
      claimedBy: null,
    };
    return row.descriptor;
  }

  async requireInput(
    id: string,
    lease: string,
    phase?: string,
  ): Promise<TaskDescriptor> {
    const row = this.fenced(id, lease);
    const ts = this.nowIso();
    // The lease is RELEASED: the task is now waiting on a human, not on this
    // worker, so the claim loop must be free to re-claim it once unblocked.
    row.descriptor = {
      ...row.descriptor,
      status: 'input_required',
      ...(phase !== undefined ? { phase } : {}),
      claimedBy: null,
      updatedAt: ts,
    };
    return row.descriptor;
  }

  /**
   * The one deliberately UNFENCED writer on this store.
   *
   * Every other write goes through {@link fenced} and needs the owning lease.
   * This one does not, and cannot: the whole premise of an orphan sweep is that
   * the lease holder is gone, so demanding its lease would make the sweep
   * unable to do its job. It is the administrative exception the `TaskStore`
   * doc calls out, not a hole in the fence — and it is why terminal
   * immutability in `fenced()` is load-bearing rather than redundant: it is what
   * a zombie worker (which still presents a MATCHING lease, because the sweep
   * preserves `claimedBy`) runs into afterwards.
   */
  async reapOrphans(opts: TaskReapOptions): Promise<TaskReapResult> {
    if (!Number.isFinite(opts.staleAfterMs) || opts.staleAfterMs <= 0) {
      throw new TypeError('reapOrphans: staleAfterMs must be a positive number');
    }
    if (
      !Number.isFinite(opts.purgeTerminalAfterMs) ||
      opts.purgeTerminalAfterMs <= 0
    ) {
      throw new TypeError(
        'reapOrphans: purgeTerminalAfterMs must be a positive number',
      );
    }
    if (
      opts.parkedStaleAfterMs !== undefined &&
      (!Number.isFinite(opts.parkedStaleAfterMs) || opts.parkedStaleAfterMs <= 0)
    ) {
      throw new TypeError(
        'reapOrphans: parkedStaleAfterMs, when given, must be a positive number',
      );
    }
    const nowMs = (opts.now ?? new Date(this.clock())).getTime();
    let staleFailed = 0;
    let purged = 0;

    for (const [id, row] of [...this.rows.entries()]) {
      const d = row.descriptor;
      if (isTerminalTaskStatus(d.status)) {
        const endedMs = d.endedAt ? Date.parse(d.endedAt) : Date.parse(d.updatedAt);
        if (Number.isFinite(endedMs) && nowMs - endedMs >= opts.purgeTerminalAfterMs) {
          this.rows.delete(id);
          purged += 1;
        }
        continue;
      }
      // A PARKED task is waiting on a human, not on a worker. `requireInput`
      // released the lease and froze `lastHeartbeatAt`, and nothing heartbeats a
      // parked row — so judging it by the worker-liveness window force-failed
      // every card a user took longer than 15 minutes to answer, and the answer
      // then landed on a task already marked `failed`. It gets its own explicit
      // window, measured from when it parked, and by default no window at all.
      // An implementor whose stall sweep already excludes its own gate state
      // never had this bug; the generic sweep has to exclude it explicitly.
      const parked = d.status === 'input_required';
      if (parked && opts.parkedStaleAfterMs === undefined) continue;
      // Live task. "Last sign of life" is the heartbeat when a worker ever
      // claimed it, else creation — so a task that was NEVER claimed (no worker
      // running, the classic orphan) is reaped too, instead of leaking forever.
      // A parked task instead ages from `updatedAt`, the moment it parked.
      const lastSeen = parked
        ? Date.parse(d.updatedAt)
        : Date.parse(d.lastHeartbeatAt ?? d.createdAt);
      const window = parked
        ? (opts.parkedStaleAfterMs as number)
        : opts.staleAfterMs;
      if (Number.isFinite(lastSeen) && nowMs - lastSeen >= window) {
        const ts = new Date(nowMs).toISOString();
        // `claimedBy` is deliberately PRESERVED. The reaper is not the owner:
        // keeping the lease records who was working when the task died, and —
        // more importantly — it means a zombie worker waking up later still
        // presents a matching lease, so the terminal guard in `fenced()` is what
        // rejects it. Clearing the lease here would make that guard unreachable
        // and let the lease check alone silently carry the invariant.
        row.descriptor = {
          ...d,
          status: 'failed',
          error: parked
            ? 'task expired: no human answered the input request within the ' +
              'parked-task window'
            : 'task abandoned: no worker heartbeat within the orphan window ' +
              '(worker crashed, restarted, or was never started)',
          endedAt: ts,
          updatedAt: ts,
        };
        staleFailed += 1;
      }
    }
    return { staleFailed, purged };
  }

  /** Test/introspection helper: how many rows are retained right now. */
  size(): number {
    return this.rows.size;
  }

  /**
   * Push back on growth even with no reaper scheduled: drop the oldest TERMINAL
   * rows, and never evict a live task (losing a live handle would strand the
   * worker and lie to the model on its next poll).
   *
   * Consequence, stated rather than implied: when there is nothing terminal to
   * drop this is a no-op and `maxTasks` is exceeded. See
   * {@link DEFAULT_MAX_TASKS}.
   */
  private evictIfOverCapacity(): void {
    if (this.rows.size < this.maxTasks) return;
    const terminal = [...this.rows.entries()]
      .filter(([, r]) => isTerminalTaskStatus(r.descriptor.status))
      .sort((a, b) =>
        a[1].descriptor.createdAt < b[1].descriptor.createdAt ? -1 : 1,
      );
    const target = this.rows.size - this.maxTasks + 1;
    for (let i = 0; i < Math.min(target, terminal.length); i += 1) {
      const entry = terminal[i];
      if (entry) this.rows.delete(entry[0]);
    }
  }
}
