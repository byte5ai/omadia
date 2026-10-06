import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { ChatParticipant, ChatParticipantsProvider } from '@omadia/orchestrator';

import { resolveTurnAudience } from '../packages/harness-orchestrator/src/turnAudience.js';
import { parseSessionScope } from '../packages/harness-channel-sdk/src/scopeId.js';

/**
 * `resolveTurnAudience` — who is present in a turn's room, as canonical ids.
 * The cases that matter most are the ones that must come out `unknown`: a
 * wrong `known` audience is a leak, a wrong `unknown` only costs recall.
 */

const person = (aad: string, extra: Partial<ChatParticipant> = {}): ChatParticipant => ({
  channelUserId: `29:${aad}`,
  aadObjectId: aad,
  displayName: aad,
  email: null,
  userPrincipalName: null,
  ...extra,
});

const provider = (list: ChatParticipant[], complete: boolean): ChatParticipantsProvider =>
  Object.assign(async () => Promise.resolve(list), complete ? { completeRoster: true } : {});

const group = { channelType: 'teams', scope: parseSessionScope('msteams::conv-1') } as const;

describe('resolveTurnAudience', () => {
  it('a personal chat is the sender alone', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const audience = await resolveTurnAudience(
      kg,
      { userId: 'aad-a', origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'aad-a' } } },
      undefined,
    );
    assert.equal(audience.kind, 'known');
    assert.equal(audience.kind === 'known' ? audience.members.length : 0, 1);
  });

  it('an API key is a one-person room', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const audience = await resolveTurnAudience(
      kg,
      { userId: 'key:1', channelIdentity: { channelKind: 'api', channelUserId: 'key:1' } },
      undefined,
    );
    assert.equal(audience.kind, 'known');
  });

  it('a group with a complete roster is every member, sender included, as canonical ids', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const audience = await resolveTurnAudience(
      kg,
      { userId: 'aad-a', origin: group },
      provider([person('aad-a'), person('aad-b'), person('aad-c')], true),
    );
    assert.equal(audience.kind, 'known');
    const members = audience.kind === 'known' ? audience.members : [];
    assert.equal(members.length, 3);
    // The sender (keyed on the AAD id) and its roster entry (29: id beside the
    // AAD id) are one person, not two.
    const { omadiaUserId } = await kg.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: 'aad-a' });
    assert.ok(members.includes(omadiaUserId));
  });

  it('leaves agents out of the room', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const audience = await resolveTurnAudience(
      kg,
      { userId: 'aad-a', origin: group },
      provider([person('aad-a'), person('bot', { kind: 'agent', agentSlug: 'peer' })], true),
    );
    assert.equal(audience.kind === 'known' ? audience.members.length : -1, 1);
  });

  for (const [label, participants, input, reason] of [
    ['a roster not marked complete', provider([person('aad-a')], false), { userId: 'aad-a', origin: group }, 'roster-incomplete'],
    ['an empty roster', provider([], true), { userId: 'aad-a', origin: group }, 'roster-empty'],
    ['no roster at all', undefined, { userId: 'aad-a', origin: group }, 'no-roster'],
    ['no channel', undefined, { userId: 'aad-a' }, 'no-channel'],
    ['no sender', undefined, { origin: group }, 'no-sender'],
  ] as const) {
    it(`is unknown for ${label}`, async () => {
      const audience = await resolveTurnAudience(new InMemoryKnowledgeGraph(), input, participants);
      assert.deepEqual(audience, { kind: 'unknown', reason });
    });
  }

  it('is unknown without a knowledge graph', async () => {
    const audience = await resolveTurnAudience(undefined, { userId: 'aad-a', origin: group }, undefined);
    assert.deepEqual(audience, { kind: 'unknown', reason: 'no-knowledge-graph' });
  });

  it('is unknown when identity resolution fails', async () => {
    const kg = new InMemoryKnowledgeGraph();
    kg.resolveOrCreateChannelIdentity = async () => Promise.reject(new Error('db down'));
    const audience = await resolveTurnAudience(
      kg,
      { userId: 'aad-a', origin: group },
      provider([person('aad-a')], true),
    );
    assert.deepEqual(audience, { kind: 'unknown', reason: 'resolution-failed' });
  });
});
