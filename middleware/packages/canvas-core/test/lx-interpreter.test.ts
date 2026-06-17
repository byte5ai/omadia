import { describe, expect, it } from 'vitest';
import { evaluate, runTransition, LxError, type LxNode, type StateValue } from '../src/lx/index.js';
import { validateLumenSemantics } from '../src/lx/validate.js';

const ev = (node: LxNode, state: StateValue = {}, extra = {}) =>
  evaluate(node, { state, ...extra });

describe('LX interpreter — core evaluation', () => {
  it('literals, arithmetic, nesting', () => {
    expect(ev({ '+': [{ lit: 1 }, { '*': [{ lit: 2 }, { lit: 3 }] }] })).toBe(7);
    expect(ev({ '-': [{ lit: 10 }, { lit: 3 }, { lit: 2 }] })).toBe(5);
    expect(ev({ mod: [{ lit: 7 }, { lit: 3 }] })).toBe(1);
  });

  it('reads state by dotted path and grid by [x,y]', () => {
    expect(ev({ state: 'pos.x' }, { pos: { x: 5, y: 9 } })).toBe(5);
    const board = [[0, 0, 0], [0, 7, 0]];
    expect(ev({ state: 'board', at: [{ lit: 1 }, { lit: 1 }] }, { board })).toBe(7);
  });

  it('reads event fields (missing ⇒ 0)', () => {
    expect(ev({ event: 'key' }, {}, { event: { key: 42 } })).toBe(42);
    expect(ev({ event: 'absent' }, {}, { event: {} })).toBe(0);
  });

  it('total conditionals: if / match', () => {
    expect(ev({ if: { '>': [{ lit: 2 }, { lit: 1 }] }, then: { lit: 'a' }, else: { lit: 'b' } })).toBe('a');
    expect(ev({ match: { lit: 'x' }, cases: [{ when: { lit: 'x' }, then: { lit: 1 } }], else: { lit: 0 } })).toBe(1);
    expect(ev({ match: { lit: 'z' }, cases: [{ when: { lit: 'x' }, then: { lit: 1 } }], else: { lit: 0 } })).toBe(0);
  });

  it('let / var lexical binding', () => {
    expect(ev({ let: { n: { lit: 21 } }, in: { '*': [{ var: 'n' }, { lit: 2 }] } })).toBe(42);
  });

  it('deep equality for == / contains', () => {
    expect(ev({ '==': [{ lit: [1, 2] }, { lit: [1, 2] }] })).toBe(true);
    expect(ev({ call: 'contains', args: [{ lit: [1, 2, 3] }, { lit: 2 }] })).toBe(true);
  });
});

describe('LX interpreter — std-lib & iteration (no lambdas)', () => {
  it('range / map / filter / fold with it/idx/acc bindings', () => {
    expect(ev({ call: 'range', args: [{ lit: 4 }] })).toEqual([0, 1, 2, 3]);
    expect(ev({ call: 'map', args: [{ lit: [1, 2, 3] }, { '*': [{ var: 'it' }, { lit: 10 }] }] })).toEqual([10, 20, 30]);
    expect(ev({ call: 'filter', args: [{ lit: [1, 2, 3, 4] }, { '>': [{ var: 'it' }, { lit: 2 }] }] })).toEqual([3, 4]);
    expect(ev({ call: 'fold', args: [{ lit: [1, 2, 3, 4] }, { lit: 0 }, { '+': [{ var: 'acc' }, { var: 'it' }] }] })).toBe(10);
  });
  it('get projects record fields and list elements', () => {
    expect(ev({ get: { lit: { x: 10, y: 20 } }, key: { lit: 'y' } })).toBe(20);
    expect(ev({ get: { lit: [5, 6, 7] }, key: { lit: 2 } })).toBe(7);
  });
  it('get enables map-over-records reading a field of `it`', () => {
    const node: LxNode = { call: 'map', args: [{ state: 'rows' }, { get: { var: 'it' }, key: { lit: 'n' } }] };
    expect(ev(node, { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] })).toEqual([1, 2, 3]);
  });
  it('get on a missing key / out-of-range index is a typed error', () => {
    expect(() => ev({ get: { lit: { a: 1 } }, key: { lit: 'b' } })).toThrow(/no key/);
    expect(() => ev({ get: { lit: [1] }, key: { lit: 9 } })).toThrow(/out of range/);
  });

  it('string + math ops', () => {
    expect(ev({ call: 'upper', args: [{ lit: 'hi' }] })).toBe('HI');
    expect(ev({ call: 'clamp', args: [{ lit: 12 }, { lit: 0 }, { lit: 9 }] })).toBe(9);
    expect(ev({ call: 'pad', args: [{ lit: '7' }, { lit: 3 }, { lit: '0' }] })).toBe('007');
  });
});

