/**
 * Epic #470 W4 — pure budget logic for the operator surface (spec §5).
 *
 * Kept framework-free so it is unit-testable without jsdom/next-intl: the
 * actual currency rendering still goes through next-intl's `useFormatter()`
 * in the component (per web-ui/CLAUDE.md — no hardcoded-locale `Intl.*`). This
 * module owns only the *decisions*: how close a job is to its budget, and
 * whether an operator's budget input is valid.
 */

/** A job at ≥80% of its budget shows the near-budget (warning) affordance. */
export const NEAR_BUDGET_RATIO = 0.8;
/** A job at ≥100% of its budget shows the over-budget (error) affordance. */
export const OVER_BUDGET_RATIO = 1;

/** Budget proximity: `none` = no budget set; otherwise ok/near/over. */
export type BudgetState = 'none' | 'ok' | 'near' | 'over';

/**
 * `costUsd / budgetCostUsd`, or null when there is no usable budget (unset,
 * non-positive) or the cost is not a finite non-negative number.
 */
export function budgetRatio(
  costUsd: number,
  budgetCostUsd: number | null | undefined,
): number | null {
  if (budgetCostUsd == null || !Number.isFinite(budgetCostUsd) || budgetCostUsd <= 0) {
    return null;
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) return null;
  return costUsd / budgetCostUsd;
}

/** Classify a job's spend against its budget (see {@link BudgetState}). */
export function budgetState(
  costUsd: number,
  budgetCostUsd: number | null | undefined,
): BudgetState {
  const ratio = budgetRatio(costUsd, budgetCostUsd);
  if (ratio === null) return 'none';
  if (ratio >= OVER_BUDGET_RATIO) return 'over';
  if (ratio >= NEAR_BUDGET_RATIO) return 'near';
  return 'ok';
}

/** Result of validating an operator's free-text budget entry. */
export type ParsedBudget = { ok: true; value: number | null } | { ok: false };

/**
 * Validate a budget input string.
 *
 * - empty / whitespace ⇒ `{ ok: true, value: null }` (clear → fall back to the
 *   default; an unset budget is a valid, intentional state).
 * - a strictly-positive finite number ⇒ `{ ok: true, value }`.
 * - `integer: true` additionally rejects fractional values (token budgets).
 * - anything else (zero, negative, NaN, non-numeric) ⇒ `{ ok: false }`.
 */
export function parseBudgetInput(
  raw: string,
  opts: { integer?: boolean } = {},
): ParsedBudget {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  // Reject inputs Number() would coerce leniently (e.g. '', whitespace, hex).
  if (!/^\d*\.?\d+$/.test(trimmed)) return { ok: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  if (opts.integer && !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}
