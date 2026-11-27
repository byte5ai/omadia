import { AsyncResource } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

import type {
  ChatTurnInput,
  ChatTurnResult,
  SemanticAnswer,
  TurnOrigin,
} from '@omadia/channel-sdk';
import { toSemanticAnswer } from '@omadia/channel-sdk';
import { turnContext, today, webAccountOrigin } from '@omadia/orchestrator';
import { meterUsageCost, runInExecutionContext } from '@omadia/usage-telemetry';
import {
  SYSTEM_SPEAKER,
  ToolRefusalError,
  type AgentSpeaker,
  type AnswerEmitter,
  type JobHandler,
  type JobSpec,
} from '@omadia/plugin-api';


import {
  buildSlotDirective,
  collectRequiredSlotIds,
  parseSlotResponse,
} from './narrativeSlotContract.js';
import { isStaticOnlyTemplate, type RoutineOutputTemplate } from './routineOutputTemplate.js';
import { NOTHING_TO_SAY } from '../../triggers/kernelExecutors.js';
import { renderRoutineTemplate } from './routineTemplateRenderer.js';
import { routineTurnContext } from './routineTurnContext.js';
import type { RoutineAgentResolution } from './routineAgentBinding.js';
import { formatInTimeZone, UTC_ZONE } from '../../scheduler/zonedCron.js';
import {
  InFlightRuns,
  RoutineRunCancelledError,
  RoutineRunInProgressError,
  abortMessage,
  abortedStatus,
  effectiveTimeoutMs,
  timeoutSignal,
} from './routineRunControl.js';
import { WEB_ROUTINE_CHANNEL } from './webChatProactiveSender.js';

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
    /** #1743 — the zone the cron pattern is evaluated in (ADR 0240); absent = UTC. */
    opts?: { readonly timeZone?: string },
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
/**
 * #1774 (ADR-0182) — a web routine runs in its owner's one-person room, like
 * the web chat it was created in: its `userId` is the session's canonical
 * omadia id (`httpRoutineContext`). Routines of other channels keep running
 * without an origin; their `userId` is not known to be canonical.
 */
export function routineOrigin(routine: Pick<Routine, 'channel' | 'userId'>): { origin?: TurnOrigin } {
  return routine.channel === WEB_ROUTINE_CHANNEL && routine.userId.length > 0
    ? { origin: webAccountOrigin(routine.userId) }
    : {};
}

export interface OrchestratorLike {
  runTurn(input: ChatTurnInput): Promise<ChatTurnResult>;
  /**
   * #2045 / #2046 — the agent's single typed emitter. A routine's answer is
   * this agent's prose: it is published through the emitter (identity guard,
   * speaker), never straight from the turn. Absent only on the registry-less
   * legacy boot and in tests.
   */
  readonly emitter?: AnswerEmitter;
  /** #2045 — the agent the routine's answers are from. */
  readonly speaker?: AgentSpeaker;
  /**
   * #1763 — present when the agent's tool loop runs outside the kernel (the
   * subscription CLI): the run goes through the agent's own chat agent, like
   * a chat turn on it, instead of `runTurn` on its tool-less in-process
   * orchestrator. Its answer is already published (identity guard, speaker),
   * so the runner does not pass it through the emitter again. The run keeps
   * no run trace on this path; tool calls and iterations stay unknown.
   */
  readonly chat?: (input: ChatTurnInput) => Promise<SemanticAnswer>;
}

/**
 * #2045 / #2046 — a routine's answer as the agent publishes it: its prose
 * passes the agent's emitter; a refused answer becomes the honest `system`
 * notice instead.
 */