describe('LX interpreter — determinism (replay / share)', () => {
  it('same seed ⇒ identical random sequence', () => {
    const node: LxNode = { list: [{ call: 'random', args: [] }, { call: 'random', args: [] }] };
    const a = evaluate(node, { state: {}, seed: 123 });
    const b = evaluate(node, { state: {}, seed: 123 });
    const c = evaluate(node, { state: {}, seed: 124 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
  it('now() returns the host-provided clock', () => {
    expect(evaluate({ call: 'now', args: [] }, { state: {}, now: 1000 })).toBe(1000);
  });
});

describe('LX interpreter — bounded & total (cannot hang the host)', () => {
  it('exhausting gas throws LxError(gas)', () => {
    // a huge range burns gas per element
    expect(() => evaluate({ call: 'range', args: [{ lit: 90000 }] }, { state: {}, gas: 1000 }))
      .toThrowError(LxError);
  });
  it('range beyond MAX_RANGE is rejected', () => {
    expect(() => ev({ call: 'range', args: [{ lit: 9_000_000 }] })).toThrow(/bounds/);
  });
  it('division by zero is a typed error, not NaN', () => {
    expect(() => ev({ '/': [{ lit: 1 }, { lit: 0 }] })).toThrow(/zero/);
  });
  it('unbound var is a typed error', () => {
    expect(() => ev({ var: 'ghost' })).toThrow(LxError);
  });

  it('rejects prototype-pollution via set path / record key / state read', () => {
    expect(() => runTransition({ set: { '__proto__.polluted': { lit: 1 } } }, { state: {} })).toThrow(/forbidden/);
    expect(() => runTransition({ set: { 'constructor.x': { lit: 1 } } }, { state: {} })).toThrow(/forbidden/);
    // real LX arrives via JSON.parse, which (unlike a JS object literal) keeps
    // `__proto__` as an OWN key — the case the guard must catch.
    expect(() => ev(JSON.parse('{ "record": { "__proto__": { "lit": 1 } } }') as LxNode)).toThrow(/forbidden/);
    expect(() => ev({ state: '__proto__' }, {})).toThrow(/forbidden/);
    // and the global prototype is untouched after an attempt
    try { runTransition({ set: { '__proto__.x': { lit: 9 } } }, { state: {} }); } catch { /* expected */ }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('LX interpreter — hardening (adversarial review fixes)', () => {
  it('F1: concat-doubling cannot explode memory under low gas (size is charged)', () => {
    // 22 nested doublings would be 4M elements; size-charging must halt it.
    let node: LxNode = { lit: [0] };
    for (let i = 0; i < 28; i++) node = { call: 'concat', args: [node, node] };
    expect(() => evaluate(node, { state: {}, gas: 50_000 })).toThrow(/gas|cap/);
  });
  it('F1: pad cannot allocate a huge string cheaply', () => {
    expect(() => ev({ call: 'pad', args: [{ lit: 'x' }, { lit: 50_000_000 }] })).toThrow(/cap|gas/);
  });
  it('F1: map producing a giant result is bounded', () => {
    const big = { lit: Array.from({ length: 1000 }, (_, i) => i) };
    expect(() => evaluate({ call: 'map', args: [{ call: 'range', args: [{ lit: 100000 }] }, big] }, { state: {}, gas: 50_000 })).toThrow(/gas|cap/);
  });
  it('F3: a missing child node is a typed LxError, never a raw TypeError', () => {
    // simulate a node that slipped past the schema (no `else`); force the else
    // branch so the missing child is actually evaluated.
    expect(() => ev({ if: { lit: false }, then: { lit: 1 } } as unknown as LxNode)).toThrow(LxError);
  });
  it('F4: a pathologically deep tree halts with LxError, not a stack overflow', () => {
    let node: LxNode = { lit: true };
    for (let i = 0; i < 5000; i++) node = { not: node };
    expect(() => ev(node)).toThrow(LxError);
  });
  it('F5: set cannot invent a new top-level state key', () => {
    expect(() => runTransition({ set: { ghost: { lit: 1 } } }, { state: { real: 0 } })).toThrow(/not a declared state key/);
  });
  it('F7: stdlib arity is enforced', () => {
    expect(() => ev({ call: 'min', args: [] })).toThrow(/expects/);
    expect(() => ev({ call: 'clamp', args: [{ lit: 5 }] })).toThrow(/expects/);
    expect(() => ev({ call: 'pow', args: [{ lit: 2 }] })).toThrow(/expects/);
  });
  it('F8: non-finite arithmetic results halt (determinism on JSON round-trip)', () => {
    expect(() => ev({ call: 'pow', args: [{ lit: 10 }, { lit: 1000 }] })).toThrow(/non-finite/);
    expect(() => ev({ '/': [{ lit: 1e308 }, { lit: 1e-308 }] })).toThrow(/non-finite/);
  });
  it('F8: -0 is normalised to 0', () => {
    expect(Object.is(ev({ '*': [{ lit: -1 }, { lit: 0 }] }), 0)).toBe(true);
  });
  it('F9: concat rejects a mixed list/string call', () => {
    expect(() => ev({ call: 'concat', args: [{ lit: [1, 2] }, { lit: 'x' }] })).toThrow(/all lists or all strings/);
  });
});

describe('LX transitions — functional state update', () => {
  it('set returns a NEW state; original is untouched', () => {
    const state = { count: 1, pos: { x: 0 } };
    const next = runTransition({ set: { count: { '+': [{ state: 'count' }, { lit: 1 }] } } }, { state });
    expect(next.count).toBe(2);
    expect(state.count).toBe(1); // immutability
  });
  it('nested set clones, does not mutate the original nested record', () => {
    const state = { pos: { x: 0, y: 0 } };
    const next = runTransition({ set: { 'pos.x': { lit: 9 } } }, { state }) as { pos: { x: number; y: number } };
    expect(next.pos.x).toBe(9);
    expect(next.pos.y).toBe(0);
    expect(state.pos.x).toBe(0);
  });
  it('a transition that does not return a record is invalid', () => {
    expect(() => runTransition({ lit: 5 }, { state: {} })).toThrow(/state record/);
  });
});

describe('LX static semantic validator', () => {
  const base = {
    state: { count: { type: 'int', init: 0 }, pos: { type: 'record', fields: { x: { type: 'int', init: 0 } }, init: {} } },
    transitions: { inc: { set: { count: { '+': [{ state: 'count' }, { lit: 1 }] } } } },
    view: { lit: 1 },
    events: [{ on: 'tap', run: 'inc' }],
  };
  it('accepts a coherent Lumen', () => {
    expect(validateLumenSemantics(base)).toMatchObject({ ok: true });
  });
  it('flags an event running an undeclared transition', () => {
    const r = validateLumenSemantics({ ...base, events: [{ on: 'tap', run: 'nope' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/undeclared transition 'nope'/);
  });
  it('flags a state path that does not resolve', () => {
    const r = validateLumenSemantics({ ...base, transitions: { inc: { set: { ghost: { lit: 1 } } } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/does not resolve/);
  });
  it('resolves a nested record path', () => {
    const r = validateLumenSemantics({ ...base, transitions: { mv: { set: { 'pos.x': { lit: 3 } } } }, events: [{ on: 'tap', run: 'mv' }] });
    expect(r.ok).toBe(true);
  });
  it('flags an unbound var in a transition body', () => {
    const r = validateLumenSemantics({ ...base, transitions: { inc: { set: { count: { var: 'x' } } } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/unbound var 'x'/);
  });
  it('F6: acc is NOT in scope in a map body (only fold binds it)', () => {
    const r = validateLumenSemantics({ ...base, transitions: { m: { set: { count: { call: 'map', args: [{ lit: [1] }, { var: 'acc' }] } } } }, events: [{ on: 'tap', run: 'm' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/unbound var 'acc'/);
  });
  it('F6: acc IS in scope in a fold body', () => {
    const r = validateLumenSemantics({ ...base, transitions: { f: { set: { count: { call: 'fold', args: [{ lit: [1] }, { lit: 0 }, { '+': [{ var: 'acc' }, { var: 'it' }] }] } } } }, events: [{ on: 'tap', run: 'f' }] });
    expect(r.ok).toBe(true);
  });
  it('it/idx are in scope inside a map body', () => {
    const r = validateLumenSemantics({
      ...base,
      state: { xs: { type: 'list', of: { type: 'int', init: 0 }, maxLen: 8, init: [] } },
      transitions: { dbl: { set: { xs: { call: 'map', args: [{ state: 'xs' }, { '*': [{ var: 'it' }, { lit: 2 }] }] } } } },
      events: [{ on: 'tap', run: 'dbl' }],
    });
    expect(r.ok).toBe(true);
  });
});
