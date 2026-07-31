/**
 * W2-2 (issue #543, rescoped) — the generic long-running task seam.
 *
 * ## Why this exists
 *
 * A chat turn is a streaming SSE response with a heartbeat that ends when the
 * model loop ends. There is NO park/resume for a chat turn: holding the stream
 * open for minutes is strictly worse than returning early (proxy idle timeouts,
 * Teams activity expiry, connection reaping). So a tool that genuinely takes
 * minutes must NOT block the turn — it returns a HANDLE immediately and the
 * model says "started, I'll report back".
 *
 * That shape was first hand-rolled inside a single tool, which returned
 * `{status:'started', id, phase:'queued'}` at once and left the caller to poll.
 * This module lifts the shape out into a seam so ANY tool can opt in, without a
 * second bespoke job store.
 *
 * Deliberately NOT the MCP Tasks extension. Internal sub-agent dispatches never
 * cross an MCP boundary, so MCP Tasks solves nothing for the motivating case,
 * and the redesigned extension (SEP-2663) is not shipped even in SDK v2 —
 * `tasks/update` does not exist. The status vocabulary below is nonetheless
 * CHOSEN to match MCP Tasks (`working | input_required | completed | failed`)
 * so a later protocol projection is a mechanical mapping, not a redesign.
 *
 * ## Layering
 *
 * `TaskReadStore` is the model-facing read surface (get / list / event tail).
 * `TaskStore` adds the write half: create, claim-with-lease, heartbeat, event
 * append, and the terminal transition. Splitting them lets a consumer expose
 * reads to a tool while keeping the write half behind its own choke point —
 * which is what an implementor needs whenever its terminal write must pass its
 * own gate (an approval step, a policy check) rather than being reachable by
 * anything holding the read surface.
 *
 * This module has NO dependencies beyond the type system so both the
 * orchestrator package and the middleware app can import it freely.
 */

// ---------------------------------------------------------------------------
// Status vocabulary — chosen to project cleanly onto MCP Tasks (SEP-2663).
// ---------------------------------------------------------------------------

/**
 * Task lifecycle. Intentionally a FOUR-value vocabulary, matching MCP Tasks:
 *
 *  - `working`        — queued or executing. The handle is live.
 *  - `input_required` — blocked on a human decision (a gate). Still live.
 *  - `completed`      — finished successfully; `result` is populated.
 *  - `failed`         — finished unsuccessfully; `error` is populated.
 *
 * A richer per-implementor status set (a ten-value pipeline vocabulary, say)
 * projects DOWN onto this; the implementor keeps its own vocabulary internally
 * and reports the projection here. `phase` carries the
 * implementor-specific progress label so the projection loses no information
 * the model or a card actually needs.
 */
export const TASK_LIFECYCLE_STATUSES = [
  'working',
  'input_required',
  'completed',
  'failed',
] as const;
export type TaskLifecycleStatus = (typeof TASK_LIFECYCLE_STATUSES)[number];

/** Terminal statuses — no further transition is legal once reached. */
export const TERMINAL_TASK_STATUSES = ['completed', 'failed'] as const satisfies
  readonly TaskLifecycleStatus[];

export function isTaskLifecycleStatus(x: unknown): x is TaskLifecycleStatus {
  return (
    typeof x === 'string' &&
    (TASK_LIFECYCLE_STATUSES as readonly string[]).includes(x)
  );
}

export function isTerminalTaskStatus(x: unknown): x is TaskLifecycleStatus {
  return (
    typeof x === 'string' &&
    (TERMINAL_TASK_STATUSES as readonly string[]).includes(x)
  );
}

/**
 * Lease tokens are UUIDs, and a non-UUID is
 * rejected LOUDLY at the seam rather than surfacing as an opaque Postgres
 * `22P02` from a `uuid` column cast further down.
 */
export const TASK_LEASE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Descriptor + events.
// ---------------------------------------------------------------------------

/**
 * The implementor-agnostic view of one long-running task.
 *
 * PRIVACY INVARIANT: `result` may contain arbitrary tool output, including PII.
 * It is only ever surfaced through the `<tool>_status` handler — i.e. as a
 * normal tool result inside a LIVE turn, where the orchestrator's `dispatchTool`
 * privacy pass applies. It must NEVER be copied into a {@link TaskCardPayload}
 * (cards bypass `dispatchTool`). See the note on `TaskCardPayload`.
 */
