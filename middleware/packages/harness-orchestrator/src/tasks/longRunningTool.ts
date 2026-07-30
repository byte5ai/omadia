/**
 * W2-2 — the generic registration helper: mark any tool `longRunning` and get
 * the non-blocking `<tool>_start` / `<tool>_status` / `<tool>_list` triple plus
 * a streaming status card, for free.
 *
 * Generalized from `devplatform/devJobOrchestratorTool.ts`, which hand-rolled
 * exactly this shape for `dev_job_*`.
 *
 * ## The contract the model sees
 *
 *   `<tool>_start`  → returns AT ONCE:
 *                     `{"status":"task_started","taskId":…,"tool":…,"kind":…,"phase":"queued"}`
 *   `<tool>_status` → `{taskId, status, phase, result?, error?, recentEvents:[…]}`
 *   `<tool>_list`   → `[{taskId, kind, status, phase}, …]`
 *
 * The model is told, in the prompt doc, that `_start` does NOT answer the
 * question — it hands back a handle. The turn ends with "started, I'll report
 * back". That is the accepted UX, and it is strictly better than the
 * alternative: a chat turn has no park/resume (`chat.ts` streams SSE with a
 * heartbeat and ends when the model loop ends), so holding the stream open for
 * minutes just trades a clean handoff for proxy idle timeouts, Teams activity
 * expiry, and reaped connections.
 *
 * ## Interaction with the per-tool dispatch deadline
 *
 * A separate unit adds `OMADIA_TOOL_DISPATCH_TIMEOUT_MS` (default 120 s) around
 * tool dispatch. It does not interact with this path in any harmful way, BY
 * CONSTRUCTION: every handler here is bounded by a store round-trip, so
 * `_start` returns in milliseconds and can never approach a 120 s deadline. The
 * long work runs in a DETACHED runner (see `startRunner`) that is not inside the
 * dispatch call at all, so the deadline has nothing to cancel. That is the point
 * of the seam — a deadline and a long-running tool stop being in conflict once
 * the tool stops blocking the turn.
 *
 * ## Deferred-result privacy — see `describeDeferredPrivacyPosture()`
 *
 * This is the one genuinely open problem; it is documented rather than papered
 * over. Read that function's doc comment before changing anything here.
 */

import { randomUUID } from 'node:crypto';

import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';

import {
  isTerminalTaskStatus,
  type TaskCardPayload,
  type TaskDescriptor,
  type TaskEventRecord,
  type TaskLifecycleStatus,
  type TaskStore,
} from './taskTypes.js';

// ---------------------------------------------------------------------------
// Registration shape. Structurally identical to
// `devplatform/devJobOrchestratorTool.ts`'s `KernelToolRegistration` and
// `plugins/selfExtension/requestSelfExtensionTool.ts`'s, so boot registers these
// through the very same `nativeToolRegistry.register(name, {…})` call.
// ---------------------------------------------------------------------------

export interface LongRunningToolRegistration {
  readonly name: string;
  readonly spec: NativeToolSpec;
  readonly promptDoc: string;
  readonly handler: NativeToolHandler;
}

/** How many event lines `<tool>_status` returns. Matches `dev_job_status`. */
const STATUS_EVENT_TAIL = 5;

// ---------------------------------------------------------------------------
// Definition — what a consumer supplies.
// ---------------------------------------------------------------------------

/**
 * What the detached runner does. Receives the validated input and a
 * {@link TaskExecutionHandle} for progress reporting; resolves with the
 * model-facing result string, or throws to fail the task.
 */
export type TaskExecutor = (
  input: unknown,
  handle: TaskExecutionHandle,
) => Promise<string>;

/** The lease-bound progress surface handed to a {@link TaskExecutor}. */
export interface TaskExecutionHandle {
  readonly taskId: string;
  /** Lease-fenced progress label update. */
  setPhase(phase: string): Promise<void>;
  /** Lease-fenced event append (also bumps the heartbeat). */
  log(type: string, message: string): Promise<void>;
  /** Lease-fenced liveness touch, for long silent stretches. */
  heartbeat(): Promise<void>;
}

