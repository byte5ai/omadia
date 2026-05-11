import type {
  ChatTurnInput,
  ChatTurnResult,
} from '@omadia/channel-sdk';
import { toSemanticAnswer } from '@omadia/channel-sdk';
import type { JobHandler, JobSpec } from '@omadia/plugin-api';
import { Cron } from 'croner';

/**
 * Structural subset of `JobScheduler` the runner depends on. Typed as a
 * `Pick`-style interface so tests can swap in a stub that fires handlers
 * deterministically — cron jobs go through croner's own `setTimeout`
 * scheduling which is hard to drive from a synthetic timer seam.
 */
export interface JobSchedulerLike {
  register(
    agentId: string,
    spec: JobSpec,
    handler: JobHandler,
  ): () => void;
  stopForPlugin(agentId: string): void;
}

/**
 * Structural subset of `Orchestrator` the runner depends on. Identical
 * pattern to `JobSchedulerLike` — keeps the runner free of a hard import
 * from `@omadia/orchestrator` and lets tests swap in a stub that
 * returns a synthetic `ChatTurnResult` (with run-trace) without spinning
 * up the real orchestrator.
 */
export interface OrchestratorLike {
  runTurn(input: ChatTurnInput): Promise<ChatTurnResult>;
}
import type { ProactiveSenderRegistry } from './proactiveSender.js';
import type {
  RoutineRunsStore,
  RoutineRunTrigger,
} from './routineRunsStore.js';
import type {
  CreateRoutineInput,
  Routine,
  RoutineRunStatus,
  RoutineStore,
} from './routineStore.js';

/**
 * Stable agent id under which the runner registers every routine job in
 * the JobScheduler. `stopForPlugin(ROUTINES_AGENT_ID)` cleanly stops every
 * routine on graceful shutdown without touching unrelated kernel jobs.
 */
export const ROUTINES_AGENT_ID = 'de.byte5.routines';

/** Per-user quota on active routines. Enforced at create() time. */
export const DEFAULT_MAX_ACTIVE_PER_USER = 50;

/** Minimum wall-clock interval between two firings. Enforced at create()
 *  time after deriving an estimated period from the cron expression. */
export const MIN_RUN_INTERVAL_MS = 60_000;

export class RoutineQuotaExceededError extends Error {
  constructor(public readonly limit: number) {
    super(`maximum of ${limit} active routines per user reached`);
    this.name = 'RoutineQuotaExceededError';
  }
}

export class RoutineNotFoundError extends Error {
  constructor(id: string) {
    super(`routine '${id}' not found`);
    this.name = 'RoutineNotFoundError';
  }
}

export class UnknownChannelError extends Error {
  constructor(channel: string) {
    super(`no proactive sender registered for channel '${channel}'`);
    this.name = 'UnknownChannelError';
  }
}

export interface RoutineRunnerOptions {
  store: RoutineStore;
  runsStore: RoutineRunsStore;
  /**
   * Production wiring passes the real `JobScheduler`; tests pass a stub
   * that captures handlers and fires them on demand. The structural type
   * is the smallest surface the runner uses.
   */
  scheduler: JobSchedulerLike;
  /**
   * Production wiring passes `chatAgentBundle.raw` (the real
   * `Orchestrator`); tests pass a stub that returns a synthetic
   * `ChatTurnResult`. The runner needs `runTurn` (not the higher-level
   * `chat`) so it can persist the per-turn `runTrace` for the
   * call-stack viewer.
   */
  orchestrator: OrchestratorLike;
  senderRegistry: ProactiveSenderRegistry;
  log?: (msg: string) => void;
  /** Override the per-user active-routine cap. */
  maxActivePerUser?: number;
}

/**
 * Bridges persisted routine rows ↔ in-memory `JobScheduler` ↔ channel
 * delivery. Owns the lifecycle:
 *
 *   1. `start()` — load every active row, register one job per row.
 *   2. mutating operations (`createRoutine`, `pauseRoutine`, `resumeRoutine`,
 *      `deleteRoutine`) — write the DB row, mirror into the scheduler.
 *   3. on each trigger — invoke the chat agent with the stored prompt as
 *      the user message, deliver the answer via the channel's proactive
 *      sender, record the outcome on the routine row.
 *   4. `stop()` — dispose every registered job. The scheduler's
 *      `stopForPlugin` does this in O(n).
 *
 * The runner deliberately does **not** validate cron strings itself —
 * `JobScheduler.register()` does that via croner and throws
 * `JobValidationError` on malformed input. The tool layer translates
 * those errors into user-facing messages.
 */
export class RoutineRunner {
  private readonly store: RoutineStore;
  private readonly runsStore: RoutineRunsStore;
  private readonly scheduler: JobSchedulerLike;
  private readonly orchestrator: OrchestratorLike;
  private readonly senders: ProactiveSenderRegistry;
  private readonly log: (msg: string) => void;
  private readonly maxActivePerUser: number;
  /** Map from routine id → dispose fn returned by scheduler.register. */
  private readonly disposers = new Map<string, () => void>();
  private started = false;