export async function publishRoutineAnswer(
  orchestrator: OrchestratorLike,
  result: ChatTurnResult,
): Promise<SemanticAnswer> {
  const answer = toSemanticAnswer(result);
  // #1877 — the turn did not run (`model_unavailable`): the management
  // layer's notice goes out as it is, never stamped as the agent's prose.
  if (result.systemNotice) return answer;
  const { emitter, speaker } = orchestrator;
  if (!emitter || !speaker) return answer;
  const outcome = await emitter.emit({
    type: 'prose',
    speaker,
    text: result.answer,
    ...(answer.maskedValues ? { restoredValues: answer.maskedValues } : {}),
  });
  if (outcome.published) return { ...answer, speaker };
  const notice = outcome.replacement.notice;
  return { text: notice.text, speaker: SYSTEM_SPEAKER, systemNotice: notice };
}
import {
  ProactiveTargetGoneError,
  type ProactiveSenderRegistry,
} from './proactiveSender.js';
import type {
  RoutineRunsStore,
  RoutineRunTrigger,
} from './routineRunsStore.js';
import {
  RoutineNameConflictError,
  type CreateRoutineInput,
  type Routine,
  type RoutineOwner,
  type RoutineRunStatus,
  type RoutineStore,
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

/**
 * #1025 — who is asking for a routine mutation.
 *
 * A discriminated union rather than an optional `owner?` parameter, on
 * purpose: an optional scope is one a caller can forget, and forgetting it
 * is exactly how `pause`/`resume`/`delete` came to accept a bare id from
 * any principal. Here TypeScript makes every call site state which case it
 * is, so a cross-tenant operation is a deliberate, greppable
 * `{ kind: 'operator' }` instead of an omission that reads like an
 * oversight.
 *
 *   - `channel-user` — an end user acting through a channel. Scoped to the
 *     (tenant, userId) the turn context carries (`manage_routine`) or the
 *     smart-card click's `actor` names (`handleRoutineAction`).
 *   - `operator`     — the authenticated operator surface, deliberately
 *     cross-tenant (see the routes' own `requireAuth` rationale). Built by
 *     `routes/routines.ts` only, and never as a fallback for a missing
 *     principal: a door that cannot name one refuses instead
 *     (`RoutineActorRequiredError`). `test/routineOperatorScope.test.ts`
 *     fails if a second producer appears.
 */
export type RoutineActorScope =
  | ({ kind: 'channel-user' } & RoutineOwner)
  | { kind: 'operator' };

/** The store-level owner filter for a scope, or undefined for an operator. */
/**
 * #1907 / ADR-0206 — the outer turn scope of a routine run. Fresh on purpose
 * (see `runTurnWithOptionalCapture`): it carries the routine owner's MCP
 * identity recorded at creation, never the identity of whatever turn happens
 * to be open, and marks the run unattended, so an MCP call starts no OAuth
 * flow and parks no input request nobody can answer.
 */
function routineTurnScope(routine: Routine): {
  turnId: string;
  turnDate: string;
  mcpUnattended: true;
  mcpUserKey?: string;
} {
  return {
    turnId: '',
    turnDate: today(),
    mcpUnattended: true,
    ...(routine.mcpUserKey ? { mcpUserKey: routine.mcpUserKey } : {}),
  };
}

function ownerFilter(scope: RoutineActorScope): RoutineOwner | undefined {
  return scope.kind === 'channel-user'
    ? { tenant: scope.tenant, userId: scope.userId }
    : undefined;
}

/**
 * Whether an already-loaded row is within a scope. Used where the scope
 * cannot be pushed into the SQL because the operation reads first and acts
 * second (`triggerRoutineNow`). Prefer `ownerFilter` and a scoped
 * statement wherever a single statement can do the job.
 */
function ownedBy(routine: Routine, scope: RoutineActorScope): boolean {
  return (
    scope.kind === 'operator' ||
    (routine.tenant === scope.tenant && routine.userId === scope.userId)
  );
}

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

/**
 * #1071 — a manual trigger of a routine that is not active (paused by the
 * user, or auto-paused because its web chat was deleted). Refused instead of
 * run: a run would be skipped anyway, and recording it as `ok` overwrote the
 * `last_run_error` that explains the pause.
 */
/**
 * #2357 (ADR-0324) — a manual run refused by the budget pre-check. A tool
 * refusal, so `manage_routine` passes the reason to the model.
 */
export class RoutineBudgetRefusedError extends ToolRefusalError {
  constructor(
    readonly routineId: string,
    readonly reason: string,
  ) {
    super(`routine ${routineId} cannot run now: ${reason}`);
    this.name = 'RoutineBudgetRefusedError';
  }
}

export class RoutineNotActiveError extends Error {
  constructor(
    id: string,
    public readonly routineName: string,
    public readonly status: string,
  ) {
    super(`routine '${id}' is ${status}; resume it before triggering it`);
    this.name = 'RoutineNotActiveError';
  }
}

export class UnknownChannelError extends Error {
  constructor(channel: string) {
    super(`no proactive sender registered for channel '${channel}'`);
    this.name = 'UnknownChannelError';
  }
}

export class ChatAgentUnavailableError extends Error {
  /** #1744 — `problem` names why no agent may run the routine (its binding);
   *  absent = the agent exists but no chat agent is published (no key). */
  constructor(problem?: string) {
    super(
      problem
        ? `no agent can run this routine: ${problem}`
        : 'chat agent unavailable — configure the LLM API key in Settings to enable routine runs',
    );
    this.name = 'ChatAgentUnavailableError';
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
   * Live resolver for the plugin-published chat agent — production wiring
   * passes a closure over `serviceRegistry.get('chatAgent')?.raw`; tests
   * pass `() => stub`. Resolved per run (never captured) so routines
   * hot-enable the moment the LLM-access-page key save republishes
   * chatAgent@1, and a key rotation swaps instances without a restart.
   * A run that fires while it returns `undefined` records an `error`
   * run via `ChatAgentUnavailableError`. The runner needs `runTurn`
   * (not the higher-level `chat`) so it can persist the per-turn
   * `runTrace` for the call-stack viewer.
   */
  /**
   * #1598 — called with the routine's `agentSlug` (the orchestrator that
   * created it; `null` = the standard orchestrator). The host resolves that
   * orchestrator so the run has exactly its plugin grants; `undefined` when it
   * no longer exists records an `error` run.
   */
  getOrchestrator: (agentSlug: string | null) => OrchestratorLike | undefined;
  senderRegistry: ProactiveSenderRegistry;
  /**
   * Spec 2042 §5.3 — why a routine's delivery may not go out (its ref names a
   * bot that is no longer the routine's agent's own), or undefined. Checked
   * before the agent turn; a refusal pauses the routine like a gone target.
   */
  deliveryRefusal?: (routine: { agentSlug: string | null; channel: string; conversationRef: unknown }) => string | undefined;
  /**
   * #1744 / #1745 — which agent runs a routine (bound by id), or why none
   * may (`routineAgentBinding.ts`). Absent = no binding check (registry-less
   * boot, tests): the slug alone resolves the orchestrator.
   */
  resolveAgent?: (routine: Pick<Routine, 'agentSlug' | 'agentId'>) => RoutineAgentResolution;
  /**
   * #1776 — a manual run's cost goes onto the routine's trigger (the operator
   * trigger view, ADR 0020); a cron run's cost is settled by its firing.
   */
  bookManualRunCost?: (routineId: string, costUsd: number) => Promise<void>;
  /**
   * #2357 (ADR-0324) — why a manual run of this routine may not start for
   * budget reasons (the checks a scheduled firing gets); `undefined` = it
   * may. Absent = no budget check (no trigger engine).
   */
  manualRunRefusal?: (routineId: string) => Promise<string | undefined>;
  /**
   * #1753 — remove the markdown transcripts of a conversation scope
   * (`routine:<id>`) when the routine is deleted. Absent = nothing to remove.
   */
  purgeTranscripts?: (sessionScope: string) => Promise<void>;
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
/**
 * Spec 2042 §5.3 — the routine's conversation runs through a bot that is no
 * longer its agent's own. Its words would appear as another agent's (or
 * through a bot nobody stands behind): never delivered, the routine pauses.
 */
class OwnBotDeliveryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnBotDeliveryRefusedError';
  }
}

// The chat can be gone from the server yet still live in a browser (its first
// PUT failed, or another device deleted it): loading the chat there stores it
// again, and the routine can simply be resumed.
const WEB_CHAT_PAUSE_ADVICE =
  'if the chat still exists in your browser, open it and resume the routine; otherwise delete the routine and create it again from an existing conversation';
const OWN_BOT_PAUSE_ADVICE =
  "resume it once the bot is the agent's own again, or delete it and create it again in a conversation with the agent";

export class RoutineRunner {
  private readonly store: RoutineStore;
  private readonly runsStore: RoutineRunsStore;
  private readonly scheduler: JobSchedulerLike;
  private readonly getOrchestrator: (agentSlug: string | null) => OrchestratorLike | undefined;
  private readonly deliveryRefusal: RoutineRunnerOptions['deliveryRefusal'];
  private readonly resolveAgent: RoutineRunnerOptions['resolveAgent'];
  private readonly bookManualRunCost: RoutineRunnerOptions['bookManualRunCost'];
  private readonly manualRunRefusalOf: RoutineRunnerOptions['manualRunRefusal'];
  private readonly purgeTranscripts: RoutineRunnerOptions['purgeTranscripts'];
  private readonly senders: ProactiveSenderRegistry;
  private readonly log: (msg: string) => void;
  private readonly maxActivePerUser: number;
  /** Map from routine id → dispose fn returned by scheduler.register. */
  private readonly disposers = new Map<string, () => void>();
  /** #1748 — one run per routine in flight, cron and manual alike. */
  private readonly inFlight = new InFlightRuns();
  /**
   * #2339 — runs `fn` in the context the runner was built in (boot, outside
   * any turn), not the caller's. Build the runner outside a turn's
   * AsyncLocalStorage scope, or its runs would inherit that scope.
   */
  private readonly detached = AsyncResource.bind((fn: () => void): void => {
    fn();
  });
  private started = false;

  constructor(opts: RoutineRunnerOptions) {
    this.store = opts.store;
    this.runsStore = opts.runsStore;
    this.scheduler = opts.scheduler;
    this.getOrchestrator = opts.getOrchestrator;
    this.senders = opts.senderRegistry;
    this.deliveryRefusal = opts.deliveryRefusal;
    this.resolveAgent = opts.resolveAgent;
    this.bookManualRunCost = opts.bookManualRunCost;
    this.manualRunRefusalOf = opts.manualRunRefusal;
    this.purgeTranscripts = opts.purgeTranscripts;
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
    for (const row of rows) {
      try {
        this.registerInScheduler(row);
        registered += 1;
      } catch (err) {
        this.log(
          `[routines/runner] failed to register routine ${row.id} ('${row.name}'): ${errMsg(err)}`,
        );
      }
    }
    this.log(
      `[routines/runner] started — ${registered}/${rows.length} routines registered`,
    );
  }

  /**
   * Manual on-demand trigger. The user clicked "Jetzt triggern" on the
   * routine smart-card; we invoke the same `runOnce` path the cron
   * scheduler uses, with a fresh AbortController so the run honours
   * `timeoutMs` exactly like a scheduled fire. Returns once delivery is
   * complete (or the run errored). Caller (`handleRoutineAction`)
   * surfaces a confirmation back into the chat.
   */
  /**
   * #2357 — the budget pre-check of a manual run, for callers that answer
   * before starting it (the trigger route). Throws nothing: a failing check
   * is logged and counts as "may run", as the firing's own reservation is
   * what enforces the caps for scheduled runs.
   */
  async manualRunRefusal(id: string): Promise<string | undefined> {
    if (!this.manualRunRefusalOf) return undefined;
    try {
      return await this.manualRunRefusalOf(id);
    } catch (err) {
      this.log(`[routines] budget pre-check of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async assertManualRunAllowed(id: string): Promise<void> {
    const refusal = await this.manualRunRefusal(id);
    if (refusal !== undefined) throw new RoutineBudgetRefusedError(id, refusal);
  }

  async triggerRoutineNow(
    id: string,
    scope: RoutineActorScope,
  ): Promise<Routine> {
    const routine = await this.store.get(id);
    // #1025 — scoped for the same reason as delete, and with a sharper
    // consequence: a run delivers to the routine's OWN conversationRef, so
    // an unscoped trigger let one principal push messages into another
    // tenant's conversation on demand.
    if (!routine || !ownedBy(routine, scope)) {
      throw new RoutineNotFoundError(id);
    }
    if (routine.status !== 'active') {
      throw new RoutineNotActiveError(id, routine.name, routine.status);
    }
    if (this.inFlight.has(id)) throw new RoutineRunInProgressError(id);
    await this.assertManualRunAllowed(id);
    // #1747 — a manual run gets the same timeout a scheduled one does.
    const timeout = timeoutSignal(effectiveTimeoutMs(routine.timeoutMs));
    try {
      await this.runOnce(routine, timeout.signal, 'manual');
    } finally {
      timeout.clear();
    }
    // Re-read so caller gets the updated last_run_* fields.
    const updated = await this.store.get(id);
    return updated ?? routine;
  }

  /**
   * #2339 — `manage_routine` `run_now`: the trigger route's checks, answered
   * at once (not found or not owned, not active, already running, agent
   * gone, no chat agent), then the run starts in the background like the
   * route's. Returns the routine the run was started for.
   */
  async startManualRun(id: string, scope: RoutineActorScope): Promise<Routine> {
    const routine = await this.store.get(id);
    if (!routine || !ownedBy(routine, scope)) throw new RoutineNotFoundError(id);
    if (routine.status !== 'active') throw new RoutineNotActiveError(id, routine.name, routine.status);
    const agentProblem = this.agentProblemOf(routine);
    if (agentProblem !== undefined) throw new ToolRefusalError(agentProblem);
    if (!this.chatAgentAvailable(routine.agentSlug ?? null)) {
      throw new ToolRefusalError('no chat agent can run this routine right now (its orchestrator is gone or no LLM key is configured)');
    }
    await this.assertManualRunAllowed(id);
    // The run's slot is taken here, before answering: a second run_now (a
    // parallel tool call) or a cron fire in between is refused or skipped,
    // never told "started" for a run that then does not happen.
    const own = this.inFlight.acquire(id);
    if (!own) throw new RoutineRunInProgressError(id);
    // Outside the calling turn: the run is its own unattended turn (ADR
    // 0242), as a cron fire or the trigger route's run is, and must not
    // inherit the asking turn's context.
    this.detached(() => {
      const timeout = timeoutSignal(effectiveTimeoutMs(routine.timeoutMs));
      void this.runOnce(routine, timeout.signal, 'manual', own)
        .catch((err: unknown) => {
          this.log(`[routines] run_now of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          timeout.clear();
        });
    });
    return routine;
  }

  /**
   * Lightweight existence check for the fire-and-forget trigger endpoint.
   * Returns the routine row if it exists, `null` otherwise. Caller uses
   * the result to decide between 404 and 202 BEFORE kicking off the
   * background run via `triggerRoutineNow`.
   */
  async peekRoutine(id: string): Promise<Routine | null> {
    const row = await this.store.get(id);
    return row ?? null;
  }

  /** #1748 — whether a run of the routine is in flight in this process. */
  isRunning(id: string): boolean {
    return this.inFlight.has(id);
  }

  /**
   * Whether a chat agent currently resolves. The trigger endpoint checks
   * this to return a synchronous 503 instead of accepting a manual run
   * that is guaranteed to record `error` — cron fires still go through
   * `runOnce` and record the failure, keeping the misconfiguration
   * visible in run history.
   */
  chatAgentAvailable(agentSlug: string | null = null): boolean {
    // #1598 — asked for the routine's OWN orchestrator, the one its run uses.
    return this.getOrchestrator(agentSlug) !== undefined;
  }

  /** #1744 — why no agent may run the routine, or undefined when its agent can. */
  agentProblemOf(routine: Pick<Routine, 'agentSlug' | 'agentId'>): string | undefined {
    const bound = this.resolveAgent?.(routine);
    return bound && !bound.ok ? bound.problem : undefined;
  }

  /** #1757 — the active routines that deliver into a web chat (for the close confirmation). */
  async routinesOfWebChat(sessionId: string): Promise<Routine[]> {
    return this.store.listActiveForWebChat(sessionId);
  }

  /**
   * #1757 — the web chat is deleted: its routines are paused with `message`
   * now, instead of each failing its next delivery pre-check first. Returns
   * the ids of the routines it paused (#2318: they go into the audit row).
   */
  async pauseRoutinesOfWebChat(sessionId: string, message: string): Promise<string[]> {
    const paused: string[] = [];
    for (const r of await this.store.listActiveForWebChat(sessionId)) {
      if (!(await this.store.markExpired(r.id, message))) continue;
      this.unregisterFromScheduler(r.id);
      this.inFlight.cancel(r.id, 'paused');
      paused.push(r.id);
    }
    return paused;
  }

  /** #1765 — how many routines a user owns (any status), for the delete confirmation. */
  async countRoutinesOfUser(userId: string): Promise<number> {
    return (await this.store.listIdsForUserId(userId)).length;
  }

  /**
   * #1765 — the user's account is deleted: their routines go with it (the
   * system acting, so unscoped), their triggers end and a run in flight is
   * cancelled. Returns how many were deleted.
   */
  async deleteRoutinesOfUser(userId: string): Promise<number> {
    let deleted = 0;
    for (const id of await this.store.listIdsForUserId(userId)) {
      if (!(await this.store.delete(id))) continue;
      this.unregisterFromScheduler(id);
      this.inFlight.cancel(id, 'deleted');
      await this.removeTranscripts(id);
      deleted += 1;
    }
    return deleted;
  }

  /**
   * #1744 — the agent ended service (disabled or deleted): its active
   * routines are paused with `message` (the owner reads it on the routine),
   * unregistered, and a run in flight is cancelled. Returns how many.
   */
  async pauseRoutinesOfAgent(agent: { readonly id: string; readonly slug: string }, message: string): Promise<number> {
    const ids = await this.store.pauseForAgent(agent.id, agent.slug, message);
    for (const id of ids) {
      this.unregisterFromScheduler(id);
      this.inFlight.cancel(id, 'paused');
    }
    return ids.length;
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
    const sender = this.senders.get(input.channel);
    if (!sender) {
      throw new UnknownChannelError(input.channel);
    }
    // #1071 — refuse a routine whose delivery handle the channel can never
    // deliver to (e.g. a web routine requested outside a saved chat) now,
    // rather than recording the same error on every cron fire.
    sender.validateConversationRef?.(input.conversationRef ?? {});

    // Issue #506: check for a reconcile-eligible retry BEFORE the quota
    // gate. A retried `createRoutine` call for a routine that already
    // exists and is already active doesn't need a fresh slot — it needs
    // nothing at all, because the work is already done. Without this
    // proactive check, a user sitting exactly at `maxActivePerUser` whose
    // confirmation got dropped (the scenario issue #506 targets) would
    // have their retry rejected by the quota check below before it ever
    // reaches the `RoutineNameConflictError` reconciliation in the
    // `store.create()` catch block, surfacing a different but equally
    // wrong "you're at capacity" error instead of the routine they already
    // created. The `catch` block's reconciliation stays as-is: it remains
    // the necessary race-safety net for a concurrent request that creates
    // the matching row between this lookup and the `store.create()` call
    // below.
    const existing = await this.store.getByName(
      input.tenant,
      input.userId,
      input.name,
    );
    if (
      existing &&
      existing.status === 'active' &&
      isSameRoutineRequest(existing, input)
    ) {
      return existing;
    }

    const active = await this.store.countActiveForUser(
      input.tenant,
      input.userId,
    );
    if (active >= this.maxActivePerUser) {
      throw new RoutineQuotaExceededError(this.maxActivePerUser);
    }

    // #1745 — bound to the agent that creates it, by id.
    const creator = input.agentSlug ? this.resolveAgent?.({ agentSlug: input.agentSlug, agentId: null }) : undefined;
    const bound = creator?.ok && creator.agent.id ? { ...input, agentId: creator.agent.id } : input;

    let row: Routine;
    try {
      row = await this.store.create(bound);
    } catch (err) {
      // Issue #506: a retried `create` for the same (tenant, user, name) —
      // e.g. the model or user retrying after the turn's own confirmation
      // never made it back over the channel — hits the unique-name
      // constraint here rather than actually duplicating anything. Rather
      // than reporting that retry as a failure (which the caller can only
      // read as "try again", pushing toward a real duplicate under a
      // different name), reconcile: if the existing row is the same
      // request, treat this call as already-succeeded and return it. A
      // conflicting row with different cron/prompt/channel is a genuine
      // name collision and still surfaces as an error. We deliberately do
      // NOT additionally gate on `existing.createdAt` recency: the
      // `status === 'active'` check below plus the field-by-field
      // comparison in `isSameRoutineRequest` already narrow this to "an
      // active routine with byte-for-byte identical cron/prompt/channel/
      // timeout" — a false-positive reconciliation on an old-but-still-
      // active routine is the caller re-issuing an identical create, which
      // is the same "already succeeded" case regardless of age. Adding a
      // time window would only reintroduce a class of false negatives
      // (rejecting a legitimate late retry) without closing any real gap.
      if (err instanceof RoutineNameConflictError) {
        const existing = await this.store.getByName(
          input.tenant,
          input.userId,
          input.name,
        );
        // Only reconcile against an `active` row. A paused/inactive row
        // with matching fields is not "my own in-flight retry" — it's a
        // genuine, separate collision (e.g. the user paused an earlier
        // "demo" routine and is now deliberately creating a new one under
        // the same name). Reconciling there would silently hand back a
        // routine that has no active schedule, which is a worse version of
        // the exact false-negative/false-positive problem issue #506 was
        // filed to fix. Only an `active` existing row can plausibly be
        // "the create that already succeeded", so only that case skips the
        // error.
        if (
          existing &&
          existing.status === 'active' &&
          isSameRoutineRequest(existing, input)
        ) {
          return existing;
        }
      }
      throw err;
    }

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

  async pauseRoutine(id: string, scope: RoutineActorScope): Promise<Routine> {
    const updated = await this.store.setStatus(
      id,
      'paused',
      ownerFilter(scope),
    );
    // A scoped miss and a genuinely missing id both land here, and both
    // raise the same error: telling a caller "exists, but not yours" would
    // confirm the id.
    if (!updated) throw new RoutineNotFoundError(id);
    this.unregisterFromScheduler(id);
    // #1746 — a run in flight stops at its next step and delivers nothing.
    this.inFlight.cancel(id, 'paused');
    return updated;
  }

  async resumeRoutine(id: string, scope: RoutineActorScope): Promise<Routine> {
    // #1746 — resuming a routine that is already active and armed changes
    // nothing: re-registering would settle and re-create its trigger under a
    // run that is in flight.
    const before = await this.store.get(id);
    const alreadyRunning = before?.status === 'active' && this.disposers.has(id);
    let updated = await this.store.setStatus(
      id,
      'active',
      ownerFilter(scope),
    );
    if (!updated) throw new RoutineNotFoundError(id);
    if (alreadyRunning && !(updated.until && updated.until.getTime() <= Date.now())) return updated;
    // #2082 — resuming a routine past its deadline is its owner's choice to
    // go on: a new period starts when it is scheduled.
    if (updated.until && updated.until.getTime() <= Date.now()) {
      updated = (await this.store.setUntil(id, null)) ?? updated;
    }
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

  /**
   * #2082 — the owner wants the routine to go on: a new deadline period
   * starts (and the renewal question will be asked again before it ends).
   * A paused routine stays paused; an active one is rescheduled.
   */
  async renewRoutine(id: string, scope: RoutineActorScope): Promise<Routine> {
    const owned = await this.store.get(id);
    if (!owned || (scope.kind === 'channel-user' && (owned.tenant !== scope.tenant || owned.userId !== scope.userId))) {
      throw new RoutineNotFoundError(id);
    }
    const renewed = (await this.store.setUntil(id, null)) ?? owned;
    if (renewed.status === 'active') this.registerInScheduler(renewed);
    return renewed;
  }

  /**
   * #1025 — the scheduler is unregistered only AFTER the scoped delete
   * reports a row was actually removed. The previous order unregistered
   * first, so a cross-tenant id silently disarmed someone else's cron
   * while the row survived: the routine then looked active in `list` and
   * never fired again, which is harder to notice than a deleted row.
   */
  async deleteRoutine(id: string, scope: RoutineActorScope): Promise<boolean> {
    const deleted = await this.store.delete(id, ownerFilter(scope));
    if (deleted) {
      this.unregisterFromScheduler(id);
      // #1746 — the run in flight stops spending; its history row goes with
      // the routine (`routine_runs` cascades), like the rest of its history.
      this.inFlight.cancel(id, 'deleted');
      await this.removeTranscripts(id);
    }
    return deleted;
  }

  /**
   * Persist a materialised conversation reference onto a routine after a
   * channel sender resolved a cold-start delivery target into a live
   * conversation. Best-effort: the JobScheduler is not touched (the
   * delivery handle has no bearing on cron firing) and a missing id is a
   * silent no-op — the routine simply re-resolves on its next run.
   */
  async updateConversationRef(
    id: string,
    conversationRef: unknown,
  ): Promise<void> {
    const updated = await this.store.updateConversationRef(id, conversationRef);
    if (!updated) {
      this.log(
        `[routines/runner] updateConversationRef: routine ${id} not found (cold-start ref not persisted)`,
      );
    }
  }

  // --- internals -----------------------------------------------------------

  /** #1753 — a deleted routine's transcripts go with it; a failure is logged. */
  private async removeTranscripts(id: string): Promise<void> {
    await this.purgeTranscripts?.(`routine:${id}`).catch((err: unknown) => {
      this.log(`[routines/runner] removing the transcripts of routine ${id} failed: ${errMsg(err)}`);
    });
  }

  private registerInScheduler(routine: Routine): void {
    if (this.disposers.has(routine.id)) {
      // Already registered (resume after a no-op pause). Drop the old one
      // first so register() doesn't throw JobAlreadyRegisteredError.
      this.unregisterFromScheduler(routine.id);
    }
    const spec: JobSpec = {
      name: routine.id,
      schedule: { cron: routine.cron },
      timeoutMs: effectiveTimeoutMs(routine.timeoutMs),
      // skip a tick if a previous run is still in flight — long-running
      // agent turns shouldn't queue up duplicates.
      overlap: 'skip',
    };
    const dispose = this.scheduler.register(
      ROUTINES_AGENT_ID,
      spec,
      (signal) => this.runOnce(routine, signal, 'cron'),
      routine.timezone ? { timeZone: routine.timezone } : {},
    );
    this.disposers.set(routine.id, dispose);
  }

  private unregisterFromScheduler(id: string): void {
    const dispose = this.disposers.get(id);
    if (!dispose) return;
    dispose();
    this.disposers.delete(id);
  }

  /**
   * #1748 — one run per routine at a time. A cron firing while a run is in
   * flight is skipped (the trigger's at-most-once occurrence is spent, no
   * second turn is paid for); a manual one is refused before it gets here.
   */
  private async runOnce(
    routine: Routine,
    signal: AbortSignal,
    trigger: RoutineRunTrigger = 'cron',
    /** #2339 — a slot the caller already took (`startManualRun`). */
    held?: AbortController,
  ): Promise<void> {
    const own = held ?? this.inFlight.acquire(routine.id);
    if (!own) {
      if (trigger === 'manual') throw new RoutineRunInProgressError(routine.id);
      this.log(`[routines/runner] routine ${routine.id} ('${routine.name}') still running; ${trigger} firing skipped`);
      return;
    }
    try {
      await this.runLocked(routine, AbortSignal.any([signal, own.signal]), trigger);
    } finally {
      this.inFlight.release(routine.id, own);
    }
  }

  private async runLocked(
    routine: Routine,
    signal: AbortSignal,
    trigger: RoutineRunTrigger,
  ): Promise<void> {
    const startedAt = new Date();
    let status: RoutineRunStatus = 'ok';
    let errorMessage: string | null = null;
    let result: ChatTurnResult | null = null;
    let cardBody: readonly unknown[] | undefined;
    let prompt = routine.prompt;
    let tenant = routine.tenant;
    let userId = routine.userId;
    // #1071 — a fire on a routine that is no longer active is SKIPPED, not
    // run: nothing is recorded. Recording it as `ok` overwrote the
    // `last_run_error` that explains an auto-pause (deleted web chat).
    let skipped = false;
    // #1763 — a run through the agent's chat agent reports no tool calls or
    // iterations; they are recorded as unknown, not as zero.
    let countsKnown = true;
    // #1776 — what this run cost (the turn and the emitter's guard).
    let costUsd: number | null = null;

    try {
      // Re-read the row before invoking. A pause/delete that landed
      // between schedule and trigger should be honoured (the dispose was
      // best-effort, not transactional). Checked first so a raced fire on
      // a paused row never records a spurious availability error.
      const fresh = await this.store.get(routine.id);
      if (!fresh || fresh.status !== 'active') {
        skipped = true;
        return;
      }
      prompt = fresh.prompt;
      tenant = fresh.tenant;
      userId = fresh.userId;

      // Resolve the chat agent per fire (issue #473) and BEFORE the
      // sender lookup: pre-key, the channel plugins (which require
      // chatAgent@^1) are dark too, so a sender-first check would record
      // the misleading 'no proactive sender' error when the actual fix
      // is configuring the key.
      // #1744 / #1745 — the agent the routine is bound to, by id; never one
      // that took over its slug, never the instance default.
      const bound = this.resolveAgent?.(fresh);
      if (bound && !bound.ok) throw new ChatAgentUnavailableError(bound.problem);
      if (bound?.ok && !fresh.agentId && bound.agent.id) {
        await this.store.bindAgentId(fresh.id, bound.agent.id).catch((err: unknown) => {
          this.log(`[routines/runner] binding routine ${fresh.id} to agent ${bound.agent.id} failed: ${errMsg(err)}`);
        });
      }
      const orchestrator = this.getOrchestrator(fresh.agentSlug ?? null);
      if (!orchestrator) {
        throw new ChatAgentUnavailableError();
      }

      const sender = this.senders.get(routine.channel);
      if (!sender) {
        throw new UnknownChannelError(routine.channel);
      }
      // #1071 — a delivery target that no longer exists (a deleted web
      // chat) fails here, BEFORE the agent turn: otherwise every cron fire
      // would run a full turn whose output nobody can receive.
      await sender.checkDeliverable?.(fresh.conversationRef);
      const refused = this.deliveryRefusal?.({
        agentSlug: fresh.agentSlug ?? null,
        channel: fresh.channel,
        conversationRef: fresh.conversationRef,
      });
      if (refused) throw new OwnBotDeliveryRefusedError(refused);

      if (signal.aborted) {
        status = abortedStatus(signal);
        errorMessage = abortMessage(signal, 'aborted before invocation');
        return;
      }

      // Spec 2042 §5.10 — the run (its security screener before the turn
      // scope, the turn, the emitter's guard) is the turn of the agent that
      // actually runs it, scheduled or "run now", whatever context the
      // caller had: charged to that agent and stopped by its kill switch.
      const slug = orchestrator.speaker?.slug;
      const asAgentTurn = <T>(work: () => Promise<T>): Promise<T> =>
        slug ? runInExecutionContext({ kind: 'agent_turn', ownerId: slug, agentSlug: slug }, work) : work();
      // A turn that throws still spent what it spent: measured around the catch.
      const metered = await meterUsageCost(async () => {
        try {
          return { turn: await asAgentTurn(() => this.runTurnWithOptionalCapture(fresh, orchestrator, signal)) };
        } catch (err) {
          return { failed: err };
        }
      });
      costUsd = metered.costUsd;
      if ('failed' in metered.value) throw metered.value.failed;
      const turn = metered.value.turn;
      result = turn.result;
      cardBody = turn.cardBody;
      countsKnown = turn.viaChatAgent !== true && turn.published === undefined;
      // #1761 — delivered, but the template could not show everything.
      if (turn.warnings && turn.warnings.length > 0) {
        errorMessage = `template: ${turn.warnings.join('; ')}`;
      }

      if (signal.aborted) {
        // Agent finished after the timer fired (or the routine was paused or
        // deleted) but before send. Skip delivery — the user shouldn't get
        // late noise — and record why.
        status = abortedStatus(signal);
        errorMessage = status === 'timeout'
          ? 'agent finished after timeout, delivery skipped'
          : abortMessage(signal, 'run cancelled, delivery skipped');
        return;
      }
      // #1760 — nothing worth telling: a successful run without a delivery.
      if (turn.silent) {
        status = 'silent';
        return;
      }
      // #1746 — the routine may have been paused or deleted on another
      // instance (or by the harness) while the turn ran: read it once more.
      const current = await this.store.get(routine.id);
      if (!current || current.status !== 'active') {
        status = 'cancelled';
        errorMessage = new RoutineRunCancelledError(current ? 'paused' : 'deleted').message;
        return;
      }

      // #1766 — an empty answer is checked on the model's own text, before
      // the AI disclosure is folded in: a disclosure line alone is not an answer.
      if (!turn.published && result.answer.trim() === '' && !cardBody) {
        throw new Error('routine produced an empty answer; nothing was delivered');
      }
      const finished = result;
      const published = turn.published
        ? { value: turn.published, costUsd: 0 }
        : await meterUsageCost(() => asAgentTurn(() => publishRoutineAnswer(orchestrator, finished)));
      costUsd += published.costUsd;
      const answer = published.value;
      // A withheld answer is a notice: the template's card must not go out
      // beside it (it carries the very data the notice withholds).
      if (isWithheld(answer)) cardBody = undefined;
      await sender.send({
        conversationRef: fresh.conversationRef,
        message: answer,
        routine: {
          id: fresh.id,
          name: fresh.name,
          cron: fresh.cron,
        },
        ...(cardBody ? { cardBody } : {}),
      });
    } catch (err) {
      status = signal.aborted ? abortedStatus(signal) : 'error';
      errorMessage = signal.aborted ? abortMessage(signal, errMsg(err)) : errMsg(err);
      if (err instanceof ProactiveTargetGoneError) {
        errorMessage = await this.pauseOrphanedRoutine(routine.id, errorMessage);
      } else if (err instanceof OwnBotDeliveryRefusedError) {
        errorMessage = await this.pauseOrphanedRoutine(routine.id, errorMessage, OWN_BOT_PAUSE_ADVICE);
      }
      this.log(
        `[routines/runner] routine ${routine.id} ('${routine.name}') ${status}: ${errorMessage}`,
      );
    } finally {
      // #1746 — a routine deleted mid-run took its history with it; there is
      // no row left to attach this run to.
      const deleted = signal.reason instanceof RoutineRunCancelledError && signal.reason.cancelCause === 'deleted';
      if (deleted) {
        this.log(`[routines/runner] routine ${routine.id} ('${routine.name}') was deleted during the run; no run row written`);
      }
      if (!skipped && !deleted) {
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
          iterations: countsKnown ? (result?.iterations ?? null) : null,
          toolCalls: countsKnown ? (result?.toolCalls ?? null) : null,
          runTrace: result?.runTrace ?? null,
          costUsd,
        });
        if (trigger === 'manual' && costUsd !== null && costUsd > 0) {
          await this.bookManualRunCost?.(routine.id, costUsd).catch((err: unknown) => {
            this.log(`[routines/runner] booking the manual run cost of ${routine.id} failed: ${errMsg(err)}`);
          });
        }

        // Backwards-compat: keep updating last_run_* on the routines row
        // so the existing operator-UI tabular row keeps working without
        // having to join into routine_runs. Not for a cancelled run: whoever
        // paused the routine wrote why on the row (an agent that ended
        // service, the owner), and the run's own note must not replace it.
        if (status !== 'cancelled') {
          await this.store.recordRun({
            id: routine.id,
            status,
            error: errorMessage,
          });
        }
      }
    }
  }

  /**
   * #1071 — the routine's delivery target is gone for good. Pause it (the
   * system acting, so unscoped) and unregister its cron, so later fires do
   * not each record the same failure. Returns the error to record, which
   * says the routine was paused. A failed pause is logged, never thrown:
   * the run is still recorded, and the next fire's pre-flight tries again.
   */
  private async pauseOrphanedRoutine(id: string, reason: string, advice = WEB_CHAT_PAUSE_ADVICE): Promise<string> {
    try {
      const paused = await this.store.setStatus(id, 'paused');
      if (!paused) return reason;
      this.unregisterFromScheduler(id);
      return `${reason}; the routine was paused — ${advice}`;
    } catch (err) {
      this.log(`[routines/runner] could not pause orphaned routine ${id}: ${errMsg(err)}`);
      return reason;
    }
  }

  /**
   * Phase C.2 / C.5 — Run a routine turn, branching on whether the row
   * carries an `output_template`.
   *
   * **Non-templated** (`outputTemplate === null`): plain `orchestrator.runTurn`
   * with the routine prompt verbatim. Byte-identical pre-C.2 behaviour.
   *
   * **Templated** (`outputTemplate !== null`): server-side template
   * pipeline.
   *
   *   1. Augment the routine prompt with `buildSlotDirective(template)` so
   *      the LLM is contracted to emit a JSON `{slots:{…}}` response
   *      instead of free-form markdown (C.3).
   *   2. Install a `Map<toolName, unknown>` raw-tool-result capture in
   *      both `routineTurnContext` and the orchestrator's `turnContext`,
   *      so every tool dispatched during the turn stashes its
   *      pre-tokenisation result into the map (C.2).
   *   3. After `runTurn` resolves, parse the LLM's textual answer as a
   *      slot response (C.3) and render the final markdown by composing
   *      the template's data sections from the captured raw results +
   *      the LLM's narrative slots (C.4).
   *   4. Replace `result.answer` with the rendered markdown. The
   *      orchestrator's privacy pipeline already operated on the slot
   *      JSON — restored tokens land in slot values for narrative
   *      sections, while data sections come from the raw, never-
   *      tokenised tool output. Privacy property: real PII for data
   *      sections never reached the public LLM.
   *
   * Slot-parse failure mode: fall back to empty slots and render the
   * template anyway. Data sections + static-markdown still ship; the
   * narrative chrome is lost for the day. Diagnosed in stdout for the
   * operator until S-7.5 (receipt persistence) lands. We prefer this
   * over swapping in an error placeholder because routines fire on a
   * cron and the user cannot easily retry — a partial output is more
   * useful than a "today's run failed" placeholder.
   *
   * Last-write-wins on the map: if the same tool fires multiple times
   * in a turn (rare for routines; possible if a sub-agent recalls the
   * same tool), only the latest raw result is stashed. Matches the
   * design's `Map<toolName, unknown>` shape and template contract
   * (`sourceTool: string`).
   */
  private async runTurnWithOptionalCapture(
    routine: Routine,
    // The instance `runOnce` resolved for this fire — passed down (not
    // re-resolved) so one run never straddles two orchestrator instances
    // across a mid-run key rotation.
    orchestrator: OrchestratorLike,
    // #1747 — reaches the turn through `turnContext.abortSignal`, so a
    // timeout, pause or delete stops the tool loop at its next iteration.
    signal: AbortSignal,
  ): Promise<RoutineTurn> {
    const input = (userMessage: string): ChatTurnInput => ({
      userMessage,
      userId: routine.userId,
      sessionScope: `routine:${routine.id}`,
      // #1774 / ADR 0182 — a web routine runs in its owner's one-person room.
      ...routineOrigin(routine),
      // #1770 / #1771 / ADR 0242 — nobody is present: no interactive tools,
      // no earlier runs as trusted context; the run knows its time and zone.
      unattended: true,
      extraSystemHint: routineRunHint(routine, new Date()),
    });
    if (routine.outputTemplate !== null && isStaticOnlyTemplate(routine.outputTemplate)) {
      // #1760 — nothing for a model to do: deliver the text, skip the paid turn.
      return this.composeTemplatedAnswer(routine, routine.outputTemplate, new Map(), {
        answer: '',
        toolCalls: 0,
        iterations: 0,
      });
    }
    if (routine.outputTemplate === null) {
      // The scope is deliberate, and it must match the templated branch below.
      // `orchestrator.runTurn` reads `turnContext.current()` as its parent and
      // inherits `mcpUserKey` from it. Without a fresh scope here, a routine
      // fired while an ambient turn is open would run under the INVOKING user's
      // MCP identity rather than its own owner's (`routine.userId`) — and the
      // templated branch, which does open one, would behave differently for the
      // same routine. Same routine, same owner, two identities, decided by
      // whether an output template happens to be configured.
      const plain = await routineTurnContext.outside(() =>
        turnContext.run(
          { ...routineTurnScope(routine), abortSignal: signal },
          () => runAgentTurn(orchestrator, input(routine.prompt)),
        ),
      );
      return isNothingToSay(plain.result.answer) ? { ...plain, silent: true } : plain;
    }

    const template = routine.outputTemplate;
    const directive = buildSlotDirective(template);
    const augmentedPrompt =
      directive.length > 0 ? `${routine.prompt}\n${directive}` : routine.prompt;

    const rawToolResults = new Map<string, unknown>();
    const captureRawToolResult = (
      toolName: string,
      rawResult: string,
    ): void => {
      rawToolResults.set(toolName, rawResult);
    };

    const llmTurn = await routineTurnContext.outside(() => routineTurnContext.withRawToolResults(
      rawToolResults,
      () =>
        turnContext.run(
          {
            // Placeholder turnId/turnDate — `orchestrator.runTurn`
            // builds its own child scope; it inherits our
            // `captureRawToolResult` callback (parent ALS forwarding,
            // analogous to `chatParticipants` + `privacyHandle`).
            ...routineTurnScope(routine),
            captureRawToolResult,
            abortSignal: signal,
          },
          () => runAgentTurn(orchestrator, input(augmentedPrompt)),
        ),
    ));

    if (isNothingToSay(llmTurn.result.answer)) return { ...llmTurn, silent: true };
    const composed = this.composeTemplatedAnswer(
      routine,
      template,
      rawToolResults,
      llmTurn.result,
    );
    if (!llmTurn.published) return composed;
    // The chat-agent path (#1763) published the model's slot JSON. Withheld
    // there (identity guard, discretion): the notice goes out as it is, never
    // the rendered template or its card. Otherwise the rendered template is
    // what goes out, and it passes the emitter like on the in-process path.
    if (isWithheld(llmTurn.published)) {
      return { result: llmTurn.result, published: llmTurn.published, viaChatAgent: true };
    }
    return { ...composed, viaChatAgent: true };
  }

  /**
   * Phase C.5 / C.6 — Combine the LLM's narrative-slot response with
   * the captured raw tool data and the template to produce the final
   * user-facing answer.
   *
   * `llmResult` is what `runTurn` returned (privacy pipeline already
   * applied). On parse failure we ship the template with empty slots —
   * see `runTurnWithOptionalCapture` for the rationale.
   *
   * For `format: 'markdown'` templates (C.5), the rendered text becomes
   * the new `result.answer` and `cardBody` stays undefined.
   *
   * For `format: 'adaptive-card'` templates (C.6), the renderer also
   * runs a second pass with `format: 'markdown'` so non-card channels
   * (plain text fallback) still receive a useful text body; the
   * Adaptive Card body items are returned separately via `cardBody`
   * for channels that can render them.
   *
   * Renderer failure (defence-in-depth — schema already rejects
   * unsupported formats upfront) leaves `llmResult` untouched and
   * cardBody undefined.
   */
  private composeTemplatedAnswer(
    routine: Routine,
    template: RoutineOutputTemplate,
    rawToolResults: ReadonlyMap<string, unknown>,
    llmResult: ChatTurnResult,
  ): RoutineTurn {
    const warnings: string[] = [];
    const required = collectRequiredSlotIds(template);
    const parsed = required.length > 0 ? parseSlotResponse(llmResult.answer, template) : undefined;
    let slots: Readonly<Record<string, string>>;
    if (!parsed || parsed.ok) {
      slots = parsed?.ok ? parsed.value.slots : emptySlotsFor(template);
    } else {
      this.log(
        `[routines/runner] routine ${routine.id} ('${routine.name}') slot-parse failed: ${parsed.reason} — keeping the slots it did write`,
      );
      // #1760 — like the preview: a slot the model did not write renders
      // empty, the ones it wrote stay.
      slots = { ...emptySlotsFor(template), ...salvageSlots(llmResult.answer) };
      warnings.push(`the model's slot response was incomplete (${parsed.reason}); missing slots are empty`);
    }
    const rendered = renderRoutineTemplate({
      template,
      rawToolResults,
      slots,
    });
    if (!rendered.ok) {
      this.log(
        `[routines/runner] routine ${routine.id} ('${routine.name}') template render failed: ${rendered.reason} — sending LLM answer verbatim`,
      );
      return { result: llmResult, warnings: [`the template could not be rendered (${rendered.reason}); the model's answer was sent instead`] };
    }
    warnings.push(...rendered.warnings);
    const withWarnings = warnings.length > 0 ? { warnings } : {};
    if (rendered.format === 'markdown') {
      return { result: { ...llmResult, answer: rendered.text }, ...withWarnings };
    }
    // adaptive-card: produce a markdown fallback so non-card channels
    // still receive a readable `text` body, and side-channel the items
    // via cardBody for channels that can render Adaptive Cards.
    const markdownFallback = renderRoutineTemplate({
      template: { ...template, format: 'markdown' },
      rawToolResults,
      slots,
    });
    const fallbackText =
      markdownFallback.ok && markdownFallback.format === 'markdown'
        ? markdownFallback.text
        : llmResult.answer;
    return {
      result: { ...llmResult, answer: fallbackText },
      cardBody: rendered.items,
      ...withWarnings,
    };
  }
}

