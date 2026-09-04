/**
 * #1018 W1 — `get_chat_participants` merges the peer AGENTS the kernel
 * resolves for the calling agent, marked `kind: 'agent'` and carrying the
 * slug the discussion tools accept. Humans stay first, the mention example
 * stays human, and a failing peer lookup never costs a human mention.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChatParticipantsTool,
  turnContext,
} from '../packages/harness-orchestrator/src/index.js';
import type { ChatParticipant } from '../packages/harness-orchestrator/src/index.js';

const HUMAN: ChatParticipant = {
  channelUserId: '29:human',
  aadObjectId: 'aad-1',
  displayName: 'Jane Doe',
  email: 'jane@example.com',
  userPrincipalName: 'jane@example.com',
};

const PEER: ChatParticipant = {
  channelUserId: '28:app-fibu',
  aadObjectId: null,
  displayName: 'Messias',
  email: null,
  userPrincipalName: null,
  kind: 'agent',
  agentSlug: 'fibu',
};

async function run(tool: ChatParticipantsTool, humans: ChatParticipant[]): Promise<{
  participants: Array<{ displayName: string; kind: string; agentSlug?: string }>;
  usage_example: string;
}> {
  const raw = await turnContext.runWithChatParticipants(async () => humans, () => tool.handle());
  return JSON.parse(raw);
}

describe('get_chat_participants + peer agents (#1018)', () => {
  it('appends enabled peers as kind: agent with their slug; humans stay first and exemplary', async () => {
    const tool = new ChatParticipantsTool({ peerAgents: async () => [PEER] });
    const out = await run(tool, [HUMAN]);
    assert.deepEqual(
      out.participants.map((p) => [p.displayName, p.kind, p.agentSlug]),
      [
        ['Jane Doe', 'human', undefined],
        ['Messias', 'agent', 'fibu'],
      ],
    );
    assert.equal(out.usage_example, '<at>Jane Doe</at>');
  });

  it('without a peer provider the roster is humans-only and every entry reads kind: human', async () => {
    const out = await run(new ChatParticipantsTool(), [HUMAN]);
    assert.deepEqual(out.participants.map((p) => p.kind), ['human']);
  });

  it('a failing peer lookup degrades to the human roster, never to an error', async () => {
    const tool = new ChatParticipantsTool({
      peerAgents: async () => {
        throw new Error('policy store down');
      },
    });
    const out = await run(tool, [HUMAN]);
    assert.equal(out.participants.length, 1);
  });

  it('a peer already listed by the platform roster is not duplicated', async () => {
    const tool = new ChatParticipantsTool({ peerAgents: async () => [PEER] });
    const out = await run(tool, [HUMAN, { ...PEER, kind: undefined, agentSlug: undefined }]);
    assert.equal(out.participants.filter((p) => p.displayName === 'Messias').length, 1);
  });
});