export interface TaskDescriptor {
  readonly id: string;
  /** Implementor-defined subtype (e.g. `'fix_issue'`, `'subagent.hr'`). */
  readonly kind: string;
  readonly status: TaskLifecycleStatus;
  /** Implementor-specific progress label (e.g. `'queued'`, `'plan'`). */
  readonly phase: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set exactly when `status` is terminal. */
  readonly endedAt: string | null;
  /** Lease token of the worker currently executing, or `null`. */
  readonly claimedBy: string | null;
  readonly lastHeartbeatAt: string | null;
  /** Populated on `completed`. See the privacy invariant above. */
  readonly result: string | null;
  /** Populated on `failed`. */
  readonly error: string | null;
}

/** One line of a task's event tail. `seq` is monotonic per task. */
export interface TaskEventRecord {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly message: string;
}

/** What `create` needs. Ids/timestamps are generated by the store. */
export interface NewTaskInput {
  readonly kind: string;
  /** The opaque payload the executor receives when the task is claimed. */
  readonly input: unknown;
  /** Initial progress label. Defaults to `'queued'`. */
  readonly phase?: string;
  /** Who asked for it — for scoping reads. */
  readonly createdBy?: string;
}

/** Fields a terminal transition may set alongside the status flip. */
export interface TerminalTaskPatch {
  readonly status: 'completed' | 'failed';
  readonly result?: string;
  readonly error?: string;
  readonly phase?: string;
}

export interface TaskListFilter {
  readonly kind?: string;
  readonly status?: TaskLifecycleStatus;
  readonly createdBy?: string;
  readonly limit?: number;
}

/**
 * Thrown when a lease-fenced write updates 0 rows — the task's lease no longer
 * matches this worker's (another worker claimed it, or it is already terminal).
 * The worker catches this and stops. Mirrors conductor's `RunLeaseLostError`.
 */
export class TaskLeaseLostError extends Error {
  constructor(taskId: string) {
    super(
      `task '${taskId}' lease lost (claimed by another worker or already terminal)`,
    );
    this.name = 'TaskLeaseLostError';
  }
}

// ---------------------------------------------------------------------------
// Card payload — what streams into the conversation.
// ---------------------------------------------------------------------------

/**
 * The live status card seeded into the chat stream by a `<tool>_start` call.
 *
 * PRIVACY INVARIANT (load-bearing — enforced by test): a card carries ONLY
 * non-sensitive routing metadata: ids, the projected status, the progress
 * label, and the URL the card polls. It carries NO task result and NO task
 * input. Cards are rendered client-side from the tool result / stream event and
 * therefore do NOT pass through `Orchestrator.dispatchTool`, so anything put
 * here would escape the Privacy Shield data-plane boundary entirely.
 */
export interface TaskCardPayload {
  readonly taskId: string;
  /** The `<tool>_start` tool that produced this card. */
  readonly toolName: string;
  readonly kind: string;
  readonly status: TaskLifecycleStatus;
  readonly phase: string;
  /** Short, non-sensitive human label (e.g. the sub-agent's display name). */
  readonly label: string;
  /** Where the card polls / subscribes for updates; `null` ⇒ poll via tool. */
  readonly eventsUrl: string | null;
}

// ---------------------------------------------------------------------------
// The store seam.
// ---------------------------------------------------------------------------

/** The read half — everything the model-facing `_status` / `_list` tools need. */
export interface TaskReadStore {
  get(id: string): Promise<TaskDescriptor | null>;
  list(filter?: TaskListFilter): Promise<readonly TaskDescriptor[]>;
  /** Newest `limit` events, oldest-first. */
  eventTail(id: string, limit: number): Promise<readonly TaskEventRecord[]>;
}

/**
 * The full seam: reads plus the write half.
 *
 * Claim/lease semantics:
 *  - `claimNextPending` atomically hands ONE unclaimed `working` task to the
 *    caller and stamps the caller's lease. Two concurrent workers never get the
 *    same task.
 *  - every subsequent WORKER write is FENCED on that lease; a write whose lease
 *    no longer matches throws {@link TaskLeaseLostError} rather than silently
 *    winning.
 *  - `finish` is the single terminal transition, and it is fenced too — so a
 *    worker that lost its lease cannot overwrite the outcome the new owner
 *    recorded.
 *  - `reapOrphans` is the ONE deliberately unfenced writer, and the qualifier
 *    above exists for it: an orphan sweep by definition runs when the lease
 *    holder is gone, so it force-fails rows that still carry a live
 *    `claimedBy`. It is administrative, not a worker write, and it is why
 *    terminal immutability is a separate guard from the lease check — that
 *    guard, not the lease, is what rejects the zombie afterwards. Do not read
 *    "every write is lease-fenced" as covering the sweep; it never has.
 *
 * An implementor MAY additionally accept a fenced write against a task that
 * currently holds NO lease — the administrative case, where a cancel route or an
 * orphan reaper legitimately finalizes a task it never claimed. Any implementor
 * that exposes a cancel route relies on exactly that, so its terminal write is
 * deliberately unfenced against a row holding NO lease. What an implementor must
 * NEVER accept is a MISMATCHED lease against a task that does hold one; that is
 * the property the fence exists for.
 */
