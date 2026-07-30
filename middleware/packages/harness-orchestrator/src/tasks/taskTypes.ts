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
 * `devplatform/devJobOrchestratorTool.ts` already implements exactly that shape
 * (`dev_job_start` returns `{status:'job_started', jobId, phase:'queued'}` at
 * once). This module lifts that shape out of the dev platform so ANY tool can
 * opt in, without a second bespoke job store.
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
 * which is exactly what `dev_job` needs, because its terminal write is
 * brand-gated through `finalizeDevJob.ts`.
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
 * A richer per-implementor status set (e.g. dev_job's ten-value
 * `DevJobStatus`) projects DOWN onto this; the implementor keeps its own
 * vocabulary internally and reports the projection here. `phase` carries the
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
 * Lease tokens are UUIDs. Mirrors `devJobStore`'s `UUID_RE`: a non-UUID is
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
 * The worker catches this and stops. Mirrors `DevJobLeaseLostError` /
 * conductor's `RunLeaseLostError`.
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
 * Claim/lease semantics (mirroring `devJobStore.claimNextQueued`):
 *  - `claimNextPending` atomically hands ONE unclaimed `working` task to the
 *    caller and stamps the caller's lease. Two concurrent workers never get the
 *    same task.
 *  - every subsequent write is FENCED on that lease; a write whose lease no
 *    longer matches throws {@link TaskLeaseLostError} rather than silently
 *    winning.
 *  - `finish` is the single terminal transition, and it is fenced too — so a
 *    worker that lost its lease cannot overwrite the outcome the new owner
 *    recorded.
 */
export interface TaskStore extends TaskReadStore {
  create(input: NewTaskInput): Promise<TaskDescriptor>;
  /**
   * Claim the oldest unclaimed `working` task, optionally restricted to one
   * `kind`. `lease` must be a UUID (see {@link TASK_LEASE_UUID_RE}).
   * Returns the claimed descriptor plus the stored input, or `null`.
   */
  claimNextPending(
    lease: string,
    kind?: string,
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
   * A `working`/`input_required` task whose last heartbeat is older than this
   * is failed as abandoned. Its worker is gone (crash, restart, deploy).
   */
  readonly staleAfterMs: number;
  /** Terminal tasks older than this are deleted outright. */
  readonly purgeTerminalAfterMs: number;
}

export interface TaskReapResult {
  /** `working`/`input_required` tasks force-failed as abandoned. */
  readonly staleFailed: number;
  /** Terminal tasks deleted. */
  readonly purged: number;
}
