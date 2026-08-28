/**
 * #575 Phase 2 — the audience floor and the grants behind it.
 *
 * "The intersection of the rights of everyone present" contains a trap: the
 * intersection of NOTHING is EVERYTHING. Almost every test below exists to pin
 * one of the ways that trap could be sprung, because each of them looks like a
 * reasonable default right up until it hands out a silent full grant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  audienceFloor,
  floorPermits,
  resolveAudience,
  type Audience,
  type AudienceMember,
  type Capability,
} from '../packages/harness-channel-sdk/src/audienceFloor.js';
import {
  InMemoryGrantStore,
  resolveCapabilities,
} from '../packages/harness-channel-sdk/src/grants.js';
import type { Principal } from '../packages/harness-channel-sdk/src/principal.js';
import {
  RoleSourceRegistry,
  type RoleLookup,
  type RoleSource,
} from '../packages/harness-channel-sdk/src/roleSource.js';

const alice: Principal = { kind: 'user', userId: 'alice' };
const bob: Principal = { kind: 'user', userId: 'bob' };

// `denials` is required on a resolved member (see `audienceFloor.ts`): an
// optional field that a caller forgets to thread would silently widen the
// floor. These cases are about the intersection, so they carry none.
const member = (principal: Principal, ...caps: Capability[]): AudienceMember => ({
  kind: 'resolved',
  principal,
  capabilities: new Set(caps),
  denials: new Set<Capability>(),
});

const known = (...members: AudienceMember[]): Audience => ({ kind: 'known', members });

describe('the intersection of nothing is never everything', () => {
  it('an unknown audience closes the floor', () => {
    for (const reason of ['no_provider', 'provider_failed', 'empty_roster'] as const) {
      const floor = audienceFloor({ kind: 'unknown', reason });
      assert.equal(floor.outcome, 'closed', reason);
      assert.equal(floorPermits(floor, 'tool:web_search'), false);
    }
  });

  it('a known audience with NO members closes rather than permitting everything', () => {
    // Reducing an empty list would yield "no constraints", i.e. a full grant.
    const floor = audienceFloor({ kind: 'known', members: [] });
    assert.equal(floor.outcome, 'closed');
  });

  it('one unresolvable participant closes the whole room', () => {
    // A guest with no directory record is present. Bounding only the people we
    // could identify is not bounding the room.
    const floor = audienceFloor(
      known(member(alice, 'tool:web_search'), { kind: 'unresolved', reason: 'guest' }),
    );
    assert.equal(floor.outcome, 'closed');
    assert.match(floor.outcome === 'closed' ? floor.reason : '', /could not be resolved/);
  });
});

describe('closed and empty-but-open are different answers', () => {
  it('an empty intersection is OPEN with nothing in it', () => {
    // Both permit nothing, but this one is a policy outcome and `closed` is an
    // outage. An operator staring at a blocked workflow needs to tell them apart.
    const floor = audienceFloor(known(member(alice, 'a'), member(bob, 'b')));
    assert.equal(floor.outcome, 'open');
    assert.equal(floor.outcome === 'open' ? floor.capabilities.size : -1, 0);
    assert.equal(floorPermits(floor, 'a'), false);
  });
});

describe('the intersection itself', () => {
  it('keeps only what everyone present may do', () => {
    const floor = audienceFloor(
      known(member(alice, 'read', 'write', 'admin'), member(bob, 'read', 'write')),
    );
    assert.deepEqual(
      floor.outcome === 'open' ? [...floor.capabilities].sort() : null,
      ['read', 'write'],
    );
  });

  it('a single participant keeps their own capabilities', () => {
    const floor = audienceFloor(known(member(alice, 'read')));
    assert.equal(floorPermits(floor, 'read'), true);
  });

  it('adding a less-privileged person can only shrink the floor', () => {
    const before = audienceFloor(known(member(alice, 'read', 'write')));
    const after = audienceFloor(known(member(alice, 'read', 'write'), member(bob, 'read')));
    assert.equal(floorPermits(before, 'write'), true);
    assert.equal(floorPermits(after, 'write'), false, 'a joiner must never widen the floor');
    assert.equal(floorPermits(after, 'read'), true);
  });
});

describe('resolveAudience refuses to invent a room', () => {
  const join = async (p: string) =>
    p === 'unknown-person'
      ? undefined
      : {
          principal: { kind: 'user' as const, userId: p },
          capabilities: new Set(['read']),
          denials: new Set<Capability>(),
        };

  it('no provider installed → unknown, not an empty room', async () => {
    // HTTP and web turns install no participant provider (spec §5.1).
    assert.deepEqual(await resolveAudience(undefined, join), { kind: 'unknown', reason: 'no_provider' });
  });

  it('an EMPTY roster → unknown, because that is what the provider contract says', async () => {
    // `ChatParticipantsProvider`: "returning an empty array is a valid
    // unknown / unavailable state". Reading it as "the room is empty" is the
    // silent full grant.
    assert.deepEqual(await resolveAudience([], join), { kind: 'unknown', reason: 'empty_roster' });
  });

  it('a participant the join cannot place becomes unresolved, not dropped', async () => {
    const audience = await resolveAudience(['alice', 'unknown-person'], join);
    assert.equal(audience.kind, 'known');
    assert.equal(audienceFloor(audience).outcome, 'closed');
  });

  it('a throwing join becomes unresolved rather than failing the turn', async () => {
    const audience = await resolveAudience(['alice'], async () => {
      throw new Error('graph down');
    });
    assert.equal(audience.kind, 'known');
    const floor = audienceFloor(audience);
    assert.equal(floor.outcome, 'closed');
  });
});

// ─── grants ────────────────────────────────────────────────────────────────

function rolesReturning(lookup: RoleLookup): RoleSourceRegistry {
  const reg = new RoleSourceRegistry();
  const src: RoleSource = { id: 's', displayName: 's', rolesFor: async () => lookup };
  reg.register(src);
  return reg;
}

describe('capabilities union within one principal', () => {
  it('direct grants and every role grant are unioned', async () => {
    const grants = new InMemoryGrantStore()
      .grantToPrincipal(alice, 'direct:1')
      .grantToRole('Approver', 'role:approve')
      .grantToRole('Reviewer', 'role:review');
    const roles = rolesReturning({ outcome: 'resolved', roles: ['Approver', 'Reviewer'] });

    const resolved = await resolveCapabilities(alice, roles, grants);
    assert.deepEqual([...(resolved?.capabilities ?? [])].sort(), [
      'direct:1',
      'role:approve',
      'role:review',
    ]);
  });

  it('role grants are looked up with the role key’s case intact', async () => {
    // `createRole` writes keys verbatim; lowercasing the lookup would miss
    // every mixed-case grant row.
    const grants = new InMemoryGrantStore().grantToRole('Head-Of-Sales', 'role:sign');
    const roles = rolesReturning({ outcome: 'resolved', roles: ['Head-Of-Sales'] });
    const resolved = await resolveCapabilities(alice, roles, grants);
    assert.deepEqual([...(resolved?.capabilities ?? [])], ['role:sign']);
  });

  it('a principal with no grants resolves to an empty set — a real answer', async () => {
    const resolved = await resolveCapabilities(
      alice,
      rolesReturning({ outcome: 'resolved', roles: [] }),
      new InMemoryGrantStore(),
    );
    assert.ok(resolved, 'no grants is not the same as unresolvable');
    assert.equal(resolved?.capabilities.size, 0);
  });
});

describe('a lower bound is not an answer — the chain from #333 to the floor', () => {
  it('a PARTIAL role lookup makes the principal unresolvable', async () => {
    // The capability set would be a lower bound, and the floor cannot tell a
    // lower bound from policy once it is just a Set.
    const roles = rolesReturning({ outcome: 'unavailable', code: 'source_error', message: 'entra down' });
    const resolved = await resolveCapabilities(alice, roles, new InMemoryGrantStore());
    assert.equal(resolved, undefined);
  });

  it('and that closes the floor end-to-end, with a reason', async () => {
    // The whole point of the chain: a directory outage surfaces as a closed
    // room an operator can diagnose, not as a quietly stricter policy.
    const roles = rolesReturning({ outcome: 'unavailable', code: 'source_error', message: 'entra down' });
    const grants = new InMemoryGrantStore().grantToPrincipal(alice, 'tool:web_search');

    const audience = await resolveAudience([alice], (p) => resolveCapabilities(p, roles, grants));
    const floor = audienceFloor(audience);
    assert.equal(floor.outcome, 'closed');
    assert.equal(floorPermits(floor, 'tool:web_search'), false);
  });

  it('the same setup with a healthy source DOES open the floor', async () => {
    // Control twin: without it the refusal above could pass for an unrelated
    // reason and nobody would notice.
    const roles = rolesReturning({ outcome: 'resolved', roles: [] });
    const grants = new InMemoryGrantStore().grantToPrincipal(alice, 'tool:web_search');

    const audience = await resolveAudience([alice], (p) => resolveCapabilities(p, roles, grants));
    assert.equal(floorPermits(audienceFloor(audience), 'tool:web_search'), true);
  });

  it('a throwing grant store also makes the principal unresolvable', async () => {
    const broken = {
      directGrants: async () => {
        throw new Error('pg down');
      },
      roleGrants: async () => [],
    };
    const roles = rolesReturning({ outcome: 'resolved', roles: [] });
    assert.equal(await resolveCapabilities(alice, roles, broken), undefined);
  });
});

describe('a role principal is not an audience member', () => {
  it('resolves to undefined rather than being expanded into its holders', async () => {
    // Expansion is RoleHolderRegistry's job (#333 phase 3). Doing it here would
    // hide which of the two actually happened.
    const resolved = await resolveCapabilities(
      { kind: 'role', roleKey: 'approver' },
      rolesReturning({ outcome: 'resolved', roles: [] }),
      new InMemoryGrantStore(),
    );
    assert.equal(resolved, undefined);
  });
});
