import { describe, expect, it } from 'vitest';
import {
  classifyEffect,
  reconcileDeclared,
  BrokerLimiter,
  DEFAULT_LIMITS,
  contentId,
  ContentAddressedStore,
  consentForManifest,
  manifestIsImportable,
} from '../src/capabilities/index.js';

describe('effect classification (§6)', () => {
  it('local/internal/external-effect base classes', () => {
    expect(classifyEffect('persist').effect).toBe('internal');
    expect(classifyEffect('clipboard')).toMatchObject({ effect: 'external-effect', needsConfirmation: true });
    expect(classifyEffect('tiles').needsConfirmation).toBe(false);
  });
  it('state-derived egress escalates to external-effect (confirmed)', () => {
    expect(classifyEffect('fetch', { stateDerived: false })).toMatchObject({ effect: 'internal', needsConfirmation: false });
    expect(classifyEffect('fetch', { stateDerived: true })).toMatchObject({ effect: 'external-effect', needsConfirmation: true });
  });
  it('pre-approval at grant keeps state-derived egress internal', () => {
    expect(classifyEffect('writeData', { stateDerived: true, preApproved: true }).effect).toBe('internal');
  });
  it('Tier-2 may upgrade a declared class, never downgrade it', () => {
    expect(reconcileDeclared('internal', 'external-effect')).toBe('external-effect');
    expect(reconcileDeclared('external-effect', 'internal')).toBe('external-effect'); // no downgrade
  });
});

describe('broker egress bounds (§6 anti-DoS/anti-cost)', () => {
  const limits = { ...DEFAULT_LIMITS, fetch: { ratePerWindow: 2, windowMs: 1000, quota: 3, maxInFlight: 2 } };

  it('admits within rate, then rejects on rate', () => {
    const b = new BrokerLimiter(limits);
    expect(b.admit('fetch', 'k1', 0)).toMatchObject({ ok: true });
    b.settle('fetch', 'k1');
    expect(b.admit('fetch', 'k2', 10)).toMatchObject({ ok: true });
    b.settle('fetch', 'k2');
    expect(b.admit('fetch', 'k3', 20)).toMatchObject({ ok: false, reason: 'rate' });
  });
  it('rolling window frees rate after windowMs', () => {
    const b = new BrokerLimiter(limits);
    b.admit('fetch', 'a', 0); b.settle('fetch', 'a');
    b.admit('fetch', 'b', 10); b.settle('fetch', 'b');
    expect(b.admit('fetch', 'c', 1100).ok).toBe(true); // window rolled past the first two
  });
  it('coalesces identical in-flight calls (idempotent dedup)', () => {
    const b = new BrokerLimiter(limits);
    expect(b.admit('fetch', 'same', 0)).toEqual({ ok: true, deduped: false });
    expect(b.admit('fetch', 'same', 1)).toEqual({ ok: true, deduped: true }); // no extra rate/quota spend
  });
  it('backpressure when max-in-flight is reached', () => {
    const b = new BrokerLimiter({ ...limits, fetch: { ratePerWindow: 99, windowMs: 1000, quota: 99, maxInFlight: 1 } });
    expect(b.admit('fetch', 'x', 0).ok).toBe(true); // in flight
    expect(b.admit('fetch', 'y', 1)).toMatchObject({ ok: false, reason: 'backpressure' });
    b.settle('fetch', 'x');
    expect(b.admit('fetch', 'y', 2).ok).toBe(true);
  });
  it('lifetime quota caps total calls (cost ceiling)', () => {
    const b = new BrokerLimiter(limits); // quota 3
    for (let i = 0; i < 3; i++) { expect(b.admit('fetch', `k${i}`, i * 600).ok).toBe(true); b.settle('fetch', `k${i}`); }
    expect(b.admit('fetch', 'k4', 3000)).toMatchObject({ ok: false, reason: 'quota' });
    expect(b.remaining('fetch')).toBe(0);
  });
});

describe('content-addressed assets (§6.1 never-stale by construction)', () => {
  it('same bytes → same id; different bytes → different id', () => {
    expect(contentId('pixel', 'hello')).toBe(contentId('pixel', 'hello'));
    expect(contentId('pixel', 'hello')).not.toBe(contentId('pixel', 'world'));
    expect(contentId('pixel', 'x')).toMatch(/^pixel-[0-9a-f]{16}$/);
  });
  it('rejects an invalid kind', () => {
    expect(() => contentId('PIXEL', 'x')).toThrow();
  });
  it('store dedups identical content and supports explicit invalidation', () => {
    const s = new ContentAddressedStore();
    const id1 = s.put('struct', 'data-A');
    const id2 = s.put('struct', 'data-A');
    expect(id1).toBe(id2);
    expect(s.size).toBe(1);
    expect(s.has(id1)).toBe(true);
    s.invalidate(id1);
    expect(s.has(id1)).toBe(false);
  });
  it('gc removes only expired AND unreferenced entries', () => {
    const s = new ContentAddressedStore();
    const live = s.put('struct', 'keep', '2020-01-01T00:00:00Z'); // expired
    s.retain(live);
    const dead = s.put('struct', 'drop', '2020-01-01T00:00:00Z'); // expired, unreferenced
    const fresh = s.put('struct', 'fresh', '2999-01-01T00:00:00Z'); // not expired
    const removed = s.gc('2026-06-15T00:00:00Z');
    expect(removed).toEqual([dead]);
    expect(s.has(live)).toBe(true); // referenced
    expect(s.has(fresh)).toBe(true); // not expired
  });
});

describe('import consent (§9 consent before first run)', () => {
  it('flags external-effect capabilities for explicit consent, shows all', () => {
    const report = consentForManifest([{ cap: 'tiles' }, { cap: 'fetch' }, { cap: 'clipboard' }, { cap: 'persist' }]);
    expect(report.shown.map((s) => s.cap).sort()).toEqual(['clipboard', 'fetch', 'persist', 'tiles']);
    expect(report.requiresConsent.sort()).toEqual(['clipboard', 'fetch']); // egress + external; tiles/persist internal
    expect(report.unknown).toEqual([]);
  });
  it('an unknown capability makes the Lumen un-importable (whitelist)', () => {
    const report = consentForManifest([{ cap: 'tiles' }, { cap: 'exec' }]);
    expect(report.unknown).toEqual(['exec']);
    expect(manifestIsImportable([{ cap: 'tiles' }, { cap: 'exec' }])).toBe(false);
    expect(manifestIsImportable([{ cap: 'tiles' }])).toBe(true);
  });
});
