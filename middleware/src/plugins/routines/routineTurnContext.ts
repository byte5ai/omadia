import { AsyncLocalStorage } from 'node:async_hooks';

import type { ManageRoutineContext } from './manageRoutineTool.js';

/**
 * Per-turn channel context the `manage_routine` tool needs to:
 *   - attribute `create` calls to the right (tenant, user)
 *   - capture the channel-native delivery handle for proactive sends
 *
 * Channel adapters install the context at the OUTER edge of an inbound
 * turn (before the orchestrator-internal AsyncLocalStorage scope) by
 * calling `withRoutineContext(value, fn)`. The tool reads it via
 * `currentRoutineContext()`. Decoupled from the orchestrator's
 * `turnContext` so we don't have to touch that package — the cost is
 * one extra ALS per turn (negligible) in exchange for plugin isolation.
 *
 * Outside a channel turn (HTTP /api/chat with no routine support, unit
 * tests, ad-hoc invocations) the context is undefined and the tool
 * returns a clear error string.
 */

const storage = new AsyncLocalStorage<ManageRoutineContext>();

/**
 * Phase C.2 — Raw tool-result capture storage.
 *
 * The routine runner enters this ALS with a fresh `Map<toolName, unknown>`
 * before invoking `orchestrator.runTurn`, and installs a bridging callback
 * on the orchestrator's `turnContext.captureRawToolResult`. The
 * orchestrator's tool dispatcher (main + sub-agents) writes raw,
 * pre-tokenisation results into this map.
 *
 * Later slices (C.4 — template renderer, C.5 — orchestrator branch) read
 * `currentRawToolResults()` to pull data for `data-table` / `data-list`
 * sections — bypassing the LLM as the data renderer.
 *
 * Lifecycle is bounded by the ALS scope (one routine turn). When the
 * outer scope exits, the map is naturally collected. Last-write-wins
 * semantics if the same tool name is invoked multiple times in a turn
 * (consistent with the design's `Map<toolName, unknown>` shape).
 *
 * Undefined outside a routine turn ⇒ chat path is unaffected.
 */
const rawToolResultsStorage = new AsyncLocalStorage<Map<string, unknown>>();

export const routineTurnContext = {
  /** Run `fn` with `value` as the active routine context. */
  run<T>(value: ManageRoutineContext, fn: () => Promise<T>): Promise<T> {
    return storage.run(value, fn);
  },

  /**
   * Set the routine context for the current async resource and its
   * descendants. Use from async generators where `run()` doesn't compose
   * with `yield` (mirrors the orchestrator's `turnContext.enter`).
   */
  enter(value: ManageRoutineContext): void {
    storage.enterWith(value);
  },

  /** Read-only accessor. Returns undefined outside a channel turn. */
  current(): ManageRoutineContext | undefined {
    return storage.getStore();
  },

  /**
   * Phase C.2 — Run `fn` with `map` as the active raw-tool-result stash.
   * The map is owned by the caller (the routine runner) so it can read
   * the captures after `fn` resolves; the ALS scope only controls
   * visibility to nested code that consults `currentRawToolResults()`.
   */
  withRawToolResults<T>(
    map: Map<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return rawToolResultsStorage.run(map, fn);
  },

  /**
   * Phase C.2 — Read-only accessor for the active raw-tool-result map.
   * Returns undefined outside a routine turn (chat, ad-hoc invocations,
   * tests without an enclosing `withRawToolResults`).
   */
  currentRawToolResults(): Map<string, unknown> | undefined {
    return rawToolResultsStorage.getStore();
  },
};
