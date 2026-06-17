/**
 * omadia-canvas-protocol/1.1 — Lume Expressions (LX) TypeScript types.
 * Mirrors schema/lx-ast.schema.json and schema/lumen.schema.json. Where these
 * and the schema disagree, the schema wins (the validator is the contract).
 */

/** A runtime LX value: number (int|number), bool, string, list, record. */
export type LxValue = number | boolean | string | LxValue[] | { [k: string]: LxValue };

/** The closed, serialisable state record a Lumen carries (§1.1). */
export type StateValue = { [k: string]: LxValue };

/** A JSON AST node (§2.2). Validated structurally by the schema; this is the
 *  permissive TS shape the interpreter walks. */
export type LxNode =
  | { lit: LxValue }
  | { state: string; at?: [LxNode, LxNode] }
  | { event: string }
  | { var: string }
  | { let: Record<string, LxNode>; in: LxNode }
  | { '+': LxNode[] } | { '-': LxNode[] } | { '*': LxNode[] } | { '/': [LxNode, LxNode] } | { mod: [LxNode, LxNode] }
  | { '>': [LxNode, LxNode] } | { '>=': [LxNode, LxNode] } | { '<': [LxNode, LxNode] } | { '<=': [LxNode, LxNode] } | { '==': [LxNode, LxNode] } | { '!=': [LxNode, LxNode] }
  | { and: LxNode[] } | { or: LxNode[] } | { not: LxNode }
  | { if: LxNode; then: LxNode; else: LxNode }
  | { match: LxNode; cases: { when: LxNode; then: LxNode }[]; else: LxNode }
  | { record: Record<string, LxNode> }
  | { list: LxNode[] }
  | { get: LxNode; key: LxNode }
  | { set: Record<string, LxNode> }
  | { call: StdlibName; args: LxNode[] };

export type StdlibName =
  | 'map' | 'filter' | 'fold' | 'range' | 'len' | 'min' | 'max' | 'clamp'
  | 'abs' | 'floor' | 'ceil' | 'round' | 'sqrt' | 'sign' | 'pow'
  | 'concat' | 'slice' | 'contains' | 'indexOf' | 'keys' | 'values'
  | 'upper' | 'lower' | 'pad' | 'fmt'
  | 'random' | 'now';

/** Host-seeded, bounded evaluation context (§0.3, §2.4). Identical
 *  (state, event, seed, now) ⇒ byte-identical result on every machine. */
export interface EvalOptions {
  state: StateValue;
  event?: Record<string, LxValue>;
  /** host seed for `random()` — same seed ⇒ same sequence (replay/share). */
  seed?: number;
  /** host clock value returned by `now()` — fixed per evaluation. */
  now?: number;
  /** instruction budget; default DEFAULT_GAS. Over budget ⇒ LxError('gas'). */
  gas?: number;
}

export type LxErrorCode = 'gas' | 'type' | 'unknown-node' | 'unknown-call' | 'bad-path' | 'bounds' | 'div-zero' | 'arity';

export class LxError extends Error {
  constructor(
    public code: LxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LxError';
  }
}

/** lumens-spec.md §2.4 — spike-tunable initial defaults. */
export const DEFAULT_GAS = 50_000;
/** §0.2 — bounded iteration: a single collection op may not exceed this. */
export const MAX_ITERATIONS = 100_000;
/** §2.3 — `range(n)` upper bound (gas also bounds it). */
export const MAX_RANGE = 100_000;
/** §0.2 — hard ceiling on any single produced value (list length / string
 *  length / record keys). Stops size-amplifying ops (concat-doubling, pad,
 *  map-over-range) from exploding memory while gas stays low. */
export const MAX_VALUE_SIZE = 1_000_000;
/** §0.2 — max AST recursion depth; a deeper tree halts with LxError before it
 *  can overflow the JS stack (which would be an uncatchable RangeError). */
export const MAX_DEPTH = 1_024;