export interface TaskStore extends TaskReadStore {
  create(input: NewTaskInput): Promise<TaskDescriptor>;
  /**
   * Claim the oldest unclaimed `working` task, optionally restricted to one
   * `kind`. `lease` must be a UUID (see {@link TASK_LEASE_UUID_RE}).
   * Returns the claimed descriptor plus the stored input, or `null`.
   *
   * `taskId` is an ADVISORY hint: "I was spawned for this specific task, prefer
   * it over the pool head". A store that can honour it (see
   * `InMemoryTaskStore`) claims exactly that task or nothing. A store whose
   * underlying claim is a pure pool pop, and which offers no release primitive,
   * may IGNORE the hint and
   * return whatever it claimed — which is why the hint is advisory rather than
   * a filter contract, and why every caller must treat the RETURNED
   * `descriptor.id` as authoritative and follow it through. Claiming a task and
   * then walking away because it was not the expected one strands it under a
   * dead lease until the reaper fails it.
   */
  claimNextPending(
    lease: string,
    kind?: string,
    taskId?: string,
  ): Promise<{ descriptor: TaskDescriptor; input: unknown } | null>;
  /** Lease-fenced liveness touch. Throws {@link TaskLeaseLostError} on 0 rows. */
  heartbeat(id: string, lease: string): Promise<void>;
  /** Lease-fenced progress label update. */
  setPhase(id: string, lease: string, phase: string): Promise<void>;
  /** Lease-fenced event append. Also bumps the heartbeat. */
  appendEvents(
    id: string,
    lease: string,
    events: readonly { type: string; message: string }[],
  ): Promise<void>;
  /** Lease-fenced terminal transition — the ONE way a task ends. */
  finish(
    id: string,
    lease: string,
    patch: TerminalTaskPatch,
  ): Promise<TaskDescriptor>;
  /** Lease-fenced flip to `input_required` (a human gate). */
  requireInput(id: string, lease: string, phase?: string): Promise<TaskDescriptor>;
  /**
   * Orphan sweep (criterion 7). A task nobody polls must not leak a `working`
   * row forever. See `taskReaper.ts` for the scheduled driver.
   */
  reapOrphans(opts: TaskReapOptions): Promise<TaskReapResult>;
}

/** Windows for one orphan sweep. All durations in ms; all must be positive. */
export interface TaskReapOptions {
  /** Injected clock so tests drive it deterministically. */
  readonly now?: Date;
  /**
   * A `working` task whose last heartbeat is older than this is failed as
   * abandoned. Its worker is gone (crash, restart, deploy).
   *
   * Deliberately does NOT cover `input_required`. A parked task is waiting on a
   * HUMAN, not on a worker: `requireInput` releases the lease, nothing
   * heartbeats it, and its heartbeat is frozen at the instant it parked. Judging
   * it by the worker-liveness window meant a user who answered an
   * `input_required` card 16 minutes later landed on a task the generic sweep
   * had already marked `failed`. Parked tasks have their own, explicit window —
   * see {@link parkedStaleAfterMs}.
   */
  readonly staleAfterMs: number;
  /**
   * Optional, MUCH longer ceiling for `input_required` tasks, measured from
   * `updatedAt` (when the task parked or last changed) rather than from the
   * frozen heartbeat.
   *
   * OMITTED ⇒ parked tasks are never force-failed by the sweep. That is the
   * default because a human has no SLA: the honest bound on a parked task is
   * the store's own retention, not the worker-liveness window. Supply it only
   * when a deployment genuinely wants parked work to expire, and give it a value
   * measured in hours, not minutes.
   */
  readonly parkedStaleAfterMs?: number;
  /** Terminal tasks older than this are deleted outright. */
  readonly purgeTerminalAfterMs: number;
}

export interface TaskReapResult {
  /**
   * Tasks force-failed by this sweep: `working` tasks past
   * {@link TaskReapOptions.staleAfterMs}, plus — only when
   * {@link TaskReapOptions.parkedStaleAfterMs} was supplied — `input_required`
   * tasks past that separate window. The two carry different `error` strings on
   * the row, so an operator can still tell them apart.
   */
  readonly staleFailed: number;
  /** Terminal tasks deleted. */
  readonly purged: number;
}
