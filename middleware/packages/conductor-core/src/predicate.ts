// Pure, deterministic evaluator for the Predicate AST. No I/O, no eval.

import type { EvalScope, JsonValue, Predicate } from './types.js';

/** Resolve a dot-path (e.g. "ctx.base", "stepResult.items.0.id") against the scope.
 *  Numeric segments index into arrays. Any missing segment yields `undefined`. */
export function resolvePath(scope: EvalScope, path: string): JsonValue | undefined {
  // The scope object {ctx, stepResult} is itself the path root.
  let current: JsonValue | undefined = scope as unknown as JsonValue;
  if (path.length === 0) return current;
  for (const seg of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, JsonValue>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Stable, key-sorted serialization for deterministic deep-equality. */
function canonical(v: JsonValue): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const obj = v as Record<string, JsonValue>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k]!)).join(',') + '}';
}

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return canonical(a) === canonical(b);
}

function compareOrder(op: 'gt' | 'lt' | 'gte' | 'lte', left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    switch (op) {
      case 'gt': return left > right;
      case 'lt': return left < right;
      case 'gte': return left >= right;
      case 'lte': return left <= right;
    }
  }
  if (typeof left === 'string' && typeof right === 'string') {
    switch (op) {
      case 'gt': return left > right;
      case 'lt': return left < right;
      case 'gte': return left >= right;
      case 'lte': return left <= right;
    }
  }
  return false;
}

/**
 * The right-hand side of a comparison: a literal, or another dot-path when the
 * predicate carries `valuePath`. `valuePath` wins over `value` when both are
 * set, so a graph cannot half-declare both and get the literal silently.
 *
 * An unresolvable `valuePath` yields `undefined`, which `compareOrder` reads as
 * "not comparable" — so a loop guarded by a budget that is missing from the
 * context STOPS. That direction is deliberate: the failure mode of a guard is
 * a runaway loop, and an absent ceiling must not be read as an infinite one.
 */
function rightOf(
  pred: { value?: JsonValue; valuePath?: string },
  scope: EvalScope,
): { comparable: boolean; value: JsonValue | undefined } {
  if (pred.valuePath === undefined) return { comparable: true, value: pred.value };
  const resolved = resolvePath(scope, pred.valuePath);
  // Uniformly NOT comparable, including for `ne` — which would otherwise invert
  // an unresolvable budget into `true` and keep a loop running on a value that
  // does not exist. The whole comparison is false instead, whatever the op.
  return { comparable: resolved !== undefined, value: resolved };
}

/** Evaluate a predicate against a scope. Total and deterministic: any type mismatch or
 *  missing path resolves to `false` (never throws). */
export function evaluatePredicate(pred: Predicate, scope: EvalScope): boolean {
  switch (pred.op) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'and':
      return pred.args.every((p) => evaluatePredicate(p, scope));
    case 'or':
      return pred.args.some((p) => evaluatePredicate(p, scope));
    case 'not':
      return !evaluatePredicate(pred.arg, scope);
    case 'exists':
      return resolvePath(scope, pred.path) !== undefined;
    case 'eq':
    case 'ne':
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const right = rightOf(pred, scope);
      if (!right.comparable) return false;
      const left = resolvePath(scope, pred.path);
      if (pred.op === 'eq') return deepEqual(left, right.value);
      if (pred.op === 'ne') return !deepEqual(left, right.value);
      return compareOrder(pred.op, left, right.value);
    }
    case 'in': {
      const left = resolvePath(scope, pred.path);
      return pred.value.some((v) => deepEqual(left, v));
    }
    case 'matches': {
      const left = resolvePath(scope, pred.path);
      if (typeof left !== 'string') return false;
      let re: RegExp;
      try {
        re = new RegExp(pred.value);
      } catch {
        return false;
      }
      return re.test(left);
    }
  }
}
