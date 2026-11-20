/**
 * #2090 — the gate every model call passes.
 *
 * A turn that runs under an execution scope reserves a number of model calls,
 * helper and guard calls included (spec 2043 §0). "Reserved" only means
 * something if a call the reservation does not cover is not made. So every
 * provider implementation calls {@link admitModelCall} before it reaches its
 * backend, once per `complete()` and once per `stream()` (its own retries of
 * one request are one call).
 *
 * This package is the contract a provider compiles against, so the call
 * lives here: a provider cannot be written without seeing it, and no caller
 * of a provider has to remember it. What the gate DOES is the host's: the
 * kernel (`meterModelCalls` in `@omadia/usage-telemetry`) installs the check in a
 * process-wide slot. Without a host that installed one, the gate is a no-op.
 */

/** A model call the active reservation does not cover. Never retried. */
export class ModelCallNotCoveredError extends Error {
  public readonly limit: number;
  constructor(limit: number) {
    super(
      `model call refused: this turn reserved ${String(limit)} model call${limit === 1 ? '' : 's'} and has used them`,
    );
    this.name = 'ModelCallNotCoveredError';
    this.limit = limit;
  }
}

/** The process-wide slot the host installs its check in. `Symbol.for`, so a
 *  package that got loaded twice still reaches the one check. */
export const MODEL_CALL_GATE_SLOT = Symbol.for('omadia.llm.modelCallGate');

/**
 * Called by a provider before it reaches its backend. Throws
 * {@link ModelCallNotCoveredError} when the host's reservation around the
 * call has no call left; counts the call otherwise.
 */
export function admitModelCall(): void {
  const check = (globalThis as unknown as Record<symbol, (() => void) | undefined>)[MODEL_CALL_GATE_SLOT];
  if (typeof check === 'function') check();
}

/** Whether `err` is (or was caused by) a refused model call. */
export function isModelCallNotCovered(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && typeof e === 'object' && depth < 5; depth += 1) {
    if ((e as { name?: unknown }).name === 'ModelCallNotCoveredError') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
