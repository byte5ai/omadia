/**
 * Spec 2042 §5.2 (#2052) — Direct Line is gone. A message that starts with
 * `#<name>` is ordinary text for the agent the user is talking to: it reaches
 * that agent's model unchanged, and the harness neither dispatches it to the
 * named specialist nor answers with a directive notice. Pinned on both paths
 * (non-streaming `runTurn` — Teams — and streaming `chatStream` — web chat).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  createDomainTool,
  type ChatStreamEvent,
} from '../../packages/harness-orchestrator/src/index.js';

const MESSAGE = '#strategist what do you think?';
const MODEL_ANSWER = 'Here is what I think.';

function response(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** A model that records every request it receives and answers with plain text. */
function recordingProvider(requests: LlmRequest[]): LlmProvider {
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
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      requests.push(req);
      return response(MODEL_ANSWER);
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      requests.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: MODEL_ANSWER } as LlmStreamEvent;
          yield { type: 'final', response: response(MODEL_ANSWER) } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function setup(): { orch: Orchestrator; requests: LlmRequest[]; asked: string[] } {
  const requests: LlmRequest[] = [];
  const asked: string[] = [];
  const strategist = createDomainTool({
    name: 'ask_strategist',
    description: 'Strategy sparring partner',
    domain: 'strategy',
    agentId: 'de.byte5.agent.strategist',
    agent: {
      ask: async (question: string) => {
        asked.push(question);
        return 'strategist answer';
      },
    },
  });
  const orch = new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [strategist],
    nativeToolRegistry: new NativeToolRegistry(),
  });
  return { orch, requests, asked };
}

/** The text of the last user message of the turn's first model request. */
function lastUserText(requests: readonly LlmRequest[]): string {
  const first = requests[0];
  assert.ok(first, 'the current agent model never ran');
  const user = [...first.messages].reverse().find((m) => m.role === 'user');
  assert.ok(user, 'no user message in the model request');
  const content = user.content as unknown;
  if (typeof content === 'string') return content;
  return (content as ReadonlyArray<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

describe('#name text is ordinary text for the current agent (Direct Line removed)', () => {
  it('runTurn: the message reaches the model unchanged, no specialist is dispatched', async () => {
    const { orch, requests, asked } = setup();

    const result = await orch.runTurn({ userMessage: MESSAGE, sessionScope: 's-hash-1' });

    assert.ok(lastUserText(requests).includes(MESSAGE), 'the message was rewritten');
    assert.deepEqual(asked, [], 'the harness dispatched the named specialist');
    assert.ok(result.answer.includes(MODEL_ANSWER), "not the current agent's answer");
    assert.equal('delegatedAnswer' in result, false);
    assert.equal('directLineSession' in result, false);
  });

  it('chatStream: the message reaches the model unchanged, no specialist is dispatched', async () => {
    const { orch, requests, asked } = setup();

    const events: ChatStreamEvent[] = [];
    for await (const event of orch.chatStream({ userMessage: MESSAGE, sessionScope: 's-hash-2' })) {
      events.push(event);
    }
    const done = events.find((e) => e.type === 'done') as
      | Extract<ChatStreamEvent, { type: 'done' }>
      | undefined;

    assert.ok(lastUserText(requests).includes(MESSAGE), 'the message was rewritten');
    assert.deepEqual(asked, [], 'the harness dispatched the named specialist');
    assert.ok(done, 'no done event');
    assert.ok(done.answer.includes(MODEL_ANSWER), "not the current agent's answer");
    assert.equal('delegatedAnswer' in done, false);
    assert.equal('directLineSession' in done, false);
  });
});