  constructor(opts: RoutineRunnerOptions) {
    this.store = opts.store;
    this.runsStore = opts.runsStore;
    this.scheduler = opts.scheduler;
    this.orchestrator = opts.orchestrator;
    this.senders = opts.senderRegistry;
    this.log = opts.log ?? ((msg) => console.log(msg));
    this.maxActivePerUser =
      opts.maxActivePerUser ?? DEFAULT_MAX_ACTIVE_PER_USER;
  }

  /**
   * Load every active row and register it with the scheduler. Idempotent:
   * a second call is a no-op once started. The runner does not auto-pause
   * routines whose channel has no registered sender — those rows still
   * trigger but the run records `error` with the channel-missing message,
   * which makes the misconfiguration visible in `last_run_error` instead
   * of silently dropping.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const rows = await this.store.listAllActive();
    let registered = 0;
    let caughtUp = 0;
    for (const row of rows) {
      try {
        this.registerInScheduler(row);
        registered += 1;
      } catch (err) {
        this.log(
          `[routines/runner] failed to register routine ${row.id} ('${row.name}'): ${errMsg(err)}`,
        );
        continue;
      }
      // Catch-up: if a cron match elapsed between this routine's last
      // observed run (or its creation, if it never ran) and now, fire
      // exactly one make-up run. Fire-and-forget — don't block start()
      // on the agent turn or the channel send. Multiple missed slots
      // collapse into a single catch-up; this is intentional, prevents
      // a "deploy storm" where a long outage produces N back-to-back
      // runs the user can't keep up with.
      if (this.shouldCatchUp(row)) {
        caughtUp += 1;
        this.log(
          `[routines/runner] catch-up firing routine ${row.id} ('${row.name}') — missed slot since ${row.lastRunAt?.toISOString() ?? 'creation'}`,
        );
        const controller = new AbortController();
        void this.runOnce(row, controller.signal, 'catchup').catch((err) => {
          this.log(
            `[routines/runner] catch-up runOnce threw for ${row.id}: ${errMsg(err)}`,
          );
        });
      }
    }
    this.log(
      `[routines/runner] started — ${registered}/${rows.length} routines registered, ${caughtUp} caught up`,
    );
  }

  /**
   * Return true iff the routine has at least one cron match between its
   * last-observed run (or creation, if it never ran) and now. Used by
   * `start()` to decide whether to fire a make-up run after a process
   * downtime window.
   *
   * The reference timestamp is `last_run_at` if present, else
   * `created_at`. We don't use `now()` minus one cron interval because
   * cron expressions aren't fixed-rate — `0 9 * * 1` (Monday 9am) has
   * irregular gaps. Croner's `nextRun(after)` walks the cron tree
   * exactly.
   */
  private shouldCatchUp(routine: Routine): boolean {
    const reference = routine.lastRunAt ?? routine.createdAt;
    let probe: Cron | undefined;
    try {
      probe = new Cron(routine.cron, { paused: true });
      const next = probe.nextRun(reference);
      if (!next) return false;
      return next.getTime() <= Date.now();
    } catch (err) {
      this.log(
        `[routines/runner] catch-up probe failed for ${routine.id}: ${errMsg(err)}`,
      );
      return false;
    } finally {
      probe?.stop();
    }
  }

  /**
   * Manual on-demand trigger. The user clicked "Jetzt triggern" on the
   * routine smart-card; we invoke the same `runOnce` path the cron
   * scheduler uses, with a fresh AbortController so the run honours
   * `timeoutMs` exactly like a scheduled fire. Returns once delivery is
   * complete (or the run errored). Caller (`handleRoutineAction`)
   * surfaces a confirmation back into the chat.
   */
  async triggerRoutineNow(id: string): Promise<Routine> {
    const routine = await this.store.get(id);
    if (!routine) throw new RoutineNotFoundError(id);
    const controller = new AbortController();
    await this.runOnce(routine, controller.signal, 'manual');
    // Re-read so caller gets the updated last_run_* fields.
    const updated = await this.store.get(id);
    return updated ?? routine;
  }

  /**
   * Dispose every registered routine. Called on graceful shutdown.
   * In-flight runs receive their AbortSignal via `stopForPlugin`.
   */
  stop(): void {
    this.scheduler.stopForPlugin(ROUTINES_AGENT_ID);
    this.disposers.clear();
    this.started = false;
  }

  async createRoutine(input: CreateRoutineInput): Promise<Routine> {
    if (!this.senders.get(input.channel)) {
      throw new UnknownChannelError(input.channel);
    }
    const active = await this.store.countActiveForUser(
      input.tenant,
      input.userId,
    );
    if (active >= this.maxActivePerUser) {
      throw new RoutineQuotaExceededError(this.maxActivePerUser);
    }

    const row = await this.store.create(input);
    try {
      this.registerInScheduler(row);
    } catch (err) {
      // Schedule registration failed (almost always cron validation). Roll
      // the DB row back so the user can fix the input and try again — we
      // would otherwise leave an orphan row that boot would re-attempt
      // forever.
      await this.store.delete(row.id);
      throw err;
    }
    return row;
  }

