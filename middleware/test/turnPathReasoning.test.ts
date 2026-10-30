/**
 * The extras' calls on a chat turn's critical path — the recall relevance
 * judge (before the first model call) and the save-as-memory excerpt (before
 * `done`) — ask for low effort and no thinking. Live on Haiku 5.5 (default
 * effort `medium`) they spent ~500–1000 output tokens each, ~3 s apiece.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createHaikuPalaiaExcerptExtractor } from '@omadia/orchestrator-extras/dist/excerptExtractor.js';
import { createRecallRelevanceJudge } from '@omadia/orchestrator-extras/dist/recallRelevanceJudge.js';

function recordingLlm(reply: string, seen: Array<Record<string, unknown>>) {
  return {
    async complete(req: unknown): Promise<unknown> {
      seen.push(req as Record<string, unknown>);
      return { content: [{ type: 'text', text: reply }], finishReason: 'stop' };
    },
  };
}

describe('turn-path extras calls ask for low effort, no thinking', () => {
  it('recall relevance judge', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const judge = createRecallRelevanceJudge({
      llm: recordingLlm('{"relevant":["a"]}', seen) as never,
      model: 'claude-haiku-5-5',
      log: () => undefined,
    });
    await judge.filterRelevant('Offene Posten je Monat?', [
      { id: 'a', kind: 'insight', text: 'Offene Posten Q3' },
      { id: 'b', kind: 'insight', text: 'Geburtstage im Januar' },
    ] as never);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.['effort'], 'low');
    assert.equal(seen[0]?.['thinking'], 'off');
  });

  it('save-as-memory excerpt', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const extractor = createHaikuPalaiaExcerptExtractor({
      llm: recordingLlm('{"excerpt":"pgvector, Dimension 768"}', seen) as never,
      log: () => undefined,
    });
    await extractor.extract({
      cleanedUserMessage: 'Welche Embedding-Dim?',
      cleanedAssistantAnswer: 'Wir nutzen pgvector. Die Embedding-Dimension ist 768.',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.['effort'], 'low');
    assert.equal(seen[0]?.['thinking'], 'off');
  });
});
