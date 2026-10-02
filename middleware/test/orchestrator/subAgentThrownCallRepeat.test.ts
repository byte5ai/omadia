/**
 * A sub-agent must not repeat a tool call that ended in an exception.
 *
 * An exception says nothing about how far a call got: a write can commit
 * upstream and its response then time out. Inside a `LocalSubAgent` a thrown
 * inner call is a tool result the sub-agent answers around (it used to abort
 * the run), so the sub-agent's model could call the same tool with the same
 * input again, and the write would run twice. `LocalSubAgentTool` carries no
 * write-capability metadata, so the loop refuses every identical repeat
 * (same tool, same canonical input) for the rest of the run, whether the
 * handler threw or its wrapper caught the exception and returned the withheld
 * notice. A different input, or a call that RETURNED an ordinary `Error:`
 * hint, still runs.
 *
 * Imported from SOURCE so a stale `dist/` cannot hide a change. All values are
 * synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { z } from 'zod';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { LocalSubAgentTool } from '@omadia/plugin-api';
import { LocalSubAgent } from '../../packages/harness-orchestrator/src/localSubAgent.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { bridgeTool } from '../../src/plugins/dynamicAgentRuntime.js';

const ANSWER = 'Ob die Adresse gespeichert wurde, ist unklar.';
const INPUT = { partner_id: 42, street: 'Musterweg 1' };
/** The same input with its keys in another order. */
const INPUT_SHUFFLED = { street: 'Musterweg 1', partner_id: 42 };

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;
const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

type Call = readonly [name: string, input: unknown];

