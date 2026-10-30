/**
 * The orchestrator's prompt-cache layout. The cache is a prefix match
 * (tools → system → messages), so the stable prompt must come before anything
 * that changes per turn — the prior-context block used to come first, and
 * every turn with history re-wrote the ~20k-token stable prompt. All
 * breakpoints carry the 1-hour TTL so the prefix survives the 5–60 minute gaps
 * between a user's turns.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const PRIOR = 'PRIOR-CONTEXT-MARKER-91c2';

const CAPS = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function recordingProvider(requests: LlmRequest[]): LlmProvider {
  const answer = (req: LlmRequest): LlmResponse => {
    requests.push(req);
    return {
      content: [{ type: 'text', text: 'Erledigt.' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  return {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (req: LlmRequest) => answer(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const response = answer(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: 'Erledigt.' } as LlmStreamEvent;
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

async function firstRequest(path: 'stream' | 'runTurn', withPrior: boolean): Promise<LlmRequest> {
  const requests: LlmRequest[] = [];
  const contextRetriever = {
    assembleForBudget: async (): Promise<unknown> => ({
      text: withPrior ? `## Letzte Turns in diesem Chat\n${PRIOR}` : '',
      included: [],
      excluded: [],
      stats: { candidatePool: 0, compactMode: false, tokensUsed: 0 },
      recalled: undefined,
    }),
  } as unknown as OrchestratorOptions['contextRetriever'];
  const orch = new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    contextRetriever,
  });
  const input: ChatTurnInput = { userMessage: 'und für Q4?', sessionScope: 'sess-1', userId: 'u1' };
  if (path === 'stream') {
    for await (const ev of orch.chatStream(input)) void ev;
  } else {
    await orch.runTurn(input);
  }
  assert.ok(requests.length >= 1, 'the main model ran');
  return requests[0]!;
}

function blocks(req: LlmRequest): ReadonlyArray<{ text: string; cache?: boolean }> {
  assert.ok(Array.isArray(req.system), 'structured system blocks');
  return req.system as ReadonlyArray<{ text: string; cache?: boolean }>;
}

for (const path of ['stream', 'runTurn'] as const) {
  describe(`system prompt cache layout — ${path}`, () => {
    it('the stable prompt is the first, cached block; the prior context follows it, cached', async () => {
      const req = await firstRequest(path, true);
      const sys = blocks(req);
      const priorAt = sys.findIndex((b) => b.text.includes(PRIOR));
      assert.ok(priorAt > 0, `prior context after the stable prompt (at ${String(priorAt)})`);
      assert.equal(sys[0]!.cache, true, 'stable prompt carries a breakpoint');
      assert.ok(!sys[0]!.text.includes(PRIOR), 'stable prompt holds no per-turn context');
      assert.equal(sys[priorAt]!.cache, true, 'prior context carries a breakpoint');
      assert.ok(sys[priorAt]!.text.startsWith('# Vorheriger Gesprächskontext — VORRANG'));
      assert.ok(sys.slice(priorAt + 1).every((b) => b.cache !== true), 'nothing after it is cached');
    });

    it('the stable block is byte-identical with and without prior context', async () => {
      const withPrior = blocks(await firstRequest(path, true))[0]!.text;
      const without = blocks(await firstRequest(path, false))[0]!.text;
      assert.equal(withPrior, without);
    });

    it('every breakpoint asks for the 1-hour TTL', async () => {
      const req = await firstRequest(path, true);
      assert.equal(req.cacheHints?.ttl, '1h');
    });
  });
}
