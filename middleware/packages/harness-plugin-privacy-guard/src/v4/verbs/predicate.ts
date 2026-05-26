/**
 * Privacy Shield v4 — Verb predicate grammar (US5).
 *
 * The bounded, safe `filter` expression grammar. A `Predicate` is a JSON tree
 * (defined in `../types.ts`), never a string to evaluate. Validation enforces
 * the contract rules P1–P4: predicates range only over `safe-cleartext` fields
 * and row handles, use a closed operator set, and are depth-bounded.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/verb-api.md §3
 */

import type {
  DatasetRow,
  DatasetSchema,
  Predicate,
  PredicateScalar,
} from '../types.js';

/** Error raised by predicate validation and by every verb. */
export class VerbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerbError';
  }
}

/** P4 — maximum nesting depth of and/or/not combinators. */
export const MAX_PREDICATE_DEPTH = 8;

/** Collect every field path a predicate references; enforces P4 (depth). */
function collectFields(
  p: Predicate,
  into: Set<string>,
  depth: number,
): void {
  if (depth > MAX_PREDICATE_DEPTH) {
    throw new VerbError(
      `predicate nesting exceeds the maximum depth of ${String(MAX_PREDICATE_DEPTH)}`,
    );
  }
  switch (p.op) {
    case 'and':
    case 'or':
      for (const clause of p.clauses) collectFields(clause, into, depth + 1);
      return;
    case 'not':
      collectFields(p.clause, into, depth + 1);
      return;
    default:
      into.add(p.field);
  }
}

/**
 * Validate a predicate against a dataset schema (contract P1, P4).
 *
 *  - P1: every referenced field must resolve to a `safe-cleartext` field or a
 *    row handle. A reference to a `sensitive-masked` field is rejected — this
 *    blocks the LLM from binary-searching identity values through predicates.
 *  - P4: combinator nesting is depth-bounded.
 *
 * P2 (closed operator set) is enforced by the `Predicate` type itself.
 * Throws `VerbError` on the first violation.
 */
export function validatePredicate(
  predicate: Predicate,
  schema: DatasetSchema,
): void {
  const referenced = new Set<string>();
  collectFields(predicate, referenced, 0);
  for (const path of referenced) {
    const field = schema.fields.find((f) => f.path === path);
    if (field === undefined) {
      throw new VerbError(`predicate references unknown field "${path}"`);
    }
    if (field.classification === 'sensitive-masked') {
      throw new VerbError(
        `predicate may not reference the masked field "${path}"`,
      );
    }
  }
}

/** Three-way compare for predicate operands. */
function compare(a: unknown, b: PredicateScalar): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Evaluate a validated predicate against one row. */
export function evaluatePredicate(predicate: Predicate, row: DatasetRow): boolean {
  switch (predicate.op) {
    case 'and':
      return predicate.clauses.every((c) => evaluatePredicate(c, row));
    case 'or':
      return predicate.clauses.some((c) => evaluatePredicate(c, row));
    case 'not':
      return !evaluatePredicate(predicate.clause, row);
    case 'eq':
      return compare(row[predicate.field], predicate.value) === 0;
    case 'ne':
      return compare(row[predicate.field], predicate.value) !== 0;
    case 'lt':
      return compare(row[predicate.field], predicate.value) < 0;
    case 'lte':
      return compare(row[predicate.field], predicate.value) <= 0;
    case 'gt':
      return compare(row[predicate.field], predicate.value) > 0;
    case 'gte':
      return compare(row[predicate.field], predicate.value) >= 0;
    case 'in':
      return predicate.values.some(
        (v) => compare(row[predicate.field], v) === 0,
      );
    case 'between':
      return (
        compare(row[predicate.field], predicate.lo) >= 0 &&
        compare(row[predicate.field], predicate.hi) <= 0
      );
  }
}
