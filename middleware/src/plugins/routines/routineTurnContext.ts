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
};
