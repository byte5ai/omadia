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

export type TurnHookPoint = 'onBeforeTurn' | 'onAfterToolCall' | 'onAfterTurn';

export interface TurnHookContext {
  readonly turnId: string;
  readonly sessionScope?: string;
  readonly userId?: string;
}

export interface TurnHookPayload {
  readonly userMessage?: string;
  readonly assistantAnswer?: string;
  readonly toolName?: string;
  readonly toolResult?: string;
}

/**
 * Minimal contract the orchestrator needs to fire hooks. The app-layer
 * `TurnHookRegistry` implements this (plus `register()` / `counts()`).
 */
export interface TurnHookRunner {
  run(
    point: TurnHookPoint,
    ctx: TurnHookContext,
    payload: TurnHookPayload,
  ): Promise<void>;
}
