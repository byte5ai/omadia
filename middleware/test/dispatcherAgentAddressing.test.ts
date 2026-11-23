import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { admitModelCall } from '@omadia/llm-provider';
import {
  currentExecutionContext,
  resetModelGatewayForTests,
  setModelGatewayMode,
  uncoveredModelCalls,
} from '@omadia/usage-telemetry';

import type { ChannelResolveResult, ChatAgent, ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';

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

  it('two canvases, two agents: each turn is resolved for its own agent and handed to the service with that id', async () => {
    const calls = { bundles: [] as string[], resolved: [] as Array<Record<string, unknown>> };
    const dispatcher = build(calls);
    const a = await collect(dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira' })));
    const b = await collect(dispatcher.streamTurn(turnFor('c2', { agentId: 'id-jonas' })));
    // the service (canvasChatAgent) answers, inside the envelope named by `agentId`
    assert.equal((a[0] as { answer: string }).answer, 'canvas-model');
    assert.equal((b[0] as { answer: string }).answer, 'canvas-model');
    assert.deepEqual(calls.bundles, ['canvasChatAgent', 'canvasChatAgent']);
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

describe('createOrchestratorDispatcher — the canvas service takes an addressed turn (agentId)', () => {
  /** a service that records what it was handed, and a resolver that binds or rejects */
  function harness(opts: { decision?: 'bound' | 'reject'; service?: boolean } = {}) {
    const serviceInputs: ChatTurnInput[] = [];
    const agentInputs: ChatTurnInput[] = [];
    const service: ChatAgent = {
      chat: () => Promise.resolve({ text: 'service' }),
      async *chatStream(input: ChatTurnInput) {
        await Promise.resolve();
        serviceInputs.push(input);
        yield { type: 'done', answer: 'service', toolCalls: 0, iterations: 1 };
      },
    } as ChatAgent;
    const routedAgent: ChatAgent = {
      chat: () => Promise.resolve({ text: 'agent' }),
      async *chatStream(input: ChatTurnInput) {
        await Promise.resolve();
        agentInputs.push(input);
        yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 };
      },
    } as ChatAgent;
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: (name) => (name === 'canvasChatAgent' && opts.service !== false ? { agent: service } : undefined),
      channelTypeFor: () => 'canvas',
      resolveAgent: (): ChannelResolveResult => ({
        decision: opts.decision ?? 'bound',
        chatAgent: routedAgent,
      }),
    });
    return { dispatcher, serviceInputs, agentInputs };
  }

  const refresh = { basedOnRevision: '3', currentTree: { type: 'container' } };

  it('hands the checked agent id and the locale to the service, never the metadata value as a routing hint', async () => {
    const h = harness();
    const events = await collect(
      h.dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira', locale: 'de', canvasSessionId: 'cs1' })),
    );
    assert.equal((events[0] as { answer: string }).answer, 'service');
    assert.equal(h.serviceInputs.length, 1);
    assert.equal(h.serviceInputs[0]!.agentId, 'id-mira');
    assert.equal(h.serviceInputs[0]!.locale, 'de');
    assert.equal(h.serviceInputs[0]!.canvasSessionId, 'cs1');
    assert.equal(h.agentInputs.length, 0, 'the agent itself is not called directly');
  });

  it('a canvas_refresh with empty text reaches the service, never the agent as a model turn', async () => {
    const h = harness();
    const turn = { ...turnFor('c1', { agentId: 'id-mira', canvasSessionId: 'cs1', canvasRefresh: refresh }), text: '' };
    await collect(h.dispatcher.streamTurn(turn));
    assert.equal(h.serviceInputs.length, 1);
    assert.equal(h.serviceInputs[0]!.agentId, 'id-mira');
    assert.deepEqual(h.serviceInputs[0]!.canvasRefresh, refresh);
    assert.equal(h.agentInputs.length, 0);
  });

  it('without the service a canvas_refresh, an action and an empty canvas turn end in an error — the agent is never asked', async () => {
    const h = harness({ service: false });
    const base = { agentId: 'id-mira', canvasSessionId: 'cs1' };
    const turns = [
      { ...turnFor('c1', { ...base, canvasRefresh: refresh }), text: '' },
      { ...turnFor('c1', { ...base, action: { type: 'row_details' } }), text: 'Details' },
      { ...turnFor('c1', base), text: '   ' },
    ];
    for (const turn of turns) {
      const events = await collect(h.dispatcher.streamTurn(turn));
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'error');
      assert.equal((events[0] as { message: string }).message, 'canvas_helper_unavailable');
    }
    assert.equal(h.agentInputs.length, 0, 'no model turn with an empty or structured canvas input');
  });

  it('without the service a canvas turn with words still reaches the named agent (plain chat)', async () => {
    const h = harness({ service: false });
    const events = await collect(h.dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira', canvasSessionId: 'cs1' })));
    assert.equal((events[0] as { answer: string }).answer, 'agent');
    assert.equal(h.agentInputs[0]!.agentId, undefined, 'agentId is for the service only');
  });

  it('a refusal is answered by the management layer from system — also for a structured turn, with no service call', async () => {
    const h = harness({ decision: 'reject' });
    const turn = { ...turnFor('c1', { agentId: 'id-mira', canvasSessionId: 'cs1', canvasRefresh: refresh }), text: '' };
    const events = await collect(h.dispatcher.streamTurn(turn));
    assert.equal((events[0] as { answer: string }).answer, 'agent', 'the resolver agent (notice) answered');
    assert.equal(h.serviceInputs.length, 0, 'a refused agent never reaches the helper');
  });

  it('/agent commands stay with the management layer, not the helper', async () => {
    const h = harness();
    const turn = { ...turnFor('c1', { agentId: 'id-mira', canvasSessionId: 'cs1' }), text: '/agents' };
    const events = await collect(h.dispatcher.streamTurn(turn));
    assert.equal((events[0] as { answer: string }).answer, 'agent');
    assert.equal(h.serviceInputs.length, 0);
  });

  it('a turn that names no agent still goes to the service without an agentId (it refuses it itself)', async () => {
    const h = harness();
    await collect(h.dispatcher.streamTurn(turnFor('c1', { canvasSessionId: 'cs1' })));
    assert.equal(h.serviceInputs.length, 1);
    assert.equal(h.serviceInputs[0]!.agentId, undefined);
  });

  it('a client cannot smuggle an agentId past the check: it is set from the resolved address only', async () => {
    const h = harness();
    await collect(
      h.dispatcher.streamTurn(turnFor('c1', { agentId: 'id-mira', canvasSessionId: 'cs1', origin: { agentId: 'id-evil' } })),
    );
    assert.equal(h.serviceInputs[0]!.agentId, 'id-mira');
  });
});

describe('createOrchestratorDispatcher — the canvas helper runs in the addressed agent turn (spec 2042 §5.10)', () => {
  afterEach(() => resetModelGatewayForTests());

  /** A helper like the canvas one: its own model calls (skeleton, fast lane,
   *  decision model) happen before and after it runs the agent. */
  function helperCallingModels(contexts: Array<string | undefined>): ChatAgent {
    return {
      chat: () => Promise.resolve({ text: 'helper' }),
      async *chatStream() {
        admitModelCall('complete'); // skeleton, before the first event
        contexts.push(currentExecutionContext()?.agentSlug);
        await Promise.resolve();
        yield { type: 'text_delta', text: 'hi' };
        admitModelCall('complete'); // fast-lane planner, after a resume
        contexts.push(currentExecutionContext()?.agentSlug);
        yield { type: 'done', answer: 'helper', toolCalls: 0, iterations: 1 };
      },
    } as ChatAgent;
  }

  it('three addressed canvas turns: every helper model call is the agent turn, none is outside a context', async () => {
    setModelGatewayMode('enforce');
    const contexts: Array<string | undefined> = [];
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: () => ({ agent: helperCallingModels(contexts) }),
      channelTypeFor: () => 'canvas',
      resolveAgent: () => ({
        decision: 'bound',
        chatAgent: agentSaying('agent'),
        speaker: { kind: 'agent', agentId: 'id-clippy', slug: 'dark-clippy', displayName: 'Dark Clippy' },
      }),
    });
    for (let i = 0; i < 3; i += 1) {
      const events = await collect(
        dispatcher.streamTurn(turnFor(`c${String(i)}`, { agentId: 'id-clippy', canvasSessionId: `cs${String(i)}` })),
      );
      assert.equal(events.at(-1)?.type, 'done', 'no call was refused');
    }
    assert.deepEqual([...uncoveredModelCalls()], []);
    assert.deepEqual(contexts, Array(6).fill('dark-clippy'));
  });

  it('an unaddressed turn opens no agent turn for the service', async () => {
    setModelGatewayMode('observe');
    const contexts: Array<string | undefined> = [];
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: () => ({ agent: helperCallingModels(contexts) }),
    });
    await collect(dispatcher.streamTurn(turnFor('c1', { canvasSessionId: 'cs1' })));
    assert.deepEqual(contexts, [undefined, undefined]);
  });
});
