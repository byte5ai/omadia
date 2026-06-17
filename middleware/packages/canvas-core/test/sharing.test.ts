import { describe, expect, it } from 'vitest';
import { stripTokensForShare, importShared, canvasOwnershipGroup } from '../src/capabilities/sharing.js';

// A Lumen carrying two assets via DataRefs with the AUTHOR's signed tokens.
const assetA = { id: 'pixel-1111111111111111', signedToken: 'AUTHOR-SECRET-A', expiresAt: '2999-01-01T00:00:00Z' };
const assetB = { id: 'pixel-2222222222222222', signedToken: 'AUTHOR-SECRET-B', expiresAt: '2999-01-01T00:00:00Z' };
const authored = {
  type: 'lumen',
  id: 'gallery',
  state: { hero: { type: 'dataRef', init: assetA } },
  view: { record: { type: { lit: 'scene' }, draw: { list: [{ record: { kind: { lit: 'sprite' }, dataRef: { lit: assetB } } }] } } },
  capabilities: [{ cap: 'tiles' }, { cap: 'generateAsset' }],
};

describe('stripTokensForShare (§9 assets travel by id, not token)', () => {
  it('removes every author signedToken/expiresAt, keeps the content id', () => {
    const { shared, assetIds } = stripTokensForShare(authored);
    const json = JSON.stringify(shared);
    expect(json).not.toContain('AUTHOR-SECRET-A');
    expect(json).not.toContain('AUTHOR-SECRET-B');
    expect(json).toContain('pixel-1111111111111111');
    expect(assetIds.sort()).toEqual(['pixel-1111111111111111', 'pixel-2222222222222222']);
  });
});

describe('importShared (§9 recipient-scoped re-mint + inert)', () => {
  const mint = (id: string, recipient: string) => ({ signedToken: `${recipient}:${id}`, expiresAt: '2999-01-01T00:00:00Z' });

  it('re-mints recipient-scoped tokens for authorised assets', () => {
    const { shared } = stripTokensForShare(authored);
    const res = importShared(shared, 'bob', { manifest: authored.capabilities, authorize: () => true, mint });
    const json = JSON.stringify(res.lumen);
    expect(json).toContain('bob:pixel-1111111111111111');
    expect(res.reminted.sort()).toEqual(['pixel-1111111111111111', 'pixel-2222222222222222']);
    expect(res.inert).toEqual([]);
  });

  it('renders an un-authorised asset inert (no borrowed token)', () => {
    const { shared } = stripTokensForShare(authored);
    const res = importShared(shared, 'bob', {
      manifest: authored.capabilities,
      authorize: (id) => id === 'pixel-1111111111111111', // bob may not access asset B
      mint,
    });
    expect(res.reminted).toEqual(['pixel-1111111111111111']);
    expect(res.inert).toEqual(['pixel-2222222222222222']);
    const json = JSON.stringify(res.lumen);
    expect(json).toContain('"inert":true'); // B marked inert
    expect(json).not.toContain('bob:pixel-2222222222222222'); // never minted for B
  });

  it('never trusts an inbound token even if one was smuggled in', () => {
    const smuggled = { type: 'lumen', id: 'x', view: { record: { dataRef: { lit: { id: 'pixel-3333333333333333', signedToken: 'STOLEN' } } } } };
    const res = importShared(smuggled, 'bob', { authorize: () => true, mint });
    expect(JSON.stringify(res.lumen)).not.toContain('STOLEN');
    expect(JSON.stringify(res.lumen)).toContain('bob:pixel-3333333333333333');
  });

  it('reports consent + importability from the capability manifest', () => {
    const { shared } = stripTokensForShare(authored);
    const res = importShared(shared, 'bob', { manifest: [{ cap: 'tiles' }, { cap: 'clipboard' }], authorize: () => true, mint });
    expect(res.importable).toBe(true);
    expect(res.consent.requiresConsent).toContain('clipboard');
    const bad = importShared(shared, 'bob', { manifest: [{ cap: 'exec' }], authorize: () => true, mint });
    expect(bad.importable).toBe(false);
  });
});

describe('canvasOwnershipGroup (§9)', () => {
  it('builds a deduped member group', () => {
    expect(canvasOwnershipGroup(['a', 'b', 'a'])).toEqual({ kind: 'group', members: ['a', 'b'] });
  });
});
