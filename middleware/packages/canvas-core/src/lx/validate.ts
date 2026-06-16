/**
 * omadia-canvas-protocol/1.1 — LX static semantic validator (lumens-spec.md §2.5).
 *
 * The structural whitelist lives in the JSON schema (validateLumen). This layer
 * adds the semantics JSON Schema cannot express:
 *   - every EventBinding.run names a declared transition (§4),
 *   - every `state`/`set` path resolves against the declared state schema (§1.1),
 *   - every `{var}` read is lexically bound (a `let`, or an iteration binding),
 *   - tick/timer bindings declare the field their `on` requires.
 * A Lumen is accepted only if BOTH layers pass; either failure ⇒ surface_error.
 */
import { MAX_DEPTH, type LxNode } from './types.js';

export interface SemanticResult {
  ok: boolean;
  errors: string[];
}

type StateLeaf = { type: string; fields?: Record<string, StateLeaf>; of?: StateLeaf };
type StateSchema = Record<string, StateLeaf>;

interface LumenShape {
  state: StateSchema;
  transitions: Record<string, LxNode>;
  view: LxNode;
  events: { on: string; run: string; rate?: number; everyMs?: number; key?: string }[];
}

/** Does a dotted path resolve through the declared state schema? */
function pathResolves(schema: StateSchema, path: string): boolean {
  const segs = path.split('.');
  let leaf: StateLeaf | undefined = schema[segs[0]!];
  for (let i = 1; i < segs.length && leaf; i++) {
    if (leaf.type === 'record' && leaf.fields) leaf = leaf.fields[segs[i]!];
    else if ((leaf.type === 'list' || leaf.type === 'grid') && leaf.of) leaf = leaf.of; // index/sub-field
    else return false;
  }
  return leaf !== undefined;
}

/** Walk an LX node, collecting path + var-scope errors. `scope` is the set of
 *  lexically-bound names in effect at this node. */
function walk(node: LxNode, schema: StateSchema, scope: Set<string>, errors: string[], depth = 0): void {
  if (node === null || typeof node !== 'object') return;
  // bound recursion (F4) — a deeply-nested tree would overflow the stack on the
  // validator's own pass before the interpreter ever ran.
  if (depth > MAX_DEPTH) {
    errors.push('expression nesting too deep');
    return;
  }
  const d = depth + 1;
  const n = node as Record<string, unknown>;

  if ('state' in n && typeof n.state === 'string') {
    if (!pathResolves(schema, n.state)) errors.push(`state path '${n.state}' does not resolve against the state schema`);
    if (Array.isArray(n.at)) for (const e of n.at) walk(e as LxNode, schema, scope, errors, d);
    return;
  }
  if ('var' in n && typeof n.var === 'string') {
    if (!scope.has(n.var)) errors.push(`unbound var '${n.var}'`);
    return;
  }
  if ('let' in n && n.let && typeof n.let === 'object') {
    const binding = n.let as Record<string, LxNode>;
    const [name] = Object.keys(binding);
    walk(binding[name!]!, schema, scope, errors, d);
    walk(n.in as LxNode, schema, new Set([...scope, name!]), errors, d);
    return;
  }
  if ('set' in n && n.set && typeof n.set === 'object') {
    for (const [path, e] of Object.entries(n.set as Record<string, LxNode>)) {
      if (!pathResolves(schema, path)) errors.push(`set path '${path}' does not resolve against the state schema`);
      walk(e, schema, scope, errors, d);
    }
    return;
  }
  if ('call' in n && Array.isArray(n.args)) {
    const fn = n.call;
    // map/filter bind it/idx in arg[1]; fold binds acc/it/idx in arg[2]. The
    // interpreter binds `acc` ONLY for fold, so the validator must too (F6) —
    // else {var:acc} in a map body passes validation but throws at runtime.
    const mapScope = new Set([...scope, 'it', 'idx']);
    const foldScope = new Set([...scope, 'it', 'idx', 'acc']);
    n.args.forEach((arg, i) => {
      const bodyScope =
        (fn === 'map' || fn === 'filter') && i === 1 ? mapScope : fn === 'fold' && i === 2 ? foldScope : scope;
      walk(arg as LxNode, schema, bodyScope, errors, d);
    });
    return;
  }

  // generic recursion over any nested node/array values
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) for (const v of value) walk(v as LxNode, schema, scope, errors, d);
    else if (value && typeof value === 'object') walk(value as LxNode, schema, scope, errors, d);
  }
}

/** Validate the semantic layer of an already structurally-valid Lumen. */
export function validateLumenSemantics(lumen: unknown): SemanticResult {
  const errors: string[] = [];
  const l = lumen as Partial<LumenShape>;
  const schema = (l.state ?? {}) as StateSchema;
  const transitions = (l.transitions ?? {}) as Record<string, LxNode>;
  const transitionNames = new Set(Object.keys(transitions));

  for (const [name, body] of Object.entries(transitions)) {
    const sub: string[] = [];
    walk(body, schema, new Set(), sub);
    for (const e of sub) errors.push(`transition '${name}': ${e}`);
  }
  if (l.view) {
    const sub: string[] = [];
    walk(l.view, schema, new Set(), sub);
    for (const e of sub) errors.push(`view: ${e}`);
  }
  for (const ev of l.events ?? []) {
    if (!transitionNames.has(ev.run)) errors.push(`event '${ev.on}' runs undeclared transition '${ev.run}'`);
    if (ev.on === 'tick' && ev.rate === undefined) errors.push(`tick event must declare a 'rate'`);
    if (ev.on === 'timer' && ev.everyMs === undefined) errors.push(`timer event must declare 'everyMs'`);
    if (ev.on === 'key' && ev.key === undefined) errors.push(`key event must declare a 'key'`);
  }

  return { ok: errors.length === 0, errors };
}
