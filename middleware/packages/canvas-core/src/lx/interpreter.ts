/**
 * omadia-canvas-protocol/1.1 — the Tier-1 LX interpreter (lumens-spec.md §2).
 *
 * Pure, total, deterministic AST evaluator. No `eval`/`Function` (CSP stays
 * `default-src 'self'`). Every node costs gas; iteration is bounded; `random`
 * and `now` are host-seeded. Given identical (state, event, seed, now) the
 * result is byte-identical on every machine — the basis for replay, undo,
 * sharing and v2 multi-user (§0.3). Any structural surprise throws LxError and
 * the host halts that Lumen with surface_error (never the canvas, §0.2).
 */
import {
  DEFAULT_GAS,
  LxError,
  MAX_DEPTH,
  MAX_ITERATIONS,
  MAX_RANGE,
  MAX_VALUE_SIZE,
  type EvalOptions,
  type LxNode,
  type LxValue,
  type StateValue,
} from './types.js';

interface Ctx {
  state: StateValue;
  event: Record<string, LxValue>;
  env: Record<string, LxValue>; // lexical bindings (let / it / idx / acc)
  now: number;
  gas: { n: number };
  depth: number;
  rng: () => number;
}

/** Deterministic PRNG (mulberry32) — pure arithmetic, fully replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isRecord = (v: unknown): v is { [k: string]: LxValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Prototype-pollution guard. LX is data, but a `set`/`record`/`state` path
 *  segment of `__proto__`/`prototype`/`constructor` would let declarative data
 *  reach the JS object graph — reject it hard (defence in depth, independent of
 *  the semantic validator). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function safeKey(key: string): string {
  if (FORBIDDEN_KEYS.has(key)) throw new LxError('bad-path', `forbidden key '${key}'`);
  return key;
}

function burn(ctx: Ctx, amount = 1): void {
  ctx.gas.n -= amount;
  if (ctx.gas.n < 0) throw new LxError('gas', 'gas budget exhausted');
}

/** Charge gas proportional to a produced value's size AND cap it — so a
 *  size-amplifying op (concat-doubling, pad, map-over-range) cannot explode
 *  memory while staying under the per-node gas budget (F1). */
function chargeSize(ctx: Ctx, size: number): void {
  if (size > MAX_VALUE_SIZE) throw new LxError('bounds', `produced value size ${size} exceeds the ${MAX_VALUE_SIZE} cap`);
  burn(ctx, size);
}

/** Guard a numeric result against NaN / ±Infinity / -0 divergence: non-finite
 *  numbers serialise lossily (JSON → null) and would break replay determinism
 *  (F8). A non-finite arithmetic result halts the Lumen instead. */
function fin(n: number): number {
  if (!Number.isFinite(n)) throw new LxError('bounds', 'non-finite numeric result');
  return n === 0 ? 0 : n; // normalise -0 → 0
}

/** Per-stdlib argument arity (F7). undefined max ⇒ variadic ≥ min. */
const ARITY: Record<string, [min: number, max: number]> = {
  map: [2, 2], filter: [2, 2], fold: [3, 3], range: [1, 1], len: [1, 1],
  min: [1, Infinity], max: [1, Infinity], clamp: [3, 3],
  abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 1], sqrt: [1, 1], sign: [1, 1], pow: [2, 2],
  concat: [1, Infinity], slice: [2, 3], contains: [2, 2], indexOf: [2, 2], keys: [1, 1], values: [1, 1],
  upper: [1, 1], lower: [1, 1], pad: [2, 3], fmt: [1, 1], random: [0, 0], now: [0, 0],
};

function asNumber(v: LxValue): number {
  if (typeof v !== 'number') throw new LxError('type', `expected number, got ${typeof v}`);
  return v;
}
function asBool(v: LxValue): boolean {
  if (typeof v !== 'boolean') throw new LxError('type', `expected bool, got ${typeof v}`);
  return v;
}
function asString(v: LxValue): string {
  if (typeof v !== 'string') throw new LxError('type', `expected string, got ${typeof v}`);
  return v;
}
function asList(v: LxValue): LxValue[] {
  if (!Array.isArray(v)) throw new LxError('type', `expected list, got ${typeof v}`);
  return v;
}