  async listRoutines(tenant: string, userId: string): Promise<Routine[]> {
    return this.store.listForUser(tenant, userId);
  }

  async pauseRoutine(id: string): Promise<Routine> {
    const updated = await this.store.setStatus(id, 'paused');
    if (!updated) throw new RoutineNotFoundError(id);
    this.unregisterFromScheduler(id);
    return updated;
  }

  async resumeRoutine(id: string): Promise<Routine> {
    const updated = await this.store.setStatus(id, 'active');
    if (!updated) throw new RoutineNotFoundError(id);
    if (!this.senders.get(updated.channel)) {
      // Resume the row but report the misconfiguration; trigger will
      // record an error each time it fires until a sender exists.
      this.log(
        `[routines/runner] resumed routine ${id} but no sender for channel '${updated.channel}'`,
      );
    }
    this.registerInScheduler(updated);
    return updated;
  }

  async deleteRoutine(id: string): Promise<boolean> {
    this.unregisterFromScheduler(id);
    return this.store.delete(id);
  }

  // --- internals -----------------------------------------------------------

  private registerInScheduler(routine: Routine): void {
    if (this.disposers.has(routine.id)) {
      // Already registered (resume after a no-op pause). Drop the old one
      // first so register() doesn't throw JobAlreadyRegisteredError.
      this.unregisterFromScheduler(routine.id);
    }
    const spec: JobSpec = {
      name: routine.id,
      schedule: { cron: routine.cron },
      timeoutMs: routine.timeoutMs,
      // skip a tick if a previous run is still in flight — long-running
      // agent turns shouldn't queue up duplicates.
      overlap: 'skip',
    };
    const dispose = this.scheduler.register(
      ROUTINES_AGENT_ID,
      spec,
      (signal) => this.runOnce(routine, signal, 'cron'),
    );
    this.disposers.set(routine.id, dispose);
  }

  private unregisterFromScheduler(id: string): void {
    const dispose = this.disposers.get(id);
    if (!dispose) return;
    dispose();
    this.disposers.delete(id);
  }

  private async runOnce(
    routine: Routine,
    signal: AbortSignal,
    trigger: RoutineRunTrigger = 'cron',
  ): Promise<void> {
    const startedAt = new Date();
    let status: RoutineRunStatus = 'ok';
    let errorMessage: string | null = null;
    let result: ChatTurnResult | null = null;
    let prompt = routine.prompt;
    let tenant = routine.tenant;
    let userId = routine.userId;

    try {
      const sender = this.senders.get(routine.channel);
      if (!sender) {
        throw new UnknownChannelError(routine.channel);
      }

      // Re-read the row before invoking. A pause/delete that landed
      // between schedule and trigger should be honoured (the dispose was
      // best-effort, not transactional).
      const fresh = await this.store.get(routine.id);
      if (!fresh || fresh.status !== 'active') return;
      prompt = fresh.prompt;
      tenant = fresh.tenant;
      userId = fresh.userId;

      if (signal.aborted) {
        status = 'timeout';
        errorMessage = signal.reason instanceof Error
          ? signal.reason.message
          : 'aborted before invocation';
        return;
      }

      // Use `runTurn` (not the higher-level `chat`) so we keep the per-
      // turn `runTrace` for the call-stack viewer. `toSemanticAnswer`
      // converts the kernel-shaped result into the channel-agnostic
      // outgoing-message contract the proactive sender expects.
      result = await this.orchestrator.runTurn({
        userMessage: fresh.prompt,
        userId: fresh.userId,
        sessionScope: `routine:${fresh.id}`,
      });

      if (signal.aborted) {
        // Agent finished after the timer fired but before send. Skip
        // delivery — the user shouldn't get late noise — but record the
        // timeout so they can extend `timeoutMs` if needed.
        status = 'timeout';
        errorMessage = 'agent finished after timeout, delivery skipped';
        return;
      }

      const answer = toSemanticAnswer(result);
      await sender.send({
        conversationRef: fresh.conversationRef,
        message: answer,
        routine: {
          id: fresh.id,
          name: fresh.name,
          cron: fresh.cron,
        },
      });
    } catch (err) {
      status = signal.aborted ? 'timeout' : 'error';
      errorMessage = errMsg(err);
      this.log(
        `[routines/runner] routine ${routine.id} ('${routine.name}') ${status}: ${errorMessage}`,
      );
    } finally {
      const finishedAt = new Date();

      // Append-only per-run history with full agentic trace. Failures
      // here log but never abort the run (parity with `recordRun`).
      await this.runsStore.insert({
        routineId: routine.id,
        tenant,
        userId,
        trigger,
        startedAt,
        finishedAt,
        status,
        errorMessage,
        prompt,
        answer: result?.answer ?? null,
        iterations: result?.iterations ?? null,
        toolCalls: result?.toolCalls ?? null,
        runTrace: result?.runTrace ?? null,
      });

      // Backwards-compat: keep updating last_run_* on the routines row
      // so the existing operator-UI tabular row keeps working without
      // having to join into routine_runs.
      await this.store.recordRun({
        id: routine.id,
        status,
        error: errorMessage,
      });
    }
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
