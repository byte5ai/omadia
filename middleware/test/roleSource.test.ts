/**
 * #333 Phase 2 — role sources.
 *
 * The assertions that carry weight are the ones about **absence**. Everything
 * else here is plumbing; the bug this design exists to prevent is a consumer
 * being unable to tell "this user has no roles" from "we could not find out".
 * Read as the former, a directory outage silently strips entitlements; read as
 * the latter with a permissive default, it is a silent full grant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RoleSourceCatalog,
  RoleSourceRegistry,
  type RoleLookup,
  type RoleSource,
} from '../packages/harness-channel-sdk/src/roleSource.js';
import type { Principal } from '../packages/harness-channel-sdk/src/principal.js';

const alice: Principal = { kind: 'user', userId: 'alice' };

function source(id: string, lookup: RoleLookup | (() => Promise<RoleLookup>)): RoleSource {
  return {
    id,
    displayName: id,
    rolesFor: typeof lookup === 'function' ? lookup : async () => lookup,
  };
}

const resolved = (...roles: string[]): RoleLookup => ({ outcome: 'resolved', roles });
const unavailable = (): RoleLookup => ({
  outcome: 'unavailable',
  code: 'source_error',
  message: 'directory unreachable',
});

describe('absence is distinguishable from emptiness', () => {
  it('a source that resolves to NO roles is a complete answer — not partial', async () => {
    const reg = new RoleSourceRegistry();
    reg.register(source('entra', resolved()));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, []);
    assert.equal(out.partial, false);
  });

  it('a source that cannot answer marks the result partial — with the SAME empty roles', async () => {
    // Both cases yield `roles: []`. Only `partial` separates them, which is
    // exactly why it has to exist.
    const reg = new RoleSourceRegistry();
    reg.register(source('entra', unavailable()));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, []);
    assert.equal(out.partial, true);
  });

  it('one failing source among healthy ones still marks the whole result partial', async () => {
    // The dangerous case: roles come back non-empty, so a caller glancing at
    // `roles` alone sees a plausible answer that is missing an entire source.
    const reg = new RoleSourceRegistry();
    reg.register(source('entra', resolved('approver')));
    reg.register(source('odoo-hr', unavailable()));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, ['approver']);
    assert.equal(out.partial, true);
  });

  it('every source is reported individually, so an outage is diagnosable', async () => {
    const reg = new RoleSourceRegistry();
    reg.register(source('entra', resolved('a')));
    reg.register(source('odoo-hr', unavailable()));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.bySource.map((s) => s.sourceId), ['entra', 'odoo-hr']);
    assert.equal(out.bySource[1]?.lookup.outcome, 'unavailable');
  });
});

describe('a throwing source cannot fail the turn', () => {
  it('becomes unavailable rather than rejecting', async () => {
    const reg = new RoleSourceRegistry();
    reg.register(
      source('boom', async () => {
        throw new Error('socket hang up');
      }),
    );
    const out = await reg.resolveRoles(alice);
    assert.equal(out.partial, true);
    const lookup = out.bySource[0]?.lookup;
    assert.equal(lookup?.outcome, 'unavailable');
    // The cause survives into the operator-facing message.
    assert.match(lookup?.outcome === 'unavailable' ? lookup.message : '', /socket hang up/);
  });

  it('does not suppress the healthy sources alongside it', async () => {
    const reg = new RoleSourceRegistry();
    reg.register(
      source('boom', async () => {
        throw new Error('nope');
      }),
    );
    reg.register(source('entra', resolved('approver')));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, ['approver']);
  });
});

describe('merging', () => {
  it('de-duplicates across sources and sorts, so results are comparable', async () => {
    const reg = new RoleSourceRegistry();
    reg.register(source('a', resolved('reviewer', 'approver')));
    reg.register(source('b', resolved('approver', 'admin')));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, ['admin', 'approver', 'reviewer']);
  });

  it('canonicalizes role keys with the ROLE rule — trim only, case preserved', async () => {
    // Lowercasing here would stop matching the mixed-case keys `createRole`
    // writes verbatim; `Approver` and `approver` are genuinely different keys.
    const reg = new RoleSourceRegistry();
    reg.register(source('a', resolved('  Head-Of-Sales  ', 'approver')));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, ['Head-Of-Sales', 'approver']);
  });

  it('drops blank role keys rather than admitting an unmatchable one', async () => {
    const reg = new RoleSourceRegistry();
    reg.register(source('a', resolved('', '   ', 'real')));
    const out = await reg.resolveRoles(alice);
    assert.deepEqual(out.roles, ['real']);
  });

  it('no active sources is a complete answer, not a partial one', async () => {
    const out = await new RoleSourceRegistry().resolveRoles(alice);
    assert.deepEqual(out, { roles: [], partial: false, bySource: [] });
  });
});

describe('a role principal is a category error, and is short-circuited', () => {
  it('resolves to nothing WITHOUT consulting any source, and is not partial', async () => {
    // A role is an indirection over holders, not a subject with entitlements.
    // Letting a source answer would invite it to invent role nesting, which
    // #575 has not specified.
    let consulted = false;
    const reg = new RoleSourceRegistry();
    reg.register(
      source('entra', async () => {
        consulted = true;
        return resolved('should-not-appear');
      }),
    );
    const out = await reg.resolveRoles({ kind: 'role', roleKey: 'approver' });
    assert.equal(consulted, false);
    assert.deepEqual(out.roles, []);
    assert.equal(out.partial, false);
  });
});

describe('the catalog is an operator gate, not a formality', () => {
  it('activate refuses an id that is not catalogued', () => {
    const catalog = new RoleSourceCatalog();
    const reg = new RoleSourceRegistry();
    assert.equal(reg.activate(catalog, 'entra'), false);
    assert.equal(reg.size(), 0);
  });

  it('activate admits a catalogued id, and is idempotent', () => {
    const catalog = new RoleSourceCatalog();
    catalog.add(source('entra', resolved()));
    const reg = new RoleSourceRegistry();
    assert.equal(reg.activate(catalog, 'entra'), true);
    assert.equal(reg.activate(catalog, 'entra'), true);
    assert.equal(reg.size(), 1);
  });

  it('rejects duplicate ids in both catalog and registry', () => {
    const catalog = new RoleSourceCatalog();
    catalog.add(source('entra', resolved()));
    assert.throws(() => catalog.add(source('entra', resolved())), /collision/);

    const reg = new RoleSourceRegistry();
    reg.register(source('entra', resolved()));
    assert.throws(() => reg.register(source('entra', resolved())), /collision/);
  });

  it('unregister removes an active source', () => {
    const reg = new RoleSourceRegistry();
    reg.register(source('entra', resolved()));
    assert.equal(reg.unregister('entra'), true);
    assert.equal(reg.unregister('entra'), false);
    assert.equal(reg.has('entra'), false);
  });
});

describe('sources run concurrently, not one after another', () => {
  it('total time tracks the slowest source, not their sum', async () => {
    const delay = (ms: number, role: string): RoleSource =>
      source(`s-${role}`, async () => {
        await new Promise((r) => setTimeout(r, ms));
        return resolved(role);
      });
    const reg = new RoleSourceRegistry();
    for (const r of ['a', 'b', 'c', 'd']) reg.register(delay(60, r));

    const started = process.hrtime.bigint();
    const out = await reg.resolveRoles(alice);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.deepEqual(out.roles, ['a', 'b', 'c', 'd']);
    // Serial would be ~240ms. Generous bound so a loaded CI box cannot flake it,
    // while still failing outright if the awaits are serialised.
    assert.ok(elapsedMs < 200, `expected concurrent (<200ms), took ${elapsedMs.toFixed(0)}ms`);
  });
});
