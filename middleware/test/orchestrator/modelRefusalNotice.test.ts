/**
 * `stop_reason: "refusal"` — the model's safety classifiers declined the turn
 * (HTTP 200; Fable 5.x, Opus 5+, Sonnet 5). The response then carries no text
 * or only a fragment, and the orchestrator finalized it like a normal
 * `end_turn`: the user got an empty reply that looked like a platform bug.
 *
 * These tests pin, on BOTH finalize paths (non-streaming `runTurn` — Teams —
 * and streaming `chatStream` — web chat):
 *   - an empty refusal becomes MODEL_REFUSAL_NOTICE,
 *   - a partial refusal keeps its fragment and gets the notice appended,
 *   - a normal `end_turn` answer is untouched.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  MODEL_REFUSAL_NOTICE,
  NativeToolRegistry,
  Orchestrator,
  finalAnswerText,
} from '../../packages/harness-orchestrator/src/index.js';

function response(text: string, stopReason: string): LlmResponse {
  return {
    content: text === '' ? [] : [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: stopReason,
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function scriptedProvider(res: LlmResponse): LlmProvider {
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
    complete: async (): Promise<LlmResponse> => res,
    stream: (): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'final', response: res };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function orchestratorFor(res: LlmResponse): Orchestrator {
  return new Orchestrator({
    provider: scriptedProvider(res),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
  });
}

async function nonStreamingAnswer(res: LlmResponse): Promise<string> {
  const result = await orchestratorFor(res).runTurn({ userMessage: 'go' });
  return result.answer;
}

async function streamingAnswer(res: LlmResponse): Promise<string> {
  let answer: string | undefined;
  for await (const ev of orchestratorFor(res).chatStream({ userMessage: 'go' })) {
    if (ev.type === 'done') answer = ev.answer;
  }
  assert.ok(answer !== undefined, 'stream ended without a done event');
  return answer;
}

describe('stop_reason "refusal" is made explicit to the user', () => {
  for (const [label, run] of [
    ['non-streaming (runTurn)', nonStreamingAnswer],
    ['streaming (chatStream)', streamingAnswer],
  ] as const) {
    // The streaming path folds the AI disclosure onto the end of the answer
    // (#644), so assertions pin the start and presence, not exact equality.
    it(`${label}: an empty refusal becomes the refusal notice`, async () => {
      const answer = await run(response('', 'refusal'));
      assert.ok(answer.startsWith(MODEL_REFUSAL_NOTICE), answer);
    });

    it(`${label}: a partial refusal keeps the fragment and appends the notice`, async () => {
      const answer = await run(response('Teil der Antwort', 'refusal'));
      assert.ok(answer.startsWith('Teil der Antwort'), answer);
      assert.ok(answer.includes(MODEL_REFUSAL_NOTICE), answer);
    });

    it(`${label}: a normal end_turn answer is untouched`, async () => {
      const answer = await run(response('Hallo', 'end_turn'));
      assert.ok(answer.startsWith('Hallo'), answer);
      assert.equal(answer.includes(MODEL_REFUSAL_NOTICE), false, answer);
    });
  }

  it('finalAnswerText joins parts exactly as before for non-refusals', () => {
    assert.equal(finalAnswerText([' a ', 'b '], 'end_turn'), 'a \n\nb');
    assert.equal(finalAnswerText([], 'max_tokens'), '');
  });
});
