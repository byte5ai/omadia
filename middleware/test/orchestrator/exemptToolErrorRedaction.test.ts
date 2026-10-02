import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';

import { LocalSubAgent } from '../../packages/harness-orchestrator/src/localSubAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { createFailClosedPrivacyGate } from '../../src/mcp/publicMcpPrivacy.js';

/**
 * Intern-exempt self tools (`memory`, `query_processes`, `read_attachment`, …)
 * hand their normal result to the model in clear: masking it would blind the
 * agent to its own state. That exemption does not extend to an error text. A
 * self tool's `Error:` result can quote what it failed on, and a thrown message
 * can echo its input, so both take the same tool-error policy as any guarded
 * tool: the returned text is redacted, the thrown message is withheld.
 *
 * One block per seam: the orchestrator's dispatch, a sub-agent's inner dispatch,
 * `ToolDispatchService`, and a sub-agent nested inside a public MCP call (the
 * public gate's `forNestedCalls` handle). Each has a control that the normal
 * result of the same tool still passes raw. All values are synthetic.
 */

const EMAIL = 'erika.mustermann@example.com';
const ADDRESS = 'Musterstraße 12, 12345 Musterstadt';
const ERROR_RESULT = `Error: no process stored for ${EMAIL} at ${ADDRESS}`;
const REDACTED_RESULT = 'Error: no process stored for [masked:email] at [masked:address]';
const THROWN_MESSAGE = `cannot open /memories/${EMAIL}.md`;
const OK_RESULT = `{"process":"monthly report","owner":"${EMAIL}"}`;

function redact(text: string): string {
  return text.replaceAll(EMAIL, '[masked:email]').replaceAll(ADDRESS, '[masked:address]');
}

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function toolCallResponse(name: string): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: 'use-1', name, input: {} }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

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

/** The `tool_result` contents a model was handed. */
function toolResults(requests: readonly LlmRequest[]): string[] {
  const out: string[] = [];
  for (const req of requests) {
    for (const message of (req.messages ?? []) as unknown as Array<{ content?: unknown }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<{ type?: string; content?: unknown }>) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          out.push(block.content);
        }
      }
    }
  }
  return out;
}

/** Interns with a recognizable envelope and redacts tool-error text. */
const privacyMembers = {
  async internToolResultV4({ toolName, rawResult }: { toolName: string; rawResult: string }) {
    return { digestText: `«dataset:${toolName}» ${redact(rawResult)}`, datasetId: `ds-${toolName}` };
  },
  async recordBypassedTool() {},
  async recordToolError() {},
  async redactToolErrorText({ text }: { text: string }) {
    const redacted = redact(text);
    return {
      outcome: 'redacted' as const,
      text: redacted,
      spans: redacted === text ? [] : [{ type: 'email', detector: 'c0-regex' }],
      degraded: false,
    };
  },
  checkBypass() {
    return undefined;
  },
  async runV4Tool() {
    return { resultText: '' };
  },
  async subAgentResultV4() {
    return { resultText: '' };
  },
  async takeRenderedAnswerV4() {
    return undefined;
  },
  v4ToolSpecs() {
    return [];
  },
  async finalizeTurn() {
    return undefined;
  },
};

function privacyHandle(): PrivacyTurnHandle {
  return { ...privacyMembers } as unknown as PrivacyTurnHandle;
}

function privacyService(): PrivacyGuardService {
  return { ...privacyMembers } as unknown as PrivacyGuardService;
}

function registryWith(name: string, handler: () => Promise<string>): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register(name, {
    handler,
    spec: {
      name,
      description: 'test self tool',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.self',
  });
  return registry;
}

function throwing(): Promise<string> {
  return Promise.reject(new Error(THROWN_MESSAGE));
}

beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  mock.restoreAll();
});

