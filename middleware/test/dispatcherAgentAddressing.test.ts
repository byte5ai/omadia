import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent } from '@omadia/channel-sdk';

import type { ChannelManifestBlock } from '../src/api/admin-v1.js';
import { createOrchestratorDispatcher } from '../src/channels/orchestratorDispatcher.js';

/**
 * #2059 — a canvas turn that names an agent reaches THAT agent's envelope,
 * with no model call in front of it. Missing / unknown / unavailable never
 * becomes another agent (spec 2042 §5.14, INV-7).
 */

const canvasBlock: ChannelManifestBlock = {
  transport: { kind: 'websocket', routes: [], verify_signature: false },
  capabilities: ['text', 'canvas'],
  adapters: ['text'],
  dispatch_service: 'canvasChatAgent',
};

function agentSaying(answer: string, seen: string[] = []): ChatAgent {
  return {
    chat: () => Promise.resolve({ text: answer }),
    async *chatStream(input) {
      await Promise.resolve();
      seen.push(input.userMessage);
      yield { type: 'done', answer, toolCalls: 0, iterations: 1 };
    },
  } as ChatAgent;
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const turnFor = (canvas: string, metadata: Record<string, unknown>) => ({
  scope: `canvas::${canvas}`,
  channelId: 'de.byte5.channel.omadia-ui',
  channelKey: canvas,
  userRef: { kind: 'custom' as const, id: 'u1', email: 'Mara@Example.com' },
  text: 'hello',
  metadata,
});

describe('createOrchestratorDispatcher — explicit agent addressing (#2059)', () => {
  const agents = { 'id-mira': agentSaying('mira'), 'id-jonas': agentSaying('jonas') } as const;

  function build(calls: { bundles: string[]; resolved: Array<Record<string, unknown>> }) {
    return createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: (service) => {
        calls.bundles.push(service);
        return { agent: agentSaying('canvas-model') };
      },
      channelTypeFor: () => 'canvas',
      resolveAgent: (agentId, target, context) => {
        calls.resolved.push({ agentId, ...target, ...context });
        const chatAgent = agents[agentId as keyof typeof agents];
        return chatAgent ? { decision: 'bound', chatAgent } : undefined;
      },
    });
  }

  it('two canvases, two agents: each turn reaches its own agent and no model sits in front', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    const dispatcher = build(calls);
    const a = await collect(dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira' })));
    const b = await collect(dispatcher.streamTurn(turnFor('c2', { agentId: 'id-jonas' })));
    assert.equal((a[0] as { answer: string }).answer, 'mira');
    assert.equal((b[0] as { answer: string }).answer, 'jonas');
    assert.deepEqual(calls.bundles, [], 'the canvas model/orchestrator bundle is never consulted');
    assert.deepEqual(
      calls.resolved.map((r) => [r['agentId'], r['channelType'], r['channelKey']]),
      [
        ['id-mira', 'canvas', 'c1'],
        ['id-jonas', 'canvas', 'c2'],
      ],
    );
  });

  it('routes by the sender principal in the one canonical form', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    await collect(build(calls).streamTurn(turnFor('c1', { agentId: 'id-mira', locale: 'de' })));
    assert.equal(calls.resolved[0]!['principal'], 'user:mara@example.com');
    assert.equal(calls.resolved[0]!['locale'], 'de');
  });

  it('an unknown agent id is a typed error, never another agent', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    const events = await collect(build(calls).streamTurn(turnFor('c1', { agentId: 'id-ghost' })));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'error');
    assert.deepEqual(calls.bundles, []);
  });

  it('a platform that cannot address by id refuses the turn', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: (s) => {
        calls.bundles.push(s);
        return { agent: agentSaying('x') };
      },
    });
    const events = await collect(dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira' })));
    assert.equal(events[0]!.type, 'error');
    assert.deepEqual(calls.bundles, []);
  });

  it('a reject answers through the resolver agent with its system notice', async () => {
    const seen: string[] = [];
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: () => undefined,
      resolveAgent: () => ({ decision: 'reject', chatAgent: agentSaying('Mira is disabled.', seen) }),
    });
    const events = await collect(dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira' })));
    assert.equal((events[0] as { answer: string }).answer, 'Mira is disabled.');
    assert.deepEqual(seen, ['hello']);
  });

  it('a turn without an agent id keeps the static dispatch_service route', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    const events = await collect(build(calls).streamTurn(turnFor('c1', {})));
    assert.equal((events[0] as { answer: string }).answer, 'canvas-model');
    assert.deepEqual(calls.bundles, ['canvasChatAgent']);
    assert.deepEqual(calls.resolved, []);
  });

  it('a blank or non-string agent id counts as no address', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    const dispatcher = build(calls);
    await collect(dispatcher.streamTurn(turnFor('c1', { agentId: '   ' })));
    await collect(dispatcher.streamTurn(turnFor('c1', { agentId: 42 })));
    assert.deepEqual(calls.resolved, []);
  });
});
