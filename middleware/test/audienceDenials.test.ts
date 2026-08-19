/**
 * #575 — prohibitions: "allowlist ∩, denylist ∪" (spec §5.2).
 *
 * The floor already intersected allowances. What it had no notion of was a
 * PROHIBITION, and the two are not two spellings of one operation:
 *
 *  - an allowance says what a principal MAY do, so the room may do what
 *    *everyone* may do → intersect;
 *  - a prohibition says what a principal must not be party to, and it binds the
 *    room even when only one participant carries it → union.
 *
 * Both directions fail in a way that looks reasonable if you get them backwards,
 * so each has a test that only passes under the correct one:
 *
 *  - union applied to allowances hands the room the most permissive
 *    participant's rights;
 *  - intersection applied to prohibitions means a rule only bites when
 *    *everybody* is under it, which is the opposite of what a prohibition is.
 *
 * And the third property, which is why a denial is not simply "do not grant it":
 * a denial must SURVIVE a role that confers the same capability.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  audienceFloor,
  floorPermits,
  makePrincipal,
  resolveCapabilities,
  InMemoryGrantStore,
  RoleSourceCatalog,
  RoleSourceRegistry,
  type Audience,
  type Capability,
  type Principal,
  type RoleSource,
} from '../packages/harness-channel-sdk/src/index.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const BOB = makePrincipal('user', 'bob@example.com') as Principal;

function member(principal: Principal, allow: Capability[], deny: Capability[] = []) {
  return {
    kind: 'resolved' as const,
    principal,
    capabilities: new Set(allow),
    denials: new Set(deny),
  };
}

/** A role source that reports fixed roles for everyone. */
function rolesFor(roles: string[]): RoleSourceRegistry {
  const source: RoleSource = {
    id: 'test-roles',
    displayName: 'test roles',
    async rolesFor() {
      return { outcome: 'resolved', roles };
    },
  };
  const registry = new RoleSourceRegistry();
  registry.register(source);
  return registry;
}

describe('#575 the floor — allowances intersect, prohibitions union', () => {
  it('a prohibition carried by ONE participant binds the whole room', async () => {
    // Both may send email; Alice is explicitly forbidden. Under intersection
    // semantics for denials this would still be allowed — which is exactly the
    // bug this test exists to make impossible.
    const audience: Audience = {
      kind: 'known',
      members: [
        member(ALICE, ['tool:send_email'], ['tool:send_email']),
        member(BOB, ['tool:send_email']),
      ],
    };
    const floor = audienceFloor(audience);
    assert.equal(floor.outcome, 'open');
    assert.equal(floorPermits(floor, 'tool:send_email'), false);
  });

  it('still intersects allowances — one participant is not enough to permit', async () => {
    const floor = audienceFloor({
      kind: 'known',
      members: [member(ALICE, ['tool:send_email']), member(BOB, [])],
    });
    assert.equal(floorPermits(floor, 'tool:send_email'), false);
  });

  it('leaves untouched capabilities alone', async () => {
    const floor = audienceFloor({
      kind: 'known',
      members: [
        member(ALICE, ['tool:send_email', 'memory:recall'], ['tool:send_email']),
        member(BOB, ['tool:send_email', 'memory:recall']),
      ],
    });
    assert.equal(floorPermits(floor, 'tool:send_email'), false);
    assert.equal(floorPermits(floor, 'memory:recall'), true);
  });

  it('reads a prohibition even from a participant who was granted nothing', async () => {
    // A guest with no allowances at all still closes the room's email. If
    // denials were only collected from members that survived the intersection,
    // this veto would be dropped.
    const floor = audienceFloor({
      kind: 'known',
      members: [member(ALICE, ['tool:send_email']), member(BOB, [], ['tool:send_email'])],
    });
    assert.equal(floorPermits(floor, 'tool:send_email'), false);
  });
});

describe('#575 a denial overrides a grant rather than merely being absent from one', () => {
  it('survives a role that confers the same capability', async () => {
    // The reason a prohibition cannot be modelled as "just do not grant it":
    // an unrelated role assignment would silently lift it.
    const store = new InMemoryGrantStore()
      .grantToRole('approver', 'tool:send_email')
      .denyToPrincipal(ALICE, 'tool:send_email');

    const resolved = await resolveCapabilities(ALICE, rolesFor(['approver']), store);
    assert.ok(resolved);
    assert.equal(resolved.capabilities.has('tool:send_email'), true, 'the role still grants it');
    assert.equal(resolved.denials.has('tool:send_email'), true, 'and the denial still stands');

    const floor = audienceFloor({
      kind: 'known',
      members: [{ kind: 'resolved', ...resolved }],
    });
    assert.equal(floorPermits(floor, 'tool:send_email'), false, 'the denial must win');
  });

  it('carries a ROLE-level prohibition to everyone holding that role', async () => {
    const store = new InMemoryGrantStore()
      .grantToPrincipal(ALICE, 'tool:send_email')
      .denyToRole('contractor', 'tool:send_email');

    const resolved = await resolveCapabilities(ALICE, rolesFor(['contractor']), store);
    assert.ok(resolved);
    assert.equal(resolved.denials.has('tool:send_email'), true);
  });

  it('does not subtract the denial per principal — the floor must see it', async () => {
    // If `resolveCapabilities` applied denials itself, a veto would bind only
    // the person carrying it and the union across the audience would never
    // happen. The capability must still be present on the member.
    const store = new InMemoryGrantStore()
      .grantToPrincipal(ALICE, 'tool:send_email')
      .denyToPrincipal(ALICE, 'tool:send_email');

    const resolved = await resolveCapabilities(ALICE, new RoleSourceRegistry(), store);
    assert.ok(resolved);
    assert.equal(resolved.capabilities.has('tool:send_email'), true);
    assert.equal(resolved.denials.has('tool:send_email'), true);
  });
});

describe('#575 a store with no denial concept stays valid', () => {
  it('treats absent denial methods as "this implementation has none"', async () => {
    // Absence is a static property of the implementation — safe. A THROW would
    // mean the answer is unknown, which must close the floor instead; that is
    // pinned in audienceGrantStore.test.ts.
    const legacy = {
      async directGrants() {
        return ['tool:send_email'] as Capability[];
      },
      async roleGrants() {
        return [] as Capability[];
      },
    };
    const resolved = await resolveCapabilities(ALICE, new RoleSourceRegistry(), legacy);
    assert.ok(resolved);
    assert.equal(resolved.denials.size, 0);
    assert.equal(
      floorPermits(audienceFloor({ kind: 'known', members: [{ kind: 'resolved', ...resolved }] }), 'tool:send_email'),
      true,
    );
  });

  it('keeps the catalog/registry gate unchanged', () => {
    // Guard against this change accidentally widening the role-source surface.
    assert.equal(new RoleSourceCatalog().get('nope'), undefined);
  });
});