export interface LongRunningToolDefinition {
  /**
   * Base tool name — the triple becomes `<toolName>_start`, `<toolName>_status`,
   * `<toolName>_list`. Must satisfy Anthropic's tool-name charset and leave room
   * for the longest suffix (`_status`, 7 chars) inside the 64-char limit.
   */
  readonly toolName: string;
  /** Marks this definition as opting into the non-blocking path. */
  readonly longRunning: true;
  /** Implementor-defined subtype recorded on every task. */
  readonly kind: string;
  /** What `<tool>_start` does, for the model's tool list. */
  readonly startDescription: string;
  /** JSON-schema properties for `<tool>_start`'s input. */
  readonly inputProperties: Record<string, unknown>;
  readonly requiredInput?: readonly string[];
  /** Optional pre-dispatch validation. Return a string to REFUSE with it. */
  readonly validateInput?: (input: unknown) => string | null;
  /** Short non-sensitive card label (e.g. the sub-agent's display name). */
  readonly cardLabel: string;
  /** Where the card polls, if the consumer exposes an SSE endpoint. */
  readonly eventsUrlFor?: (taskId: string) => string;
  readonly store: TaskStore;
  readonly execute: TaskExecutor;
  /** Injected for tests; defaults to `console.warn`. */
  readonly onRunnerError?: (err: unknown, taskId: string) => void;
}

