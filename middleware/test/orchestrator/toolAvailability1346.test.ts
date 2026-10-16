/**
 * #1346 / #1086 — per-turn tool availability (`ToolRegistrationOptions.isAvailable`).
 *
 * A plugin tool that only some channels can serve (the discussion tools need a
 * Teams chat; `manage_routine` needs a routines principal) used to be offered
 * on every turn, so the model spent a round on a call that could only fail.
 * The registry now carries a per-turn predicate, and every ADVERTISEMENT site
 * honours it: the API-path tool list, the system-prompt tool docs, and the
 * list the subscription-CLI loopback / public MCP server advertise.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  ToolDispatchService,
  isOfferedThisTurn,
} from '../../packages/harness-orchestrator/src/index.js';

const finalTextStream: LlmStreamEvent[] = [
  { type: 'text_delta', text: 'done' },
  {
    type: 'final',
    response: {
      content: [{ type: 'text', text: 'done' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  },
];

function recordingProvider(seen: LlmRequest[]): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (): Promise<LlmResponse> => {
      throw new Error('complete() not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seen.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of finalTextStream) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

const TOOL = 'turn_bound_tool';
const DOC = 'turn_bound_tool — only works where the turn names a conversation.';

/** Stands in for a per-turn store such as `routineTurnContext`. */
const turnStore = new AsyncLocalStorage<{ conversation: string }>();

function registryWith(isAvailable?: () => boolean): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register(TOOL, {
    handler: async () => 'ok',
    spec: {
      name: TOOL,
      description: 'needs a conversation',
      input_schema: { type: 'object', properties: {} },
    },
    promptDoc: DOC,
    agentId: '@test/turn-bound',
    ...(isAvailable ? { isAvailable } : {}),
  });
  return registry;
}

const offeredWhenTurnHasConversation = (): boolean => turnStore.getStore() !== undefined;

async function runTurn(registry: NativeToolRegistry, inTurn: boolean): Promise<LlmRequest> {
  const seen: LlmRequest[] = [];
  const orchestrator = new Orchestrator({
    provider: recordingProvider(seen),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
  });
  const drain = async (): Promise<void> => {
    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }
  };
  if (inTurn) await turnStore.run({ conversation: 'c-1' }, drain);
  else await drain();
  const request = seen[0];
  assert.ok(request, 'provider received no request');
  return request;
}

const advertises = (request: LlmRequest): boolean =>
  (request.tools ?? []).some((tool) => tool.name === TOOL);
const describes = (request: LlmRequest): boolean =>
  JSON.stringify(request.system ?? '').includes('only works where the turn names a conversation');

describe('#1346 — isOfferedThisTurn', () => {
  it('offers a registration without a predicate', () => {
    assert.equal(isOfferedThisTurn({}), true);
  });

  it('follows the predicate', () => {
    assert.equal(isOfferedThisTurn({ isAvailable: () => true }), true);
    assert.equal(isOfferedThisTurn({ isAvailable: () => false }), false);
  });

  it('hides a tool whose predicate throws', () => {
    assert.equal(
      isOfferedThisTurn({
        isAvailable: () => {
          throw new Error('boom');
        },
      }),
      false,
    );
  });
});

describe('#1346 — the orchestrator hides a tool its predicate rules out', () => {
  it('hides spec AND prompt doc on a turn that cannot serve it', async () => {
    const request = await runTurn(registryWith(offeredWhenTurnHasConversation), false);
    assert.equal(advertises(request), false, 'the tool must not be in tools[]');
    assert.equal(describes(request), false, 'the promptDoc must not reach the system prompt');
  });

  it('offers spec AND prompt doc on a turn that can — evaluated inside the turn scope', async () => {
    const request = await runTurn(registryWith(offeredWhenTurnHasConversation), true);
    assert.equal(advertises(request), true);
    assert.equal(describes(request), true);
  });

  it('leaves a tool without a predicate untouched', async () => {
    const request = await runTurn(registryWith(), false);
    assert.equal(advertises(request), true);
    assert.equal(describes(request), true);
  });
});

describe('#1346 — the loopback / public-MCP list honours the predicate too', () => {
  const listed = (registry: NativeToolRegistry): string[] =>
    new ToolDispatchService({ nativeTools: registry })
      .listDispatchableToolSpecs()
      .map((spec) => spec.name);

  it('hides the tool outside a turn that can serve it', () => {
    assert.deepEqual(listed(registryWith(offeredWhenTurnHasConversation)), []);
  });

  it('lists it inside one', () => {
    const names = turnStore.run({ conversation: 'c-1' }, () =>
      listed(registryWith(offeredWhenTurnHasConversation)),
    );
    assert.deepEqual(names, [TOOL]);
  });

  it('dispatch is not gated — the handler still answers', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith(() => false),
    });
    const result = await service.dispatch(TOOL, {});
    assert.equal(result.content, 'ok');
  });
});
