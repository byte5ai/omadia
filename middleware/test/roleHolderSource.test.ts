/**
 * #333 Phase 3 — role → holders from pluggable sources.
 *
 * The registry tests mirror phase 2's; the ones that earn their keep are at the
 * bottom, where a partial holder list meets Conductor's two decisions that fail
 * OPEN on one:
 *
 *   - `quorum='all'` completing with too few approvals, and
 *   - "role has no holder → take the fallback" skipping the human step.
 *
 * Both were unreachable while holders came only from the local table. This
 * phase makes them reachable, so it also has to make them safe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RoleHolderCatalog,
  RoleHolderRegistry,
  type HolderLookup,
  type RoleHolderSource,
} from '../packages/harness-channel-sdk/src/roleHolderSource.js';
import {
  LOCAL_ROLE_HOLDER_SOURCE_ID,
  buildRoleHolderRegistry,
  holdersOnly,
} from '../src/conductor/roleHolderResolver.js';

function source(id: string, lookup: HolderLookup | (() => Promise<HolderLookup>)): RoleHolderSource {
  return {
    id,
    displayName: id,
    holdersFor: typeof lookup === 'function' ? lookup : async () => lookup,
  };
}

const resolved = (...holders: string[]): HolderLookup => ({ outcome: 'resolved', holders });
const down = (): HolderLookup => ({
  outcome: 'unavailable',
  code: 'source_error',
  message: 'entra unreachable',
});

describe('a partial holder list is never mistaken for the truth', () => {
  it('a source that knows the role and reports nobody is NOT partial', async () => {
    const reg = new RoleHolderRegistry();
    reg.register(source('local', resolved()));
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, []);
    assert.equal(out.partial, false);
  });

  it('a source that cannot answer IS partial — with an identical empty list', async () => {
    // The two cases are indistinguishable by `holders` alone. That is the whole
    // reason `partial` exists: one legitimately triggers Conductor's fallback,
    // the other must never be allowed to.
    const reg = new RoleHolderRegistry();
    reg.register(source('entra', down()));
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, []);
    assert.equal(out.partial, true);
  });

  it('a plausible NON-empty list is still flagged when a source dropped out', async () => {
    // The dangerous shape: two holders come back, so nothing looks wrong, while
    // whoever the unreachable directory knows about is silently missing.
    const reg = new RoleHolderRegistry();
    reg.register(source('local', resolved('ada', 'grace')));
    reg.register(source('entra', down()));
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, ['ada', 'grace']);
    assert.equal(out.partial, true);
  });
});

describe('union semantics', () => {
  it('unions across sources, de-duplicates and sorts', async () => {
    const reg = new RoleHolderRegistry();
    reg.register(source('local', resolved('grace', 'ada')));
    reg.register(source('entra', resolved('ada', 'linus')));
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, ['ada', 'grace', 'linus']);
    assert.equal(out.partial, false);
  });

  it('canonicalizes holder ids with the USER rule — trim AND lowercase', async () => {
    // Holder ids are user principals, matched by a case-sensitive `=` in the
    // binding store. Role KEYS keep their case; holder ids must not, or an
    // operator-typed `Jane@Co.com` never matches the stored `jane@co.com`.
    const reg = new RoleHolderRegistry();
    reg.register(source('local', resolved('  Jane@Co.COM ', 'jane@co.com')));
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, ['jane@co.com']);
  });

  it('drops blank holder ids rather than admitting an unmatchable one', async () => {
    const reg = new RoleHolderRegistry();
    reg.register(source('local', resolved('', '  ', 'ada')));
    assert.deepEqual((await reg.resolveHolders('approver')).holders, ['ada']);
  });

  it('no active sources is a complete answer, not a partial one', async () => {
    const out = await new RoleHolderRegistry().resolveHolders('approver');
    assert.deepEqual(out, { holders: [], partial: false, bySource: [] });
  });
});

describe('a throwing source cannot take down a run', () => {
  it('becomes unavailable, stays visible, and does not suppress its peers', async () => {
    const reg = new RoleHolderRegistry();
    reg.register(
      source('entra', async () => {
        throw new Error('ECONNRESET');
      }),
    );
    reg.register(source('local', resolved('ada')));
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, ['ada']);
    assert.equal(out.partial, true);
    const entra = out.bySource.find((s) => s.sourceId === 'entra')?.lookup;
    assert.equal(entra?.outcome, 'unavailable');
    assert.match(entra?.outcome === 'unavailable' ? entra.message : '', /ECONNRESET/);
  });
});

describe('the catalog gate', () => {
  it('refuses an uncatalogued id and admits a catalogued one idempotently', () => {
    const catalog = new RoleHolderCatalog();
    const reg = new RoleHolderRegistry();
    assert.equal(reg.activate(catalog, 'entra'), false);
    catalog.add(source('entra', resolved()));
    assert.equal(reg.activate(catalog, 'entra'), true);
    assert.equal(reg.activate(catalog, 'entra'), true);
    assert.equal(reg.size(), 1);
  });
});

describe('Conductor composition', () => {
  const fakeStore = (holders: string[]) =>
    ({ resolve: async () => holders }) as unknown as Parameters<typeof buildRoleHolderRegistry>[0];

  it('registers the local assignment table as an ordinary source', async () => {
    const reg = buildRoleHolderRegistry(fakeStore(['ada']));
    assert.equal(reg.has(LOCAL_ROLE_HOLDER_SOURCE_ID), true);
    const out = await reg.resolveHolders('approver');
    assert.deepEqual(out.holders, ['ada']);
    assert.equal(out.partial, false);
  });

  it('local-only is never partial — today’s behaviour is unchanged', async () => {
    const out = await buildRoleHolderRegistry(fakeStore([])).resolveHolders('approver');
    assert.equal(out.partial, false);
  });

  it('an external source may not shadow the local one', () => {
    // Claiming `conductor-local` would substitute an attacker's approver list
    // for the assignment table. The id collision makes that a boot failure.
    assert.throws(
      () => buildRoleHolderRegistry(fakeStore(['ada']), [source(LOCAL_ROLE_HOLDER_SOURCE_ID, resolved('mallory'))]),
      /collision/,
    );
  });

  it('a failing LOCAL store surfaces as partial, not as "no holders"', async () => {
    const broken = {
      resolve: async () => {
        throw new Error('pool exhausted');
      },
    } as unknown as Parameters<typeof buildRoleHolderRegistry>[0];
    const out = await buildRoleHolderRegistry(broken).resolveHolders('approver');
    assert.deepEqual(out.holders, []);
    assert.equal(out.partial, true);
  });

  it('holdersOnly flattens for the consumers that may degrade', async () => {
    const reg = buildRoleHolderRegistry(fakeStore(['ada', 'grace']));
    assert.deepEqual(await holdersOnly((k) => reg.resolveHolders(k))('approver'), ['ada', 'grace']);
  });
});
