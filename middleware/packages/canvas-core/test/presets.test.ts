import { describe, expect, it } from 'vitest';
import { canonicalize, presetId, shapeSignature, PresetRegistry, forkPreset } from '../src/capabilities/presets.js';

const lumenA = {
  type: 'lumen', id: 'counter',
  state: { count: { type: 'int', init: 0 } },
  transitions: { inc: { set: { count: { '+': [{ state: 'count' }, { lit: 1 }] } } } },
  view: { record: { type: { lit: 'scene' } } },
  events: [{ on: 'tap', run: 'inc' }],
};

describe('canonicalize + presetId (§8 content-addressed)', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it('same spec → same id; different spec → different id', () => {
    expect(presetId(lumenA)).toBe(presetId({ ...lumenA }));
    expect(presetId(lumenA)).toMatch(/^preset-[0-9a-f]{16}$/);
    expect(presetId(lumenA)).not.toBe(presetId({ ...lumenA, id: 'other', state: { count: { type: 'int', init: 5 } } }));
  });
  it('the preset provenance field does NOT affect the content id', () => {
    expect(presetId(lumenA)).toBe(presetId({ ...lumenA, preset: { id: 'preset-aaaaaaaaaaaaaaaa' } }));
  });
});

describe('resolve-then-generate (§8)', () => {
  it('exact content hit → instantiate', () => {
    const reg = new PresetRegistry();
    const id = reg.register(lumenA, 'tenant');
    expect(reg.resolve(lumenA)).toEqual({ kind: 'exact', id, scope: 'tenant' });
  });
  it('structural near-hit → fork+patch candidate, highest scope wins', () => {
    const reg = new PresetRegistry();
    reg.register({ ...lumenA, state: { count: { type: 'int', init: 9 } } }, 'user');
    const firstParty = reg.register({ ...lumenA, state: { count: { type: 'int', init: 3 } } }, 'first-party');
    const r = reg.resolve({ ...lumenA, state: { count: { type: 'int', init: 0 } } });
    expect(r.kind).toBe('near');
    if (r.kind === 'near') expect(r).toMatchObject({ id: firstParty, scope: 'first-party' });
  });
  it('miss → cold-author', () => {
    const reg = new PresetRegistry();
    reg.register(lumenA);
    expect(reg.resolve({ type: 'lumen', id: 'x', state: { totally: { type: 'bool', init: false } }, transitions: {}, view: { lit: 1 }, events: [] }).kind).toBe('miss');
  });
});

describe('forkPreset (copy-on-write lineage)', () => {
  it('produces a new id and records the parent', () => {
    const fork = forkPreset(lumenA, { state: { count: { type: 'int', init: 100 } } });
    expect(fork.parent).toBe(presetId(lumenA));
    expect(fork.id).not.toBe(fork.parent);
    expect((fork.spec.preset as { id: string; parent: string })).toEqual({ id: fork.id, parent: fork.parent });
    expect((fork.spec.state as { count: { init: number } }).count.init).toBe(100);
  });
  it('the forked id is stable & content-addressed (re-fork → same id)', () => {
    const a = forkPreset(lumenA, { state: { count: { type: 'int', init: 7 } } });
    const b = forkPreset(lumenA, { state: { count: { type: 'int', init: 7 } } });
    expect(a.id).toBe(b.id);
  });
});
