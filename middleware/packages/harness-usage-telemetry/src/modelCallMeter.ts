/**
 * #2090 — counting and bounding the model calls of an async scope.
 *
 * The host half of the gate in `@omadia/llm-provider-api`: every provider
 * calls `admitModelCall()` before it reaches its backend, and this module
 * decides what that does. Inside {@link meterModelCalls} the call is counted
 * and, with a limit, refused beyond it.
 *
 * Many helpers catch a failing model call and carry on (a classifier that
 * falls back, a guard that passes on error). A refused call must not become
 * such a silent fallback, so the meter also reports THAT a call was refused;
 * whoever opened it decides what that means for the whole turn.
 *
 * The store and the installed check are process-wide (`Symbol.for` slots): a
 * package that got loaded twice still feeds the one meter the kernel opened.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { MODEL_CALL_GATE_SLOT, ModelCallNotCoveredError } from '@omadia/llm-provider';

interface Meter {
  /** Calls let through, in this scope and the ones nested in it. */
  admitted: number;
  /** Calls refused, in this scope and the ones nested in it. */
  refused: number;
  readonly limit: number | undefined;
  readonly parent: Meter | undefined;
}

const STORE_SLOT = Symbol.for('omadia.llm.modelCallMeter');
type Slots = Record<symbol, unknown>;

function store(): AsyncLocalStorage<Meter> {
  const slots = globalThis as unknown as Slots;
  const existing = slots[STORE_SLOT] as AsyncLocalStorage<Meter> | undefined;
  if (existing) return existing;
  const created = new AsyncLocalStorage<Meter>();
  slots[STORE_SLOT] = created;
  return created;
}

function check(): void {
  const innermost = store().getStore();
  if (!innermost) return;
  for (let meter: Meter | undefined = innermost; meter; meter = meter.parent) {
    if (meter.limit !== undefined && meter.admitted >= meter.limit) {
      for (let m: Meter | undefined = innermost; m; m = m.parent) m.refused += 1;
      throw new ModelCallNotCoveredError(meter.limit);
    }
  }
  for (let meter: Meter | undefined = innermost; meter; meter = meter.parent) meter.admitted += 1;
}

/** Install the check behind `admitModelCall()`. Idempotent. */
export function installModelCallGate(): void {
  const slots = globalThis as unknown as Slots;
  if (typeof slots[MODEL_CALL_GATE_SLOT] !== 'function') slots[MODEL_CALL_GATE_SLOT] = check;
}

export interface ModelCallCount<T> {
  readonly value: T;
  /** Model calls made inside the scope. */
  readonly modelCalls: number;
  /** Model calls the limit refused. More than 0: the work ran without a call
   *  it asked for, whatever it returned. */
  readonly refused: number;
}

/**
 * Run `work`, count the model calls made inside it and, with `limit`, refuse
 * every call beyond it. Scopes nest: a call counts for every scope around
 * it, and each scope's limit applies. A call made after `work` settled is
 * outside the scope. `work` gets a probe for the counts so far, so it can
 * decide before it commits a result whether a call was refused on the way.
 * What `work` throws carries on.
 */
export async function meterModelCalls<T>(
  work: (probe: () => { modelCalls: number; refused: number }) => Promise<T>,
  options: { readonly limit?: number } = {},
): Promise<ModelCallCount<T>> {
  installModelCallGate();
  const als = store();
  const meter: Meter = { admitted: 0, refused: 0, limit: options.limit, parent: als.getStore() };
  const probe = (): { modelCalls: number; refused: number } => ({ modelCalls: meter.admitted, refused: meter.refused });
  const value = await als.run(meter, () => work(probe));
  return { value, modelCalls: meter.admitted, refused: meter.refused };
}