/** Structural deep-equality for `==` / `!=` / `contains` (total, gas-free at
 *  call sites that already burned for their operands). */
function deepEqual(a: LxValue, b: LxValue, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new LxError('bounds', 'value nesting too deep');
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]!, depth + 1));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k]!, b[k]!, depth + 1));
  }
  return false;
}

/** Read a dotted path into a record/list value. */
function readPath(root: LxValue, path: string): LxValue {
  let cur: LxValue = root;
  for (const seg of path.split('.')) {
    safeKey(seg);
    if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg]!;
    else if (Array.isArray(cur) && /^\d+$/.test(seg) && Number(seg) < cur.length) cur = cur[Number(seg)]!;
    else throw new LxError('bad-path', `path '${path}' does not resolve`);
  }
  return cur;
}

/** Immutable set of a dotted path; intermediate records are cloned, not mutated. */
function setPath(root: StateValue, path: string, value: LxValue): StateValue {
  const segs = path.split('.');
  segs.forEach(safeKey);
  // a Lumen's state is a CLOSED record (§1.1): `set` may update declared paths,
  // never invent a new top-level key (F5).
  if (!Object.prototype.hasOwnProperty.call(root, segs[0]!)) {
    throw new LxError('bad-path', `set target '${path}' is not a declared state key`);
  }
  const clone: StateValue = { ...root };
  let cur: { [k: string]: LxValue } = clone;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (!isRecord(next)) throw new LxError('bad-path', `cannot set into non-record at '${seg}'`);
    const copied = { ...next };
    cur[seg] = copied;
    cur = copied;
  }
  cur[segs[segs.length - 1]!] = value;
  return clone;
}

