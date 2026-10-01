import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
// The barrel, NOT `src/`: `wirePublicMcp.ts` builds its `ToolDispatchService`
// from `@omadia/orchestrator` (dist), and the sub-agent must read the SAME
// `turnContext` AsyncLocalStorage that dispatcher writes. Rebuild before running.
import { createDomainTool, LocalSubAgent, NativeToolRegistry } from '@omadia/orchestrator';
import type { DomainTool, OrchestratorRegistry } from '@omadia/orchestrator';

import {
  callResultText,
  callToolRequest,
  isSandboxListenDenied,
  maskingPrivacyService,
  rpcErrorMessage,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * The public MCP endpoint and a domain tool's sub-agent.
 *
 * A domain tool (`ask_<agent>`) wraps a `LocalSubAgent`: a model loop of its
 * own that calls inner tools and hands their results to ITS model provider. On
 * the chat path that loop inherits the turn's privacy handle from
 * `turnContext`. The public endpoint runs outside any turn: its fail-closed
 * gate reached `ToolDispatchService` only as the dispatcher's own dependency,
 * so the sub-agent found no handle and its provider received inner tool data,
 * inner `Error:` text and — once inner throws became tool results — the raw
 * exception message, while the API caller still got a masked digest.
 *
 * Every test runs the PRODUCTION dispatcher resolver (`wirePublicMcp.ts`: the
 * per-call slot, `withPrivacy`) through `harness.wire`, with a real
 * `LocalSubAgent` whose provider records every request, and asserts on what
 * that provider received.
 */

const TOOL = 'ask_odoo_hr';
const KEY_TOKEN = 'omadia_ak_subagent_token_ffffffffffff';
const KEY_ID = 'key-subagent';

const EMAIL = 'jane.doe@customer.example';
const THROWN = `Fault: Invalid field 'x' on record {'name':'Jane Doe','email':'${EMAIL}'}`;
const ROWS = JSON.stringify([{ employee: 'Jane Doe', email: EMAIL, days: 30 }]);

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function toolCall(name: string): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: `use-${name}`, name, input: {} }],
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

/** The sub-agent's model provider: scripted answers, every request recorded. */
function recordingProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  seen: LlmRequest[];
} {
  const seen: LlmRequest[] = [];
  let idx = 0;
  const next = (): LlmResponse => {
    const response = responses[idx];
    idx += 1;
    if (!response) throw new Error('recordingProvider: no scripted response left');
    return response;
  };
  const provider = {
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
      seen.push(req);
      return next();
    },
    stream: (req: LlmRequest) => {
      seen.push(req);
      const response = next();
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

/** The `tool_result` blocks the sub-agent put on its own model's wire. */
function toolResults(requests: readonly LlmRequest[]): Array<{ content: string; isError: boolean }> {
  const out: Array<{ content: string; isError: boolean }> = [];
  for (const req of requests) {
    for (const message of (req.messages ?? []) as unknown as Array<{ content?: unknown }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block['type'] !== 'tool_result' || typeof block['content'] !== 'string') continue;
        out.push({
          content: block['content'],
          isError: block['isError'] === true || block['is_error'] === true,
        });
      }
    }
  }
  return out;
}

function hrDomainTool(
  provider: LlmProvider,
  tools: ReadonlyArray<readonly [string, () => Promise<string>]>,
): DomainTool {
  const agent = new LocalSubAgent({
    name: 'odoo-hr',
    provider,
    model: 'test-model',
    maxTokens: 1024,
    maxIterations: 4,
    systemPrompt: 'You answer HR questions.',
    tools: tools.map(([name, handle]) => ({
      spec: {
        name,
        description: 'inner HR tool',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      },
      handle,
    })),
  } as ConstructorParameters<typeof LocalSubAgent>[0]);
  return createDomainTool({ name: TOOL, description: 'HR questions', agent, domain: 'odoo.hr' });
}

/** The agent registry the production resolver reads, holding one domain tool. */
function registryWith(tool: DomainTool): () => OrchestratorRegistry {
  const registry = {
    get: (agentId: string) =>
      agentId === 'hr' ? { built: { orchestrator: { listDomainTools: () => [tool] } } } : undefined,
  } as unknown as OrchestratorRegistry;
  return () => registry;
}

function options(tool: DomainTool, overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'hr',
        read_tools: [TOOL],
        write_tools: [],
        write_rate_limit_per_minute: 10,
        enabled: true,
      },
    ],
    dispatchers: {},
    allowWithoutPrivacyMasking: false,
    privacyService: maskingPrivacyService(),
    wire: { getRegistry: registryWith(tool), nativeToolRegistry: new NativeToolRegistry() },
    ...overrides,
  };
}

