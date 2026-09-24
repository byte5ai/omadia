/**
 * #1018 W1 — the peer gate and the `chatPeerAgents@1` provider.
 *
 * The gate is the ONE evaluator of "may agent X talk to peers in chat Y";
 * every consumer (discussion start, every utterance, the roster) goes through
 * it. Pinned: AND semantics, deny-default on unknown agents / missing rows /
 * store failure, and the provider's rule that the CALLER must pass the gate
 * before any peer is shown at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChatPeerAgentsProvider, createPeerGate } from '../src/conductor/peerPolicy.js';

function agent(slug: string, id: string, agentToAgent?: 'off' | 'on') {
  return { agent: { id, slug, name: slug.toUpperCase(), agentToAgent } } as never;
}

const REGISTRY = {
  get: (slug: string) =>
    ({
      hr: agent('hr', 'id-hr', 'on'),
      fibu: agent('fibu', 'id-fibu', 'on'),
      legal: agent('legal', 'id-legal', 'off'),
    })[slug],
};

const POLICIES = [
  { channelType: 'teams', channelKey: 'chat-1', agentId: 'id-hr', agentToAgent: true },
  { channelType: 'teams', channelKey: 'chat-1', agentId: 'id-fibu', agentToAgent: false },
  { channelType: 'teams', channelKey: 'chat-1', agentId: 'id-legal', agentToAgent: true },
] as never[];

describe('createPeerGate', () => {
  const gate = createPeerGate({
    getRegistry: () => REGISTRY,
    listChannelPeerPolicies: async (_t, key) => (key === 'chat-1' ? POLICIES : []),
  });

  it('opens only when the agent switch is on AND the pair row is enabled', async () => {
    assert.equal(await gate('teams', 'chat-1', 'hr'), true);
    // switch on, pair row false
    assert.equal(await gate('teams', 'chat-1', 'fibu'), false);
    // pair row true, switch off
    assert.equal(await gate('teams', 'chat-1', 'legal'), false);
  });

  it('is deny-default: unknown agent, no row, no store, store failure', async () => {
    assert.equal(await gate('teams', 'chat-1', 'nobody'), false);
    assert.equal(await gate('teams', 'chat-2', 'hr'), false);
    const noStore = createPeerGate({ getRegistry: () => REGISTRY });
    assert.equal(await noStore('teams', 'chat-1', 'hr'), false);
    const logs: string[] = [];
    const broken = createPeerGate({
      getRegistry: () => REGISTRY,
      listChannelPeerPolicies: async () => {
        throw new Error('pg down');
      },
      log: (m) => logs.push(m),
    });
    assert.equal(await broken('teams', 'chat-1', 'hr'), false);
    assert.match(logs[0] ?? '', /peer-policy lookup .* failed: pg down/);
  });
});

describe('createChatPeerAgentsProvider', () => {
  const PRESENT = [
    { slug: 'hr', name: 'Karen', channelKey: '28:app-hr' },
    { slug: 'fibu', name: 'Messias', channelKey: '28:app-fibu' },
    { slug: 'legal', name: 'Clippy', channelKey: '28:app-legal' },
  ];
  const opener = (_t: string, key: string) =>
    PRESENT.find((p) => p.channelKey === key)?.slug;

  it('lists the peers that pass the gate, as kind: agent, never the caller', async () => {
    const provider = createChatPeerAgentsProvider({
      resolveTurn: () => ({ channelType: 'teams', conversationId: 'chat-1', botChannelKey: '28:app-hr' }),
      resolveOpener: opener,
      listPresent: async () => PRESENT,
      peerGate: async (_t, _c, slug) => slug === 'hr' || slug === 'legal',
    });
    const peers = await provider();
    assert.deepEqual(
      peers.map((p) => ({ slug: p.agentSlug, kind: p.kind, id: p.channelUserId, name: p.displayName })),
      [{ slug: 'legal', kind: 'agent', id: '28:app-legal', name: 'Clippy' }],
    );
  });

  it('shows nothing when the CALLER is not enabled, outside a turn, or for an unknown bot', async () => {
    const base = {
      resolveOpener: opener,
      listPresent: async () => PRESENT,
      peerGate: async (_t: string, _c: string, slug: string) => slug !== 'hr',
    };
    const callerOff = createChatPeerAgentsProvider({
      ...base,
      resolveTurn: () => ({ channelType: 'teams', conversationId: 'chat-1', botChannelKey: '28:app-hr' }),
    });
    assert.deepEqual(await callerOff(), []);
    const noTurn = createChatPeerAgentsProvider({ ...base, resolveTurn: () => undefined });
    assert.deepEqual(await noTurn(), []);
    const unknownBot = createChatPeerAgentsProvider({
      ...base,
      resolveTurn: () => ({ channelType: 'teams', conversationId: 'chat-1', botChannelKey: '28:stranger' }),
    });
    assert.deepEqual(await unknownBot(), []);
  });
});