function evalNode(node: LxNode, ctx: Ctx): LxValue {
  burn(ctx);
  // every node must be an object (F3): a missing child (e.g. an `if` with no
  // `else` that slipped past the schema) becomes a typed LxError, never a raw
  // TypeError that escapes the host's surface_error channel.
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new LxError('unknown-node', `expected an LX node object, got ${node === null ? 'null' : typeof node}`);
  }
  // bound AST recursion depth (F4) — deeper would overflow the JS stack with an
  // uncatchable RangeError. Cloning with depth+1 (rather than mutating) means
  // siblings each see the true nesting depth, not an accumulated count.
  if (ctx.depth >= MAX_DEPTH) throw new LxError('bounds', 'expression nesting too deep');
  ctx = { ...ctx, depth: ctx.depth + 1 };
  const n = node as Record<string, unknown>;

  if ('lit' in n) return n.lit as LxValue;
  if ('var' in n) {
    const name = n.var as string;
    if (!(name in ctx.env)) throw new LxError('bad-path', `unbound var '${name}'`);
    return ctx.env[name]!;
  }
  if ('state' in n) {
    const base = readPath(ctx.state, n.state as string);
    if (n.at) {
      const [xn, yn] = n.at as [LxNode, LxNode];
      const x = asNumber(evalNode(xn, ctx));
      const y = asNumber(evalNode(yn, ctx));
      const row = asList(base)[y];
      if (row === undefined) throw new LxError('bounds', `grid row ${y} out of range`);
      const cell = asList(row)[x];
      if (cell === undefined) throw new LxError('bounds', `grid col ${x} out of range`);
      return cell;
    }
    return base;
  }
  if ('event' in n) {
    const field = n.event as string;
    return field in ctx.event ? ctx.event[field]! : 0;
  }
  if ('let' in n) {
    const binding = n.let as Record<string, LxNode>;
    const [name] = Object.keys(binding);
    const value = evalNode(binding[name!]!, ctx);
    const child: Ctx = { ...ctx, env: { ...ctx.env, [name!]: value } };
    return evalNode(n.in as LxNode, child);
  }

  // arithmetic (all results guarded finite — F8)
  if ('+' in n) return fin((n['+'] as LxNode[]).reduce((a, e) => a + asNumber(evalNode(e, ctx)), 0));
  if ('*' in n) return fin((n['*'] as LxNode[]).reduce((a, e) => a * asNumber(evalNode(e, ctx)), 1));
  if ('-' in n) {
    const xs = (n['-'] as LxNode[]).map((e) => asNumber(evalNode(e, ctx)));
    return fin(xs.slice(1).reduce((a, b) => a - b, xs[0]!));
  }
  if ('/' in n) {
    const [a, b] = (n['/'] as [LxNode, LxNode]).map((e) => asNumber(evalNode(e, ctx))) as [number, number];
    if (b === 0) throw new LxError('div-zero', 'division by zero');
    return fin(a / b);
  }
  if ('mod' in n) {
    const [a, b] = (n.mod as [LxNode, LxNode]).map((e) => asNumber(evalNode(e, ctx))) as [number, number];
    if (b === 0) throw new LxError('div-zero', 'mod by zero');
    return fin(a % b);
  }

  // comparison
  if ('>' in n) { const [a, b] = binNum(n['>'] as LxNode[], ctx); return a > b; }
  if ('>=' in n) { const [a, b] = binNum(n['>='] as LxNode[], ctx); return a >= b; }
  if ('<' in n) { const [a, b] = binNum(n['<'] as LxNode[], ctx); return a < b; }
  if ('<=' in n) { const [a, b] = binNum(n['<='] as LxNode[], ctx); return a <= b; }
  if ('==' in n) { const [a, b] = (n['=='] as LxNode[]).map((e) => evalNode(e, ctx)); return deepEqual(a!, b!); }
  if ('!=' in n) { const [a, b] = (n['!='] as LxNode[]).map((e) => evalNode(e, ctx)); return !deepEqual(a!, b!); }

  // logic (short-circuit)
  if ('and' in n) { for (const e of n.and as LxNode[]) if (!asBool(evalNode(e, ctx))) return false; return true; }
  if ('or' in n) { for (const e of n.or as LxNode[]) if (asBool(evalNode(e, ctx))) return true; return false; }
  if ('not' in n) return !asBool(evalNode(n.not as LxNode, ctx));

  // conditionals (total)
  if ('if' in n) return asBool(evalNode(n.if as LxNode, ctx)) ? evalNode(n.then as LxNode, ctx) : evalNode(n.else as LxNode, ctx);
  if ('match' in n) {
    const subject = evalNode(n.match as LxNode, ctx);
    for (const c of n.cases as { when: LxNode; then: LxNode }[]) {
      if (deepEqual(subject, evalNode(c.when, ctx))) return evalNode(c.then, ctx);
    }
    return evalNode(n.else as LxNode, ctx);
  }

  // constructors (size-charged — F1)
  if ('record' in n) {
    const entries = Object.entries(n.record as Record<string, LxNode>);
    chargeSize(ctx, entries.length);
    const out: { [k: string]: LxValue } = {};
    for (const [k, e] of entries) out[safeKey(k)] = evalNode(e, ctx);
    return out;
  }
  if ('list' in n) {
    const items = n.list as LxNode[];
    chargeSize(ctx, items.length);
    return items.map((e) => evalNode(e, ctx));
  }

  // projection: read a field of a record (string key) or element of a list (int index)
  if ('get' in n) {
    const container = evalNode(n.get as LxNode, ctx);
    const key = evalNode(n.key as LxNode, ctx);
    if (Array.isArray(container)) {
      if (typeof key !== 'number' || !Number.isInteger(key)) throw new LxError('type', 'list index must be an int');
      const el = container[key];
      if (el === undefined) throw new LxError('bounds', `list index ${key} out of range`);
      return el;
    }
    if (isRecord(container)) {
      if (typeof key !== 'string') throw new LxError('type', 'record key must be a string');
      if (!Object.prototype.hasOwnProperty.call(container, safeKey(key))) throw new LxError('bad-path', `record has no key '${key}'`);
      return container[key]!;
    }
    throw new LxError('type', 'get expects a record or list');
  }

  // functional state update
  if ('set' in n) {
    const updates = n.set as Record<string, LxNode>;
    // evaluate all exprs against the ORIGINAL state, then apply (functional).
    const evaluated = Object.entries(updates).map(([path, e]) => [path, evalNode(e, ctx)] as const);
    let next: StateValue = ctx.state;
    for (const [path, value] of evaluated) next = setPath(next, path, value);
    return next;
  }

  if ('call' in n) return evalCall(n.call as string, n.args as LxNode[], ctx);

  throw new LxError('unknown-node', `unknown LX node: ${JSON.stringify(node).slice(0, 80)}`);
}