/**
 * #1743 / #1770 — what a routine run is told about itself: that it is a
 * scheduled run and the current time in the routine's zone (the turn context
 * carries only the date). Kernel-written, no user text.
 */
export function routineRunHint(routine: Pick<Routine, 'timezone'>, now: Date): string {
  const zone = routine.timezone ?? UTC_ZONE;
  return (
    `This is a scheduled run of a routine. Current time: ${formatInTimeZone(now, zone)}. ` +
    `If the routine asks to report only under a condition and it is not met, answer exactly ${NOTHING_TO_SAY} and nothing is sent.`
  );
}

/** What one routine turn produced. */
interface RoutineTurn {
  readonly result: ChatTurnResult;
  readonly cardBody?: readonly unknown[];
  /**
   * #1763 — the answer as the agent's chat agent already published it; set
   * only on that path, where the runner must not publish it again.
   */
  readonly published?: SemanticAnswer;
  /** #1763 — the turn ran through the agent's chat agent (no run trace or counts). */
  readonly viaChatAgent?: boolean;
  /** #1760 — the agent answered that nothing is worth telling: no delivery. */
  readonly silent?: boolean;
  /** #1761 — template problems recorded on the run (delivered anyway). */
  readonly warnings?: readonly string[];
}

/** #1760 — the agent's "nothing worth telling" answer (ADR 0020 triggers). */
function isNothingToSay(answer: string): boolean {
  return answer.trim().startsWith(NOTHING_TO_SAY);
}