describe('exempt tool errors — orchestrator dispatch', () => {
  async function chatToolResult(tool: string, handler: () => Promise<string>): Promise<string> {
    const { provider, seen } = recordingProvider([toolCallResponse(tool), textResponse('done')]);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: registryWith(tool, handler),
      privacyGuard: () => privacyService(),
    });
    await orchestrator.runTurn({ userMessage: 'go' });
    const results = toolResults(seen);
    assert.equal(results.length, 1, 'exactly one tool_result reached the model');
    return results[0]!;
  }

  it('redacts a returned `Error:` text of an exempt tool', async () => {
    const content = await chatToolResult('query_processes', () => Promise.resolve(ERROR_RESULT));
    assert.equal(content, REDACTED_RESULT);
  });

  it('withholds a thrown message of an exempt tool', async () => {
    const content = await chatToolResult('query_processes', throwing);
    assert.equal(content.includes(EMAIL), false, `thrown text reached the model: ${content}`);
    assert.match(content, /^Error: tool `query_processes` failed with Error \[ref /);
  });

  it('control — the normal result of an exempt tool still passes raw', async () => {
    const content = await chatToolResult('query_processes', () => Promise.resolve(OK_RESULT));
    assert.equal(content, OK_RESULT);
  });
});

describe('exempt tool errors — sub-agent dispatch', () => {
  async function subAgentToolResult(
    handler: () => Promise<string>,
    handle: PrivacyTurnHandle = privacyHandle(),
  ): Promise<string> {
    const { provider, seen } = recordingProvider([toolCallResponse('memory'), textResponse('done')]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 5,
      systemPrompt: 'you are a test',
      tools: [
        {
          spec: {
            name: 'memory',
            description: 'test self tool',
            input_schema: { type: 'object' as const, properties: {}, required: [] },
          },
          handle: handler,
        },
      ],
    } as ConstructorParameters<typeof LocalSubAgent>[0]);
    await turnContext.run(
      { turnId: 'turn-exempt', turnDate: '2026-10-02', privacyHandle: handle },
      async () => agent.ask('go'),
    );
    const results = toolResults(seen);
    assert.equal(results.length, 1, 'exactly one tool_result reached the sub-agent model');
    return results[0]!;
  }

  it('redacts a returned `Error:` text of an exempt tool', async () => {
    assert.equal(await subAgentToolResult(() => Promise.resolve(ERROR_RESULT)), REDACTED_RESULT);
  });

  it('withholds a thrown message of an exempt tool', async () => {
    const content = await subAgentToolResult(throwing);
    assert.equal(content.includes(EMAIL), false, `thrown text reached the model: ${content}`);
    assert.match(content, /^Error: tool `memory` failed with Error \[ref /);
  });

  it('control — the normal result of an exempt tool still passes raw', async () => {
    assert.equal(await subAgentToolResult(() => Promise.resolve(OK_RESULT)), OK_RESULT);
  });

  it('public gate — a sub-agent nested in a public call gets the withheld notice', async () => {
    const gate = createFailClosedPrivacyGate(privacyHandle());
    const nested = gate.handle.forNestedCalls();

    const returned = await subAgentToolResult(() => Promise.resolve(ERROR_RESULT), nested);
    assert.equal(returned.includes(EMAIL), false, `returned text reached the model: ${returned}`);
    assert.equal(returned.includes(ADDRESS), false, `returned text reached the model: ${returned}`);
    assert.match(returned, /^Error: tool `memory` reported an error whose text could not be checked/);

    const thrown = await subAgentToolResult(throwing, nested);
    assert.equal(thrown.includes(EMAIL), false, `thrown text reached the model: ${thrown}`);
    assert.match(thrown, /^Error: tool `memory` failed with Error \[ref /);
  });
});

describe('exempt tool errors — ToolDispatchService', () => {
  function serviceWith(handler: () => Promise<string>): ToolDispatchService {
    return new ToolDispatchService({
      nativeTools: registryWith('memory', handler),
      domainTools: [],
      privacy: () => privacyHandle(),
    });
  }

  it('redacts a returned `Error:` text of an exempt tool', async () => {
    const result = await serviceWith(() => Promise.resolve(ERROR_RESULT)).dispatch('memory', {});
    assert.equal(result.content, REDACTED_RESULT);
    assert.equal(result.origin, 'tool', 'handler-authored content, redacted');
  });

  it('withholds a thrown message of an exempt tool', async () => {
    const result = await serviceWith(throwing).dispatch('memory', {});
    assert.equal(result.content.includes(EMAIL), false, `thrown text left the dispatcher: ${result.content}`);
    assert.match(result.content, /^Error: tool `memory` failed with Error \[ref /);
  });

  it('control — the normal result of an exempt tool still passes raw', async () => {
    const result = await serviceWith(() => Promise.resolve(OK_RESULT)).dispatch('memory', {});
    assert.equal(result.content, OK_RESULT);
  });
});
