/**
 * Turn-hook execution contract (#133 plan-as-data, slice E0).
 *
 * The orchestrator fires these side-channel hooks during a chat turn:
 *   - `onBeforeTurn`    — before the first LLM inference
 *   - `onAfterToolCall` — after each top-level tool invocation in the tool loop
 *   - `onAfterTurn`     — after the turn produced its final answer
 *
 * A runner that satisfies `TurnHookRunner` is injected via
 * `OrchestratorOptions.turnHookRegistry`. The kernel's concrete implementation
 * lives in the app layer (`src/platform/turnHookRegistry.ts`) and structurally
 * satisfies this interface; the canonical shape is mirrored here so the
 * orchestrator package keeps no backward dependency on the app layer.
 *
 * Contract: a thrown hook MUST NOT abort the turn — the runner swallows and
 * logs hook errors, and the orchestrator defends with its own try/catch.
 * Hooks are observers, not gatekeepers.
 */

export type TurnHookPoint =
  | 'onBeforeTurn'
  | 'onAfterToolCall'
  | 'onAfterTurn'
  /** #133 (E6) — fired by VerifierService when a verdict is `blocked`. The
   *  session scope is on ctx; the reason is in payload.blockReason. Observer:
   *  the verifier runs its own retry regardless. */
  | 'onVerifierBlocked';

export interface TurnHookContext {
  readonly turnId: string;
  readonly sessionScope?: string;
  readonly userId?: string;
  /**
   * Per-orchestrator isolation — the Agent (orchestrator) slug handling this
   * turn (= the orchestrator's `agentId`). Hooks that persist scope-keyed KG
   * artefacts (e.g. the plan-runner's Plan nodes) MUST qualify their scope
   * with it (`<agentSlug>::<sessionScope>`, via `qualifyScope`) so recall
   * stays per-Agent — matching what `SessionLogger` writes for Turns.
   * Undefined on legacy / single-agent boots → callers fall back to the raw
   * scope (the `default::` dual-clause keeps it reachable).
   */
  readonly agentSlug?: string;
}

/**
 * #133 (E9) — a serialisable annotation a hook returns for the orchestrator to
 * emit into the turn's event stream. The orchestrator forwards it OPAQUELY (it
 * stays plan-agnostic — it never inspects `payload`); the `channel` string lets
 * clients route it (e.g. the plan-runner emits `channel: 'plan'`). Only the
 * streaming path emits these; non-streaming turns ignore them.
 */
export interface TurnAnnotation {
  readonly channel: string;
  readonly payload: unknown;
}

export interface TurnHookPayload {
  readonly userMessage?: string;
  readonly assistantAnswer?: string;
  readonly toolName?: string;
  readonly toolResult?: string;
  /** #133 (E6) — verifier block reason, set on `onVerifierBlocked`. */
  readonly blockReason?: string;
  /**
   * #133 (E8) — the persisted Turn node external id (`turn:<scope>:<time>`),
   * set on `onAfterTurn` once the session log has landed. The orchestrator
   * turn id (`ctx.turnId`) is a per-turn UUID and is NOT the Turn node id, so
   * a runner that wants to link its artefacts to the graph Turn (e.g. the
   * plan-runner's `PLAN_OF` edge) needs this. Absent until the turn is
   * persisted (so absent on the other hook points, and on a failed log).
   */
  readonly turnExternalId?: string;
}

/**
 * Minimal contract the orchestrator needs to fire hooks. The app-layer
 * `TurnHookRegistry` implements this (plus `register()` / `counts()`).
 */
export interface TurnHookRunner {
  /** Runs every hook at `point`; returns the annotations they emitted (E9),
   *  flattened across hooks in priority order. Empty when none emit. */
  run(
    point: TurnHookPoint,
    ctx: TurnHookContext,
    payload: TurnHookPayload,
  ): Promise<TurnAnnotation[]>;
}

/** A single hook callback. May return annotations for the orchestrator to emit
 *  into the stream (E9). Thrown errors are swallowed by the runner. */
export type TurnHook = (
  ctx: TurnHookContext,
  payload: TurnHookPayload,
) => void | TurnAnnotation[] | Promise<void | TurnAnnotation[]>;

export interface TurnHookRegistration {
  readonly hook: TurnHook;
  /** Lower priority runs first. Default 0. */
  readonly priority?: number;
  /** Diagnostic label shown when the hook throws. */
  readonly label: string;
}

/**
 * Register-capable view of the turn-hook registry, for plugins that want to
 * SUBSCRIBE to hook points (e.g. the #133 plan-runner). The kernel's concrete
 * `TurnHookRegistry` (app layer) satisfies this; plugins resolve it via
 * `ctx.services.get<TurnHookRegistrar>('turnHookRegistry')`. `register`
 * returns a dispose handle the plugin should call on deactivate.
 */
export interface TurnHookRegistrar extends TurnHookRunner {
  register(point: TurnHookPoint, reg: TurnHookRegistration): () => void;
}