/** #1760 — the string slots a model wrote, from a response that failed the strict parse. */
function salvageSlots(answer: string): Record<string, string> {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as { slots?: unknown };
    if (typeof parsed.slots !== 'object' || parsed.slots === null) return {};
    return Object.fromEntries(
      Object.entries(parsed.slots as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** The emitter replaced the agent's answer with a `system` notice. */
function isWithheld(answer: SemanticAnswer): boolean {
  return answer.systemNotice !== undefined || answer.speaker?.kind === 'system';
}

/**
 * #1763 — the agent's full turn: its chat agent where the tool loop runs
 * outside the kernel (subscription CLI), else `runTurn` on its orchestrator,
 * which keeps the run trace.
 */
async function runAgentTurn(orchestrator: OrchestratorLike, input: ChatTurnInput): Promise<RoutineTurn> {
  if (!orchestrator.chat) return { result: await orchestrator.runTurn(input) };
  const published = await orchestrator.chat(input);
  return {
    result: { answer: published.text, toolCalls: 0, iterations: 0 },
    published,
  };
}

/**
 * Build a `slots` map keyed by every required slot id in the template,
 * with empty-string values. Used as the parse-failure fallback so the
 * renderer can still emit data sections + static-markdown even when the
 * LLM did not produce a usable JSON response.
 */
function emptySlotsFor(
  template: RoutineOutputTemplate,
): Readonly<Record<string, string>> {
  const slots: Record<string, string> = {};
  for (const id of collectRequiredSlotIds(template)) {
    slots[id] = '';
  }
  return slots;
}

/**
 * Whether `existing` (the row that already holds the unique-name slot) is
 * indistinguishable, from the caller's point of view, from what `input`
 * asked to create. Compared on the fields the user/model actually
 * specified — `cron`, `prompt`, `channel`, the resolved `timeoutMs`
 * (matching `store.create`'s own default so an omitted vs. explicit
 * default value doesn't defeat the comparison), `outputTemplate`
 * (Phase C structured-output template — an independently-settable object,
 * so it needs a structural/deep comparison rather than `===`; two calls
 * that agree on everything else but differ on `outputTemplate` are the
 * caller asking to change the template on an existing schedule, not a
 * retry, and must still surface as a name conflict), and `conversationRef`.
 * `conversationRef` is also caller-specified on the cold-start outreach
 * path: `ManageRoutineTool.handleCreate` derives it from `targetEmail` via
 * `buildEmailColdStartTarget`, which resolves deterministically per email —
 * same `targetEmail` on both calls produces the same `conversationRef`
 * structure (a true retry), while a different `targetEmail` produces a
 * different one (a genuine new request, e.g. the same routine name aimed
 * at a different recipient). Excluding it would let a create for a new
 * recipient silently reconcile to — and return as "created" — an existing
 * row still routed to the *original* recipient, a silent-wrong-recipient
 * bug. Deep comparison (not `===`) for the same reason as `outputTemplate`:
 * it is `unknown`/an object, not a primitive.
 */
function isSameRoutineRequest(
  existing: Routine,
  input: CreateRoutineInput,
): boolean {
  return (
    existing.cron === input.cron &&
    existing.prompt === input.prompt &&
    existing.channel === input.channel &&
    existing.timeoutMs === (input.timeoutMs ?? 600_000) &&
    isDeepStrictEqual(existing.outputTemplate, input.outputTemplate ?? null) &&
    isDeepStrictEqual(existing.conversationRef, input.conversationRef ?? {})
  );
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
