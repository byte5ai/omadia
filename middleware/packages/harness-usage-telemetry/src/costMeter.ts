/**
 * #2082 — the actual cost of an async scope, for budgets that are settled
 * with real usage (spec 2042 §5.12: "checked before every firing and settled
 * with the actual usage after it").
 *
 * Every model call that reaches `recordUsage` adds its billed cost to each
 * cost meter around it. Unlike summing `token_usage` by turn afterwards, this
 * needs no database, no flush and no turn id, and it includes the helper
 * calls (routers, verifiers, sub-agent helpers) a turn makes on the way.
 *
 * Process-wide `Symbol.for` slot: a package loaded twice still feeds the one
 * meter the kernel opened.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface CostMeter {
  costUsd: number;
  readonly parent: CostMeter | undefined;
}

const STORE_SLOT = Symbol.for('omadia.usage.costMeter');
type Slots = Record<symbol, unknown>;

function store(): AsyncLocalStorage<CostMeter> {
  const slots = globalThis as unknown as Slots;
  const existing = slots[STORE_SLOT] as AsyncLocalStorage<CostMeter> | undefined;
  if (existing) return existing;
  const created = new AsyncLocalStorage<CostMeter>();
  slots[STORE_SLOT] = created;
  return created;
}

/** Add a call's cost to every meter around the current async scope. */
export function addMeteredCost(costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  for (let m = store().getStore(); m; m = m.parent) m.costUsd += costUsd;
}

/** Run `work` and report the cost of the model calls made inside it. */
export async function meterUsageCost<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly costUsd: number }> {
  const als = store();
  const meter: CostMeter = { costUsd: 0, parent: als.getStore() };
  const value = await als.run(meter, work);
  return { value, costUsd: meter.costUsd };
}
