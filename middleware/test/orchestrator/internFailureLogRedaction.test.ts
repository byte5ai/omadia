import { strict as assert } from 'node:assert';
import { format } from 'node:util';
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
 * A privacy provider that fails to intern a result can quote that result in its
 * error message. Every seam fails closed on such a failure; its warning line
 * must not carry the message either, only the error's class and code, because a
 * log sink keeps it in clear. All values are synthetic.
 */

const EMAIL = 'erika.mustermann@example.com';
const RAW_RESULT = `{"name":"Erika Mustermann","email":"${EMAIL}"}`;

function providerError(): Error {
  return Object.assign(new Error(`cannot intern ${RAW_RESULT}`), {
    name: 'InternError',
    code: 'E_INTERN',
  });
}

const failingMembers = {
  async internToolResultV4(): Promise<never> {
    throw providerError();
  },
  async recordBypassedTool() {},
  async recordToolError() {},
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

function failingHandle(): PrivacyTurnHandle {
  return { ...failingMembers } as unknown as PrivacyTurnHandle;
}

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function scripted(responses: readonly LlmResponse[]): LlmProvider {
  let idx = 0;
  const next = (): LlmResponse => {
    const response = responses[idx];
    idx += 1;
    if (!response) throw new Error('scripted: no response left');
    return response;
  };
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
    complete: async (_req: LlmRequest) => next(),
    stream: () => {
      const response = next();
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function toolCall(name: string): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: 'use-1', name, input: {} }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

const done = {
  content: [{ type: 'text', text: 'done' }],
  finishReason: 'stop',
  providerFinishReason: 'end_turn',
  model: 'test',
  usage,
} as unknown as LlmResponse;

function registryWith(name: string): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register(name, {
    handler: async () => RAW_RESULT,
    spec: {
      name,
      description: 'returns a record',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.pii',
  });
  return registry;
}

let warnLines: string[] = [];
let errorLines: string[] = [];
beforeEach(() => {
  warnLines = [];
  errorLines = [];
  mock.method(console, 'warn', (...args: unknown[]) => {
    warnLines.push(format(...args));
  });
  mock.method(console, 'error', (...args: unknown[]) => {
    errorLines.push(format(...args));
  });
});
afterEach(() => {
  mock.restoreAll();
});

function assertClassOnly(): void {
  const lines = warnLines.filter((l) => l.includes('InternError'));
  assert.ok(lines.length > 0, `no interning-failure warning: ${JSON.stringify(warnLines)}`);
  for (const line of [...warnLines, ...errorLines]) {
    assert.equal(line.includes(EMAIL), false, `the provider error message reached the log: ${line}`);
  }
  assert.ok(lines.some((l) => l.includes('(code E_INTERN)')), 'the sanitised code is logged');
}

describe('interning-failure warnings carry the error class and code, never its message', () => {
  it('orchestrator dispatch', async () => {
    const orchestrator = new Orchestrator({
      provider: scripted([toolCall('odoo_read_partner'), done]),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: registryWith('odoo_read_partner'),
      privacyGuard: () => ({ ...failingMembers }) as unknown as PrivacyGuardService,
    });
    await orchestrator.runTurn({ userMessage: 'go' });
    assertClassOnly();
  });

  it('sub-agent dispatch', async () => {
    const agent = new LocalSubAgent({
      name: 'test',
      provider: scripted([toolCall('odoo_read_partner'), done]),
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 5,
      systemPrompt: 'you are a test',
      tools: [
        {
          spec: {
            name: 'odoo_read_partner',
            description: 'returns a record',
            input_schema: { type: 'object' as const, properties: {}, required: [] },
          },
          handle: async () => RAW_RESULT,
        },
      ],
    } as ConstructorParameters<typeof LocalSubAgent>[0]);
    await turnContext.run(
      { turnId: 'turn-log', turnDate: '2026-10-02', privacyHandle: failingHandle() },
      async () => agent.ask('go'),
    );
    assertClassOnly();
  });

  it('ToolDispatchService', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner'),
      domainTools: [],
      privacy: () => failingHandle(),
    });
    const result = await service.dispatch('odoo_read_partner', {});
    assert.equal(result.content.includes(EMAIL), false);
    assertClassOnly();
  });

  it('public MCP gate', async () => {
    const gate = createFailClosedPrivacyGate(failingHandle());
    await gate.handle.internToolResultV4({ toolName: 'odoo_read_partner', rawResult: RAW_RESULT });
    assert.equal(gate.maskingFailed(), true);
    assertClassOnly();
  });
});