function binNum(args: LxNode[], ctx: Ctx): [number, number] {
  return [asNumber(evalNode(args[0]!, ctx)), asNumber(evalNode(args[1]!, ctx))];
}

/** Evaluate a body once per element with iteration bindings layered on env. */
function evalBody(body: LxNode, ctx: Ctx, extra: Record<string, LxValue>): LxValue {
  return evalNode(body, { ...ctx, env: { ...ctx.env, ...extra } });
}

function evalCall(name: string, argNodes: LxNode[], ctx: Ctx): LxValue {
  const arity = ARITY[name];
  if (!arity) throw new LxError('unknown-call', `unknown std-lib call: ${name}`);
  if (argNodes.length < arity[0] || argNodes.length > arity[1]) {
    throw new LxError('arity', `${name} expects ${arity[1] === Infinity ? `≥${arity[0]}` : arity[0] === arity[1] ? arity[0] : `${arity[0]}–${arity[1]}`} args, got ${argNodes.length}`);
  }
  switch (name) {
    case 'range': {
      const len = asNumber(evalNode(argNodes[0]!, ctx));
      if (!Number.isInteger(len) || len < 0 || len > MAX_RANGE) throw new LxError('bounds', `range(${len}) out of bounds`);
      chargeSize(ctx, len);
      return Array.from({ length: len }, (_, i) => i);
    }
    case 'map': {
      const coll = asList(evalNode(argNodes[0]!, ctx));
      if (coll.length > MAX_ITERATIONS) throw new LxError('bounds', 'map over too many items');
      chargeSize(ctx, coll.length);
      const body = argNodes[1]!;
      return coll.map((it, idx) => evalBody(body, ctx, { it, idx }));
    }
    case 'filter': {
      const coll = asList(evalNode(argNodes[0]!, ctx));
      if (coll.length > MAX_ITERATIONS) throw new LxError('bounds', 'filter over too many items');
      chargeSize(ctx, coll.length);
      const pred = argNodes[1]!;
      return coll.filter((it, idx) => asBool(evalBody(pred, ctx, { it, idx })));
    }
    case 'fold': {
      const coll = asList(evalNode(argNodes[0]!, ctx));
      if (coll.length > MAX_ITERATIONS) throw new LxError('bounds', 'fold over too many items');
      burn(ctx, coll.length);
      let acc = evalNode(argNodes[1]!, ctx);
      const body = argNodes[2]!;
      coll.forEach((it, idx) => { acc = evalBody(body, ctx, { acc, it, idx }); });
      return acc;
    }
    case 'len': {
      const v = evalNode(argNodes[0]!, ctx);
      if (Array.isArray(v)) return v.length;
      if (typeof v === 'string') return v.length;
      throw new LxError('type', 'len expects list or string');
    }
    case 'min': return Math.min(...argNodes.map((a) => asNumber(evalNode(a, ctx))));
    case 'max': return Math.max(...argNodes.map((a) => asNumber(evalNode(a, ctx))));
    case 'clamp': { const [v, lo, hi] = argNodes.map((a) => asNumber(evalNode(a, ctx))) as [number, number, number]; return Math.min(hi, Math.max(lo, v)); }
    case 'abs': return Math.abs(asNumber(evalNode(argNodes[0]!, ctx)));
    case 'floor': return Math.floor(asNumber(evalNode(argNodes[0]!, ctx)));
    case 'ceil': return Math.ceil(asNumber(evalNode(argNodes[0]!, ctx)));
    case 'round': return Math.round(asNumber(evalNode(argNodes[0]!, ctx)));
    case 'sqrt': { const x = asNumber(evalNode(argNodes[0]!, ctx)); if (x < 0) throw new LxError('bounds', 'sqrt of negative'); return Math.sqrt(x); }
    case 'sign': return Math.sign(asNumber(evalNode(argNodes[0]!, ctx)));
    case 'pow': { const [b, e] = binNum(argNodes, ctx); return fin(b ** e); }
    case 'concat': {
      const parts = argNodes.map((a) => evalNode(a, ctx));
      // require homogeneous args — all lists OR all strings (F9: no silent
      // list→JSON-text coercion on a mixed call).
      if (parts.every((p) => Array.isArray(p))) {
        const total = (parts as LxValue[][]).reduce((s, p) => s + p.length, 0);
        chargeSize(ctx, total);
        return (parts as LxValue[][]).flat();
      }
      if (parts.every((p) => typeof p === 'string')) {
        const total = (parts as string[]).reduce((s, p) => s + p.length, 0);
        chargeSize(ctx, total);
        return (parts as string[]).join('');
      }
      throw new LxError('type', 'concat expects all lists or all strings');
    }
    case 'slice': { const list = asList(evalNode(argNodes[0]!, ctx)); const start = asNumber(evalNode(argNodes[1]!, ctx)); const end = argNodes[2] ? asNumber(evalNode(argNodes[2], ctx)) : list.length; return list.slice(start, end); }
    case 'contains': { const list = asList(evalNode(argNodes[0]!, ctx)); const target = evalNode(argNodes[1]!, ctx); return list.some((x) => deepEqual(x, target)); }
    case 'indexOf': { const list = asList(evalNode(argNodes[0]!, ctx)); const target = evalNode(argNodes[1]!, ctx); return list.findIndex((x) => deepEqual(x, target)); }
    case 'keys': { const v = evalNode(argNodes[0]!, ctx); if (!isRecord(v)) throw new LxError('type', 'keys expects record'); return Object.keys(v); }
    case 'values': { const v = evalNode(argNodes[0]!, ctx); if (!isRecord(v)) throw new LxError('type', 'values expects record'); return Object.values(v); }
    case 'upper': return asString(evalNode(argNodes[0]!, ctx)).toUpperCase();
    case 'lower': return asString(evalNode(argNodes[0]!, ctx)).toLowerCase();
    case 'pad': { const s = asString(evalNode(argNodes[0]!, ctx)); const width = asNumber(evalNode(argNodes[1]!, ctx)); if (!Number.isInteger(width) || width < 0) throw new LxError('bounds', 'pad width must be a non-negative int'); chargeSize(ctx, width); const fill = argNodes[2] ? asString(evalNode(argNodes[2], ctx)) : ' '; return s.padStart(width, fill); }
    case 'fmt': { const v = evalNode(argNodes[0]!, ctx); return typeof v === 'string' ? v : JSON.stringify(v); }
    case 'random': return ctx.rng();
    case 'now': return ctx.now;
    default: throw new LxError('unknown-call', `unknown std-lib call: ${name}`);
  }
}

/** Evaluate an LX expression to a value (used by `view`). */
export function evaluate(node: LxNode, opts: EvalOptions): LxValue {
  const ctx: Ctx = {
    state: opts.state,
    event: opts.event ?? {},
    env: {},
    now: opts.now ?? 0,
    gas: { n: opts.gas ?? DEFAULT_GAS },
    depth: 0,
    rng: mulberry32(opts.seed ?? 0),
  };
  return evalNode(node, ctx);
}

/** Run a transition `(state, event) -> state`. The result MUST be a record
 *  (the new state); otherwise the transition is invalid (§2.5). */
export function runTransition(node: LxNode, opts: EvalOptions): StateValue {
  const result = evaluate(node, opts);
  if (!isRecord(result)) throw new LxError('type', 'a transition must return a state record');
  return result;
}