describe('public MCP endpoint — a domain tool sub-agent runs under the call privacy gate', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    // The withheld-error paths log the full error by design.
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'log', () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await harness?.close();
    harness = undefined;
  });

  async function call(
    opts: HarnessOptions,
    t: { skip: (m: string) => void },
  ): Promise<Record<string, unknown> | undefined> {
    try {
      harness = await startHarness(opts);
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
    const { payload } = await harness.rpc(callToolRequest(TOOL, { question: 'Wer ist das?' }), {
      token: KEY_TOKEN,
    });
    return payload;
  }

  it('withholds an inner tool exception from the sub-agent model', async (t) => {
    const sub = recordingProvider([toolCall('hr_detail'), text('Die Detailabfrage ist fehlgeschlagen.')]);
    const tool = hrDomainTool(sub.provider, [['hr_detail', () => Promise.reject(new Error(THROWN))]]);

    const payload = await call(options(tool), t);
    if (!payload) return;

    assert.equal(sub.seen.length, 2, 'the sub-agent answered after the failed call');
    assert.equal(JSON.stringify(sub.seen).includes(EMAIL), false, 'the e-mail reached the sub-agent provider');
    assert.equal(JSON.stringify(sub.seen).includes('Invalid field'), false);
    const [result] = toolResults(sub.seen);
    assert.match(result?.content ?? '', /^Error: tool `hr_detail` failed with Error \[ref err_[0-9a-f]{12}\]/);
    assert.equal(result?.isError, true);
    assert.equal(callResultText(payload), 'Die Detailabfrage ist fehlgeschlagen.');
  });

  it('interns inner tool data before the sub-agent model sees it', async (t) => {
    const sub = recordingProvider([toolCall('hr_list'), text('Ein Treffer.')]);
    const tool = hrDomainTool(sub.provider, [['hr_list', () => Promise.resolve(ROWS)]]);

    const payload = await call(options(tool), t);
    if (!payload) return;

    assert.equal(JSON.stringify(sub.seen).includes(EMAIL), false, 'raw rows reached the sub-agent provider');
    assert.match(toolResults(sub.seen)[0]?.content ?? '', /\[email\]/, 'the masked digest replaced them');
    assert.equal(callResultText(payload), 'Ein Treffer.');
  });

  it('withholds an inner `Error:` text from the sub-agent model', async (t) => {
    const sub = recordingProvider([toolCall('mail_send'), text('Nicht zugestellt.')]);
    const tool = hrDomainTool(sub.provider, [
      ['mail_send', () => Promise.resolve(`Error: mailbox ${EMAIL} is over quota`)],
    ]);

    const payload = await call(options(tool), t);
    if (!payload) return;

    assert.equal(JSON.stringify(sub.seen).includes(EMAIL), false, 'the error text reached the sub-agent provider');
    const [result] = toolResults(sub.seen);
    assert.match(result?.content ?? '', /^Error: tool `mail_send` reported an error whose text /);
    assert.equal(result?.isError, true);
    assert.equal(callResultText(payload), 'Nicht zugestellt.');
  });

  it("masking inside the sub-agent does not count as masking the endpoint's own result", async (t) => {
    // The sub-agent masks its inner rows, then answers with `Error:` text, which
    // the gate withholds instead of masking. `masked()` must still be false for
    // that outer result: the endpoint refuses it, as it refuses any result that
    // did not cross the boundary itself.
    const sub = recordingProvider([toolCall('hr_list'), text('Error: the HR system rejected the follow-up.')]);
    const tool = hrDomainTool(sub.provider, [['hr_list', () => Promise.resolve(ROWS)]]);

    const payload = await call(options(tool), t);
    if (!payload) return;

    assert.equal(JSON.stringify(sub.seen).includes(EMAIL), false, 'the inner rows were masked');
    assert.match(rpcErrorMessage(payload) ?? '', /privacy masking did not run/);
  });

  it('control — the sub-agent answer itself is masked before it reaches the caller', async (t) => {
    const sub = recordingProvider([text(`Kontakt: ${EMAIL}`)]);
    const tool = hrDomainTool(sub.provider, []);

    const payload = await call(options(tool), t);
    if (!payload) return;

    assert.equal(callResultText(payload), 'Kontakt: [email]');
  });

  it('no privacy provider while masking is required: no model call at all', async (t) => {
    const sub = recordingProvider([text('nie')]);
    const tool = hrDomainTool(sub.provider, []);

    const payload = await call(options(tool, { privacyService: undefined }), t);
    if (!payload) return;

    assert.match(rpcErrorMessage(payload) ?? '', /no privacy provider is installed/);
    assert.equal(sub.seen.length, 0, 'the sub-agent model was called without a guard');
  });
});
