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

/**
 * Spec 2042 §5.10 — a model call the gateway refuses: no execution context,
 * an operation the context does not allow, a context past its deadline or
 * cancelled, or a kill switch. `code` says which. Never retried.
 */
export class ModelCallRefusedError extends Error {
  public readonly code: 'no_context' | 'operation_not_allowed' | 'deadline' | 'cancelled' | 'kill_switch';
  constructor(code: ModelCallRefusedError['code'], message: string) {
    super(`model call refused: ${message}`);
    this.name = 'ModelCallRefusedError';
    this.code = code;
  }
}

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
 * Spec 2042 §5.10 — the operations of the model gateway. `complete` is text
 * generation (`complete()` and `stream()` alike), `embed` and `transcribe`
 * are what embedding and transcription models do, and `run_loop` is a model
 * and tool loop the provider runs itself (the `claude-cli` turn).
 */
export type ModelOperation = 'complete' | 'embed' | 'transcribe' | 'run_loop';

/**
 * Called by a provider before it reaches its backend, with the operation it
 * is about to run. Throws when the host refuses the call: a reservation that
 * has no call left ({@link ModelCallNotCoveredError}), no execution context,
 * or an operation the context does not allow. Counts the call otherwise.
 * A provider compiled against an older contract calls it without an
 * operation; that reads as `complete`.
 */
export function admitModelCall(operation: ModelOperation = 'complete'): void {
  const check = (globalThis as unknown as Record<symbol, ((op: ModelOperation) => void) | undefined>)[
    MODEL_CALL_GATE_SLOT
  ];
  if (typeof check === 'function') check(operation);
}

/** Names of every error the gate throws: none of them is retried, and none
 *  may become a helper's silent fallback. */
const REFUSAL_NAMES: ReadonlySet<string> = new Set(['ModelCallNotCoveredError', 'ModelCallRefusedError']);

/** Whether `err` is (or was caused by) a refused model call. */
export function isModelCallNotCovered(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && typeof e === 'object' && depth < 5; depth += 1) {
    const name = (e as { name?: unknown }).name;
    if (typeof name === 'string' && REFUSAL_NAMES.has(name)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