function toolCalls(...calls: Call[]): LlmResponse {
  return {
    content: calls.map(([name, input], i) => ({
      type: 'tool_call',
      id: `use-${String(i)}-${name}`,
      name,
      input,
    })),
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function text(answer: string): LlmResponse {
  return {
    content: [{ type: 'text', text: answer }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** A scripted model; `seen` holds every request the sub-agent sent it. */
function scripted(responses: readonly LlmResponse[]): { provider: LlmProvider; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  let idx = 0;
  const next = (req: LlmRequest): LlmResponse => {
    seen.push(req);
    const response = responses[idx];
    idx += 1;
    if (!response) throw new Error('scripted provider: no response left');
    return response;
  };
  const provider = {
    id: 'anthropic',
    capabilities,
    complete: async (req: LlmRequest) => next(req),
    stream: (req: LlmRequest) => {
      const response = next(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, seen };
}

/** A privacy handle whose redactor passes text through and that records entries. */
function passThroughHandle(): PrivacyTurnHandle {
  return {
    async recordToolError() {},
    async redactToolErrorText({ text: body }: { text: string }) {
      return { outcome: 'redacted' as const, text: body, spans: [], degraded: false };
    },
    checkBypass: () => undefined,
    async internToolResultV4({ rawResult }: { rawResult: string }) {
      return { digestText: `«dataset» ${rawResult}`, datasetId: 'ds-1' };
    },
  } as unknown as PrivacyTurnHandle;
}

function subAgent(provider: LlmProvider, tools: LocalSubAgentTool[]): LocalSubAgent {
  return new LocalSubAgent({
    name: 'crm',
    provider,
    model: 'test',
    maxTokens: 1024,
    maxIterations: 6,
    systemPrompt: 'you are a test',
    tools,
  });
}

/** A write that commits, then loses its response: the handler throws AFTER the effect. */
function committingWrite(name: string, effects: unknown[]): LocalSubAgentTool {
  return {
    spec: {
      name,
      description: 'update a partner address',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    async handle(input: unknown) {
      effects.push(input);
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
  };
}

interface ToolResultBlock {
  readonly content: string;
  readonly isError: boolean;
}

/** Every `tool_result` the sub-agent handed its model, in order, without repeats. */
function toolResults(requests: readonly LlmRequest[]): ToolResultBlock[] {
  const last = requests[requests.length - 1];
  const out: ToolResultBlock[] = [];
  for (const message of (last?.messages ?? []) as unknown as Array<{ content?: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{
      type?: string;
      content?: unknown;
      isError?: boolean;
      is_error?: boolean;
    }>) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      out.push({ content: block.content, isError: block.isError === true || block.is_error === true });
    }
  }
  return out;
}

async function ask(agent: LocalSubAgent, privacy: PrivacyTurnHandle | undefined): Promise<string> {
  return turnContext.run(
    { turnId: 'turn-repeat', turnDate: '2026-10-01', ...(privacy ? { privacyHandle: privacy } : {}) },
    () => agent.ask('Ändere die Adresse von Partner 42.'),
  );
}

const REFUSAL = /^Error: tool `crm_write` was not called: an identical call \(same tool, same input\) ended in an exception earlier in this run/;

beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'log', () => {});
});
afterEach(() => {
  mock.restoreAll();
});

describe('LocalSubAgent — a call that ended in an exception is not repeated', () => {
  it('refuses the identical repeat of a thrown call: the write runs once', async () => {
    const effects: unknown[] = [];
    const { provider, seen } = scripted([
      toolCalls(['crm_write', INPUT]),
      toolCalls(['crm_write', INPUT_SHUFFLED]),
      text(ANSWER),
    ]);

    const answer = await ask(subAgent(provider, [committingWrite('crm_write', effects)]), passThroughHandle());

    assert.equal(answer, ANSWER);
    assert.equal(effects.length, 1, 'the write ran twice');
    const results = toolResults(seen);
    assert.equal(results.length, 2);
    assert.match(results[0]?.content ?? '', /^Error: tool `crm_write` failed with Error \(code ECONNRESET\)/);
    assert.match(results[0]?.content ?? '', /The outcome is unknown, so do not repeat a call that changes data\./);
    assert.match(results[1]?.content ?? '', REFUSAL);
    assert.equal(results[1]?.isError, true);
  });

  it('refuses an identical call in the same response, too', async () => {
    const effects: unknown[] = [];
    const { provider, seen } = scripted([
      toolCalls(['crm_write', INPUT], ['crm_write', INPUT]),
      text(ANSWER),
    ]);

    await ask(subAgent(provider, [committingWrite('crm_write', effects)]), passThroughHandle());

    assert.equal(effects.length, 1);
    assert.match(toolResults(seen)[1]?.content ?? '', REFUSAL);
  });

  it('refuses the repeat without a privacy provider as well, where the message is raw', async () => {
    const effects: unknown[] = [];
    const { provider, seen } = scripted([
      toolCalls(['crm_write', INPUT]),
      toolCalls(['crm_write', INPUT]),
      text(ANSWER),
    ]);

    await ask(subAgent(provider, [committingWrite('crm_write', effects)]), undefined);

    assert.equal(effects.length, 1);
    const results = toolResults(seen);
    assert.equal(results[0]?.content, 'Error: socket hang up');
    assert.match(results[1]?.content ?? '', REFUSAL);
  });

  it('refuses the repeat when a tool bridge caught the exception and returned the notice', async () => {
    const effects: unknown[] = [];
    const bridged = bridgeTool({
      id: 'crm_write',
      description: 'update a partner address',
      input: z.object({ partner_id: z.number(), street: z.string() }),
      run: async (parsed: unknown) => {
        effects.push(parsed);
        throw new Error('upstream timed out after the write');
      },
    });
    const { provider, seen } = scripted([
      toolCalls(['crm_write', INPUT]),
      toolCalls(['crm_write', INPUT]),
      text(ANSWER),
    ]);

    await ask(subAgent(provider, [bridged]), passThroughHandle());

    assert.equal(effects.length, 1, 'the bridged write ran twice');
    const results = toolResults(seen);
    assert.match(results[0]?.content ?? '', /^Error: tool `crm_write` failed with Error \[ref err_[0-9a-f]{12}\]/);
    assert.match(results[1]?.content ?? '', REFUSAL);
  });

  it('still runs the same tool with a different input', async () => {
    const effects: unknown[] = [];
    const { provider } = scripted([
      toolCalls(['crm_write', INPUT]),
      toolCalls(['crm_write', { ...INPUT, street: 'Musterweg 2' }]),
      text(ANSWER),
    ]);

    await ask(subAgent(provider, [committingWrite('crm_write', effects)]), passThroughHandle());

    assert.equal(effects.length, 2);
  });

  it('still retries a call that RETURNED an ordinary `Error:` hint', async () => {
    let calls = 0;
    const flaky: LocalSubAgentTool = {
      spec: {
        name: 'crm_read',
        description: 'read a partner',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      async handle() {
        calls += 1;
        return calls === 1 ? 'Error: upstream busy, try again.' : '{"partner_id":42}';
      },
    };
    const { provider, seen } = scripted([
      toolCalls(['crm_read', INPUT]),
      toolCalls(['crm_read', INPUT]),
      text(ANSWER),
    ]);

    await ask(subAgent(provider, [flaky]), passThroughHandle());

    assert.equal(calls, 2, 'a returned hint is not an unknown outcome');
    assert.equal(toolResults(seen)[1]?.isError, false);
  });

  it('counts refusals toward the repeat-failure guard, which then forces a text answer', async () => {
    const effects: unknown[] = [];
    const { provider, seen } = scripted([
      toolCalls(['crm_write', INPUT]),
      toolCalls(['crm_write', INPUT]),
      toolCalls(['crm_write', INPUT]),
      text(ANSWER),
    ]);

    const answer = await ask(subAgent(provider, [committingWrite('crm_write', effects)]), passThroughHandle());

    assert.equal(answer, ANSWER);
    assert.equal(effects.length, 1);
    assert.equal(seen[3]?.toolChoice?.type, 'none', 'the fourth request forbids tools');
  });
});