export interface LongRunningToolHandle {
  readonly registrations: readonly LongRunningToolRegistration[];
  /**
   * Returns and CLEARS the cards queued by `<tool>_start` calls this turn.
   * Accumulates (a turn may start more than one task) and does NOT
   * short-circuit the turn. Mirrors
   * `DevJobOrchestratorTool.takePendingCards()`.
   */
  takePendingCards(): readonly TaskCardPayload[];
  hasPendingCards(): boolean;
  /**
   * Await the in-flight detached runners. TEST-ONLY: production never calls
   * this — the whole point is that the turn does not wait.
   */
  drainForTest(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Deferred-result privacy.
// ---------------------------------------------------------------------------

/**
 * ### Deferred-result privacy posture (criterion 6) — READ BEFORE CHANGING
 *
 * `Orchestrator.dispatchTool` maintains `subAgentDatasetSink`,
 * `subAgentBypassFlag`, and `subAgentOwnerPluginId` inside an
 * `AsyncLocalStorage` scope (`turnContext.run`). A detached runner outlives the
 * turn, so by the time it finishes that scope is gone — there is no sink to
 * intern into and no bypass flag to record against.
 *
 * SOLVED, for the path that matters. A task's `result` never reaches the model
 * out-of-band. It reaches the model ONLY as the return value of the
 * `<tool>_status` handler, which is an ordinary tool call inside a LIVE,
 * LATER turn — so that turn's `dispatchTool` privacy pass applies to it in full,
 * with a live sink and a live bypass flag. Interning happens at POLL time
 * instead of at completion time, and the data-plane boundary holds.
 *
 * Two invariants make that true, and both are enforced by test:
 *
 *  1. {@link TaskCardPayload} carries NO result and NO input. Cards are rendered
 *     from the tool result / stream event and never pass through
 *     `dispatchTool`, so anything on a card escapes the boundary. Cards carry
 *     ids, the projected status, the progress label, and a poll URL — nothing
 *     more.
 *  2. There is no push channel from a finished task into a conversation. The
 *     model must poll. Adding one later WOULD reintroduce the hole and must come
 *     with its own interning path.
 *
 * NOT SOLVED — accepted v1 limitations, to fix with the durable second
 * implementor:
 *
 *  a. Bypass ATTRIBUTION for work done inside the detached runner is lost. If
 *     the executor's own inner tool calls honour an operator `bypass` setting,
 *     that fact cannot be recorded against the originating turn, because the
 *     turn is over and `privacy.recordBypassedTool` has already run for it. The
 *     data still does not leak (see above) — what is missing is the audit line
 *     saying "this turn's task bypassed the shield".
 *  b. `subAgentOwnerPluginId` is not available to the runner, so a deferred
 *     sub-agent's inner calls resolve bypass WITHOUT the owning plugin's
 *     `_privacy_mode`. The safe direction: absent the plugin id the resolver
 *     falls back to NOT bypassing, i.e. the deferred path is stricter than the
 *     inline one, never looser.
 *
 * Returned as a string so the posture is greppable from a test and cannot drift
 * silently away from this comment.
 */
export function describeDeferredPrivacyPosture(): string {
  return (
    'deferred-task results are interned at POLL time by the _status handler ' +
    "inside a live turn's dispatchTool scope; cards carry no result or input; " +
    'bypass attribution for the detached runner is a documented v1 limitation'
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function errString(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: ${prefix}: ${msg}`;
}

/** Compact, model-facing descriptor view (keeps the tool return small). */
function compact(d: TaskDescriptor): Record<string, unknown> {
  return {
    taskId: d.id,
    kind: d.kind,
    status: d.status,
    phase: d.phase,
    ...(d.result !== null ? { result: d.result } : {}),
    ...(d.error !== null ? { error: d.error } : {}),
  };
}

function compactEvent(e: TaskEventRecord): Record<string, unknown> {
  return { seq: e.seq, ts: e.ts, type: e.type, message: e.message };
}

/** `<base>_start` etc., rejecting a base that cannot fit the suffixes. */
export function longRunningToolNames(base: string): {
  start: string;
  status: string;
  list: string;
} {
  if (!/^[a-zA-Z0-9_-]+$/.test(base)) {
    throw new TypeError(
      `longRunningTool: toolName '${base}' must match [a-zA-Z0-9_-]+`,
    );
  }
  // 64 is Anthropic's tool-name limit; `_status` is the longest suffix.
  if (base.length + '_status'.length > 64) {
    throw new TypeError(
      `longRunningTool: toolName '${base}' is too long for the _status suffix`,
    );
  }
  return { start: `${base}_start`, status: `${base}_status`, list: `${base}_list` };
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

/**
 * Turn one long-running operation into the non-blocking tool triple.
 *
 * The returned registrations go to `nativeToolRegistry.register(name, {handler,
 * spec, promptDoc})` exactly like `dev_job_*`'s do, and `takePendingCards()`
 * feeds the chat card stream.
 */
export function defineLongRunningTool(
  def: LongRunningToolDefinition,
): LongRunningToolHandle {
  const names = longRunningToolNames(def.toolName);
  const pendingCards: TaskCardPayload[] = [];
  const inFlight = new Set<Promise<void>>();
  const onRunnerError =
    def.onRunnerError ??
    ((err: unknown, taskId: string): void => {
      console.warn(
        `[longRunningTool:${def.toolName}] detached runner for task ${taskId} threw:`,
        err,
      );
    });

  /**
   * Claim the freshly created task and execute it, DETACHED from the turn.
   *
   * Not awaited by `_start` — that is the entire non-blocking property. Errors
   * are funnelled into the task's terminal `failed` state so a poll always gets
   * an answer; an error while RECORDING the failure is the only thing that
   * reaches `onRunnerError`.
   */
  function startRunner(taskId: string): void {
    const lease = randomUUID();
    const run = (async (): Promise<void> => {
      const claimed = await def.store.claimNextPending(lease, def.kind);
      // Someone else claimed it (another process, or the reaper already failed
      // it). Nothing to do — the owner will finish it.
      if (!claimed || claimed.descriptor.id !== taskId) return;
      const handle: TaskExecutionHandle = {
        taskId,
        setPhase: (phase) => def.store.setPhase(taskId, lease, phase),
        log: (type, message) =>
          def.store.appendEvents(taskId, lease, [{ type, message }]),
        heartbeat: () => def.store.heartbeat(taskId, lease),
      };
      try {
        const result = await def.execute(claimed.input, handle);
        await def.store.finish(taskId, lease, { status: 'completed', result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await def.store.finish(taskId, lease, { status: 'failed', error: message });
      }
    })().catch((err: unknown) => {
      onRunnerError(err, taskId);
    });
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
  }

  const startSpec: NativeToolSpec = {
    name: names.start,
    description: def.startDescription,
    input_schema: {
      type: 'object',
      properties: def.inputProperties,
      ...(def.requiredInput ? { required: [...def.requiredInput] } : {}),
    },
  };

  const statusSpec: NativeToolSpec = {
    name: names.status,
    description:
      `Look up the current status of a task started with \`${names.start}\`: ` +
      'its lifecycle status (working | input_required | completed | failed), ' +
      'progress label, the last few event lines, and — once completed — the ' +
      'result. Returns "Error: …" if the task id is unknown.',
    input_schema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'The task id.' } },
      required: ['taskId'],
    },
  };

