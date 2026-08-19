/**
 * #575 — the provider that makes the three guards non-inert.
 *
 * This is the end-to-end wiring test for the whole cluster: a roster becomes
 * Principals (#333 phase 1), Principals get roles (#333 phase 2), roles and
 * principals get capabilities (#575 grants), and the room gets the
 * intersection (#575 floor). The interesting assertions are the ones where a
 * gap anywhere in that chain has to close the floor rather than shrink it
 * quietly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAudienceFloorProvider } from '../packages/harness-orchestrator/src/audienceFloorProvider.js';
// Imported through the PACKAGE, not the source barrel. `audienceFloorProvider`
// resolves `@omadia/channel-sdk` to `dist/`, and TypeScript treats the same
// class reached via `src/` as a nominally different type — so a source-barrel
// import here fails to assign, with an error message that blames the wrong
// thing entirely.
import {
  InMemoryGrantStore,
  RoleSourceRegistry,
  floorPermits,
  makePrincipal,
  type Principal,
  type RoleLookup,
  type RoleSource,
} from '@omadia/channel-sdk';
import type { ChatParticipant } from '../packages/harness-orchestrator/src/chatParticipants.js';

const participant = (id: string): ChatParticipant => ({
  channelUserId: id,
  aadObjectId: null,
  displayName: id,
  email: null,
  userPrincipalName: null,
});

const byName = async (p: ChatParticipant): Promise<Principal | undefined> =>
  makePrincipal('user', p.channelUserId);

function rolesFor(map: Record<string, RoleLookup>): RoleSourceRegistry {
  const reg = new RoleSourceRegistry();
  const src: RoleSource = {
    id: 'test',
    displayName: 'test',
    rolesFor: async (principal) =>
      map[principal.kind === 'user' ? principal.userId : principal.roleKey] ?? {
        outcome: 'resolved',
        roles: [],
      },
  };
  reg.register(src);
  return reg;
}

describe('the floor is the intersection of everyone actually present', () => {
  it('two people keep only their shared capability', async () => {
    const grants = new InMemoryGrantStore()
      .grantToPrincipal({ kind: 'user', userId: 'alice' }, 'tool:a', 'tool:shared')
      .grantToPrincipal({ kind: 'user', userId: 'bob' }, 'tool:b', 'tool:shared');

    const floor = await createAudienceFloorProvider({
      participants: async () => [participant('alice'), participant('bob')],
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants,
    })();

    assert.equal(floorPermits(floor, 'tool:shared'), true);
    assert.equal(floorPermits(floor, 'tool:a'), false);
    assert.equal(floorPermits(floor, 'tool:b'), false);
  });

  it('role grants reach their holders', async () => {
    const grants = new InMemoryGrantStore().grantToRole('Approver', 'tool:approve');
    const floor = await createAudienceFloorProvider({
      participants: async () => [participant('alice')],
      resolvePrincipal: byName,
      roles: rolesFor({ alice: { outcome: 'resolved', roles: ['Approver'] } }),
      grants,
    })();
    assert.equal(floorPermits(floor, 'tool:approve'), true);
  });
});

describe('any gap in the chain closes the room', () => {
  const grants = () =>
    new InMemoryGrantStore().grantToPrincipal({ kind: 'user', userId: 'alice' }, 'tool:a');

  it('no roster accessor at all → closed', async () => {
    const floor = await createAudienceFloorProvider({
      participants: undefined,
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants: grants(),
    })();
    assert.equal(floor.outcome, 'closed');
  });

  it('an empty roster → closed, because the contract calls that unknown', async () => {
    const floor = await createAudienceFloorProvider({
      participants: async () => [],
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants: grants(),
    })();
    assert.match(floor.outcome === 'closed' ? floor.reason : '', /empty_roster/);
  });

  it('a roster accessor that throws → closed', async () => {
    const floor = await createAudienceFloorProvider({
      participants: async () => {
        throw new Error('graph down');
      },
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants: grants(),
    })();
    assert.match(floor.outcome === 'closed' ? floor.reason : '', /provider_failed/);
  });

  it('a participant who cannot be placed → closed, even though the other resolves', async () => {
    const floor = await createAudienceFloorProvider({
      participants: async () => [participant('alice'), participant('ghost')],
      resolvePrincipal: async (p) => (p.channelUserId === 'ghost' ? undefined : byName(p)),
      roles: rolesFor({}),
      grants: grants(),
    })();
    assert.equal(floor.outcome, 'closed');
  });

  it('an unreadable ROLE SOURCE closes it — the #333 partial chain reaching the floor', async () => {
    // The capability set would be a lower bound. A lower bound that looks like
    // policy is exactly what this whole cluster exists to prevent.
    const floor = await createAudienceFloorProvider({
      participants: async () => [participant('alice')],
      resolvePrincipal: byName,
      roles: rolesFor({
        alice: { outcome: 'unavailable', code: 'source_error', message: 'entra down' },
      }),
      grants: grants(),
    })();
    assert.equal(floor.outcome, 'closed');
    assert.equal(floorPermits(floor, 'tool:a'), false);
  });

  it('the same setup with a healthy role source opens it', async () => {
    // Control twin — without it the refusal above could be passing for an
    // unrelated reason.
    const floor = await createAudienceFloorProvider({
      participants: async () => [participant('alice')],
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants: grants(),
    })();
    assert.equal(floorPermits(floor, 'tool:a'), true);
  });
});

describe('it does not cache — otherwise the guards’ re-evaluation is theatre', () => {
  it('the roster is re-read on every evaluation', async () => {
    let reads = 0;
    const provider = createAudienceFloorProvider({
      participants: async () => {
        reads += 1;
        return [participant('alice')];
      },
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants: new InMemoryGrantStore().grantToPrincipal(
        { kind: 'user', userId: 'alice' },
        'tool:a',
      ),
    });
    await provider();
    await provider();
    await provider();
    assert.equal(reads, 3);
  });

  it('a mid-turn joiner narrows the floor on the NEXT evaluation', async () => {
    // The whole point of the egress guard re-computing per tool call. If this
    // provider memoized, that re-computation would keep returning the turn's
    // opening answer.
    let joined = false;
    const provider = createAudienceFloorProvider({
      participants: async () => (joined ? [participant('alice'), participant('bob')] : [participant('alice')]),
      resolvePrincipal: byName,
      roles: rolesFor({}),
      grants: new InMemoryGrantStore()
        .grantToPrincipal({ kind: 'user', userId: 'alice' }, 'tool:a')
        .grantToPrincipal({ kind: 'user', userId: 'bob' }, 'tool:other'),
    });

    assert.equal(floorPermits(await provider(), 'tool:a'), true);
    joined = true;
    assert.equal(floorPermits(await provider(), 'tool:a'), false, 'the joiner must narrow it');
  });
});
