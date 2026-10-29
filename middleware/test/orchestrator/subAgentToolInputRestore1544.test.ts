/**
 * #1544 — the sub-agent half: a domain tool's sub-agent model reads the
 * prompt placeholders (its question came from the parent model), but its inner
 * data tools run on the user's values, and what they echo reaches the
 * sub-agent's model with the placeholder again. Intern-exempt self tools
 * (`memory`) keep the placeholder: what they store is read back in clear in
 * later turns. The privacy handle is a stub over a one-entry map; the real
 * guard's methods have their own test (`promptMaskToolInputRestore1544.test.ts`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';

import { LocalSubAgent } from '../../packages/harness-orchestrator/src/localSubAgent.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

const REAL = 'Projekt Falkenstein';
const PLACEHOLDER = 'PLATZHALTER-CUSTOM-1';
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function scripted(toolName: string): { provider: LlmProvider; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  const responses = [
    {
      content: [{ type: 'tool_call', id: 'use-1', name: toolName, input: { path: `/memories/${PLACEHOLDER}.md` } }],
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
    },
    { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', providerFinishReason: 'end_turn' },
  ];
  let idx = 0;
  const next = (req: LlmRequest): LlmResponse => {
    seen.push(req);
    const response = responses[idx++];
    if (response === undefined) throw new Error('no scripted response left');
    return { ...response, model: 'test', usage } as unknown as LlmResponse;
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
    complete: (req: LlmRequest) => Promise.resolve(next(req)),
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

function handle(): PrivacyTurnHandle {
  return {
    restoreToolInputValues: (text: string) => text.split(PLACEHOLDER).join(REAL),
    remaskPromptValues: (text: string) => text.split(REAL).join(PLACEHOLDER),
    checkBypass: () => undefined,
    // Interning stand-in that echoes the raw result, so the test sees what
    // the re-mask makes of an echo.
    async internToolResultV4({ rawResult }: { rawResult: string }) {
      return { digestText: rawResult, datasetId: 'ds-test' };
    },
    async recordToolError() {},
    async redactToolErrorText({ text }: { text: string }) {
      return { outcome: 'redacted' as const, text, spans: [], degraded: false };
    },
  } as unknown as PrivacyTurnHandle;
}

async function run(toolName: string): Promise<{ inputs: unknown[]; wire: string }> {
  const inputs: unknown[] = [];
  const { provider, seen } = scripted(toolName);
  const agent = new LocalSubAgent({
    name: 'docs',
    provider,
    model: 'claude-haiku',
    maxTokens: 1024,
    maxIterations: 4,
    systemPrompt: 'test',
    tools: [
      {
        spec: {
          name: toolName,
          description: 'test tool',
          input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: [] },
        },
        handle: (input: unknown) => {
          inputs.push(input);
          return Promise.resolve(`viewed ${(input as { path: string }).path}`);
        },
      },
    ],
  } as ConstructorParameters<typeof LocalSubAgent>[0]);
  await turnContext.run(
    { turnId: 'turn-1544', turnDate: '2026-10-29', privacyHandle: handle() },
    () => agent.ask(`Was steht in ${PLACEHOLDER}?`),
  );
  return { inputs, wire: JSON.stringify(seen.map((r) => r.messages)) };
}

describe('#1544 — sub-agent inner tools run on the user values', () => {
  it('restores a data tool input and re-masks what it echoes', async () => {
    const { inputs, wire } = await run('search_docs');
    assert.deepEqual(inputs, [{ path: `/memories/${REAL}.md` }], 'the tool got the user value');
    assert.ok(!wire.includes('Falkenstein'), 'the user value reached the sub-agent model');
    assert.ok(wire.includes(`viewed /memories/${PLACEHOLDER}.md`), 'the echo carries the placeholder');
  });

  it('leaves an intern-exempt self tool (memory) on the placeholder', async () => {
    const { inputs, wire } = await run('memory');
    assert.deepEqual(inputs, [{ path: `/memories/${PLACEHOLDER}.md` }]);
    assert.ok(!wire.includes('Falkenstein'));
  });
});
