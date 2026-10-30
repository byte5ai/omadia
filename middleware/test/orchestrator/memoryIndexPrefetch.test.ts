/**
 * The `/memories` index is read by the kernel before the turn's first model
 * call (`memoryIndexPrefetch.ts`) instead of by the model's opening `view` —
 * a full main-model round on nearly every chat turn. Pinned here: the listing
 * rides the per-turn hint on a chat turn, through the turn's handler; a canvas
 * turn, a Fresh Check, an oversized listing or a non-listing answer keep the
 * ordinary convention.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import type { MemoryToolHandler } from '@omadia/memory';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

import {
  MEMORY_INDEX_MAX_CHARS,
  memoryIndexHint,
  prefetchMemoryIndex,
} from '../../packages/harness-orchestrator/src/memoryIndexPrefetch.js';

const LISTING =
  "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n" +
  '1.2K\t/memories/_rules/accounting-conventions.md\n' +
  '640\t/memories/observations/2026-q4.md';

/** A handler stand-in that answers every call with `answer` and records it. */
function fakeHandler(answer: string | Error, calls: unknown[] = []): MemoryToolHandler {
  return {
    handle: async (input: unknown): Promise<string> => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as MemoryToolHandler;
}

describe('prefetchMemoryIndex', () => {
  it('views /memories through the given handler and returns the listing', async () => {
    const calls: unknown[] = [];
    const index = await prefetchMemoryIndex(fakeHandler(LISTING, calls));
    assert.deepEqual(index, { ok: true, listing: LISTING });
    assert.deepEqual(calls, [{ command: 'view', path: '/memories' }]);
  });

  it('skips without a handler, on a non-listing answer, an oversized listing or a throw', async () => {
    assert.deepEqual(await prefetchMemoryIndex(undefined), { ok: false, reason: 'no-handler' });
    assert.deepEqual(await prefetchMemoryIndex(fakeHandler('The path /memories does not exist.')), {
      ok: false,
      reason: 'not-a-listing',
    });
    const big = LISTING + '\n' + 'x'.repeat(MEMORY_INDEX_MAX_CHARS);
    assert.deepEqual(await prefetchMemoryIndex(fakeHandler(big)), { ok: false, reason: 'too-large' });
    assert.deepEqual(await prefetchMemoryIndex(fakeHandler(new Error('store down'))), {
      ok: false,
      reason: 'failed',
    });
  });
});

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

function systemText(req: LlmRequest): string {
  const sys = req.system;
  if (sys === undefined) return '';
  return typeof sys === 'string' ? sys : sys.map((b) => b.text).join('\n');
}

async function firstSystemPrompt(
  path: 'stream' | 'runTurn',
  input: ChatTurnInput,
  memoryAnswer: string = LISTING,
): Promise<string> {
  const requests: LlmRequest[] = [];
  const orch = new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    memoryToolHandler: fakeHandler(memoryAnswer),
  });
  if (path === 'stream') {
    for await (const ev of orch.chatStream(input)) void ev;
  } else {
    await orch.runTurn(input);
  }
  assert.ok(requests.length >= 1, 'the main model ran');
  return systemText(requests[0]!);
}

const chat: ChatTurnInput = { userMessage: 'Offene Posten?', sessionScope: 'sess-chat', userId: 'u1' };

for (const path of ['stream', 'runTurn'] as const) {
  describe(`memory index prefetch — ${path}`, () => {
    it('a chat turn carries the prefetched listing in its hint', async () => {
      const system = await firstSystemPrompt(path, chat);
      assert.ok(system.includes(memoryIndexHint(LISTING)), 'listing block in the system prompt');
    });

    it('a canvas turn and a Fresh Check keep the ordinary convention', async () => {
      const canvas = await firstSystemPrompt(path, { ...chat, canvasSessionId: 'canvas-1' });
      assert.ok(!canvas.includes('MEMORY-INDEX'));
      const fresh = await firstSystemPrompt(path, { ...chat, freshCheck: true } as ChatTurnInput);
      assert.ok(!fresh.includes('MEMORY-INDEX'));
    });

    it('no block when the handler answers with something other than a listing', async () => {
      const system = await firstSystemPrompt(path, chat, 'The path /memories does not exist.');
      assert.ok(!system.includes('MEMORY-INDEX'));
    });
  });
}