  const listSpec: NativeToolSpec = {
    name: names.list,
    description:
      `List tasks started with \`${names.start}\`, optionally filtered by ` +
      'lifecycle status.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['working', 'input_required', 'completed', 'failed'],
          description: 'Optional — restrict to one lifecycle status.',
        },
      },
    },
  };

  const startPromptDoc =
    `${names.start}: begin a long-running operation. It returns IMMEDIATELY ` +
    `with a task id — it does NOT return the answer. Tell the user the work ` +
    `has started and that you will report back; then use ${names.status} ` +
    `(later, or in a following turn) to fetch the outcome. Never wait in a ` +
    `loop for it inside one turn.`;

  const statusPromptDoc =
    `${names.status}: fetch a task's current status, recent events, and — once ` +
    `it is \`completed\` — its result. Use it to answer "how is that going?" ` +
    `and to collect the deferred answer.`;

  const listPromptDoc = `${names.list}: list the tasks this tool has started.`;

  /**
   * `<tool>_start` — validate, create, queue a card, kick off the detached
   * runner, return the handle. Never throws; refusals come back as
   * `Error: …` strings (the orchestrator contract).
   */
  const handleStart: NativeToolHandler = async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return `Error: invalid ${names.start} input — expected an object.`;
    }
    const refusal = def.validateInput?.(raw);
    if (refusal !== undefined && refusal !== null) {
      return `Error: ${refusal}`;
    }
    try {
      const descriptor = await def.store.create({ kind: def.kind, input: raw });
      // Card = non-sensitive metadata ONLY. See describeDeferredPrivacyPosture.
      pendingCards.push({
        taskId: descriptor.id,
        toolName: names.start,
        kind: descriptor.kind,
        status: descriptor.status,
        phase: descriptor.phase,
        label: def.cardLabel,
        eventsUrl: def.eventsUrlFor?.(descriptor.id) ?? null,
      });
      startRunner(descriptor.id);
      return JSON.stringify({
        status: 'task_started',
        taskId: descriptor.id,
        tool: names.start,
        kind: descriptor.kind,
        phase: descriptor.phase,
      });
    } catch (err: unknown) {
      return errString(`${names.start} failed`, err);
    }
  };

  const handleStatus: NativeToolHandler = async (raw: unknown) => {
    const taskId =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['taskId']
        : undefined;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return `Error: invalid ${names.status} input — \`taskId\` must be a non-empty string.`;
    }
    try {
      const descriptor = await def.store.get(taskId);
      if (!descriptor) {
        return `Error: task "${taskId}" was not found or is no longer retained.`;
      }
      const events = await def.store.eventTail(taskId, STATUS_EVENT_TAIL);
      return JSON.stringify({
        ...compact(descriptor),
        terminal: isTerminalTaskStatus(descriptor.status),
        recentEvents: events.map(compactEvent),
      });
    } catch (err: unknown) {
      return errString(`${names.status} failed`, err);
    }
  };

  const handleList: NativeToolHandler = async (raw: unknown) => {
    const statusRaw =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['status']
        : undefined;
    if (statusRaw !== undefined && typeof statusRaw !== 'string') {
      return `Error: invalid ${names.list} input — \`status\` must be a string.`;
    }
    try {
      const tasks = await def.store.list({
        kind: def.kind,
        ...(statusRaw !== undefined
          ? { status: statusRaw as TaskLifecycleStatus }
          : {}),
      });
      return JSON.stringify(tasks.map(compact));
    } catch (err: unknown) {
      return errString(`${names.list} failed`, err);
    }
  };

  return {
    registrations: [
      { name: names.start, spec: startSpec, promptDoc: startPromptDoc, handler: handleStart },
      { name: names.status, spec: statusSpec, promptDoc: statusPromptDoc, handler: handleStatus },
      { name: names.list, spec: listSpec, promptDoc: listPromptDoc, handler: handleList },
    ],
    takePendingCards(): readonly TaskCardPayload[] {
      const cards = [...pendingCards];
      pendingCards.length = 0;
      return cards;
    },
    hasPendingCards(): boolean {
      return pendingCards.length > 0;
    },
    async drainForTest(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  };
}
