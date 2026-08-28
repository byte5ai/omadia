/**
 * #333 Phase 1 — the turn seam produces a `Principal`.
 *
 * Spec §6: "#333 produces Principals. #575 consumes Principals and produces
 * decisions." `resolveTurnOwnerIdentity` is where a turn's caller becomes a
 * canonical omadia identity, so it is where the projection belongs — #575 must
 * never have to re-derive one.
 *
 * The two properties worth pinning:
 *
 *  1. The principal mirrors `omadiaUserId` and NOTHING ELSE. In particular an
 *     `authSubjectKey` present without a canonical id yields no principal — an
 *     IdP subject names an account at a provider, not a subject in omadia's id
 *     space, and substituting one for the other is a cross-space identity mixup.
 *  2. Absence stays absence. A turn with no resolvable identity gets no
 *     principal rather than a blank one, matching how `omadiaUserId` already
 *     fails closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTurnOwnerIdentity } from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';

type KgStub = Parameters<typeof resolveTurnOwnerIdentity>[0];

function knowledgeGraphReturning(result: {
  omadiaUserId?: string;
  clusterAuthSubject?: { providerUserId: string };
}): KgStub {
  return {
    resolveOrCreateChannelIdentity: async () => result,
  } as unknown as KgStub;
}

const channelInput = {
  userId: 'raw-channel-id',
  channelIdentity: { channelKind: 'teams', channelUserId: 'aad-oid-1' },
} as Parameters<typeof resolveTurnOwnerIdentity>[1];

describe('#333 — resolveTurnOwnerIdentity projects a Principal', () => {
  it('an HTTP turn: the canonical id becomes a user principal', async () => {
    const identity = await resolveTurnOwnerIdentity(undefined, { userId: 'USER-Uuid-1' });
    assert.equal(identity.omadiaUserId, 'USER-Uuid-1');
    // Canonicalized by `makePrincipal`, so it matches a stored binding row.
    assert.deepEqual(identity.principal, { kind: 'user', userId: 'user-uuid-1' });
  });

  it('a channel turn: the principal follows the RESOLVED id, not the raw channel id', async () => {
    // The whole point of the join — `raw-channel-id` must never become the
    // principal, or a dataset imported in Teams is unfindable by the same user.
    const identity = await resolveTurnOwnerIdentity(
      knowledgeGraphReturning({ omadiaUserId: 'canonical-uuid' }),
      channelInput,
    );
    assert.deepEqual(identity.principal, { kind: 'user', userId: 'canonical-uuid' });
  });

  it('an authSubjectKey WITHOUT a canonical id yields no principal', async () => {
    const identity = await resolveTurnOwnerIdentity(
      knowledgeGraphReturning({ clusterAuthSubject: { providerUserId: 'idp-sub-9' } }),
      channelInput,
    );
    assert.equal(identity.authSubjectKey, 'idp-sub-9');
    assert.equal(identity.principal, undefined);
  });

  it('no identity at all: no principal', async () => {
    assert.equal((await resolveTurnOwnerIdentity(undefined, { userId: '' })).principal, undefined);
    assert.equal((await resolveTurnOwnerIdentity(undefined, channelInput)).principal, undefined);
  });

  it('a resolution failure degrades to no principal, not a guessed one', async () => {
    const throwing = {
      resolveOrCreateChannelIdentity: async () => {
        throw new Error('graph down');
      },
    } as unknown as KgStub;
    const identity = await resolveTurnOwnerIdentity(throwing, channelInput);
    assert.deepEqual(identity, {});
  });
});
