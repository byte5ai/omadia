import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { TOPIC_CLASSIFIER_MAX_TOKENS, TopicDetector } from '@omadia/orchestrator-extras';
import type { LlmRequest } from '@omadia/llm-provider';
import type { EmbeddingClient } from '@omadia/embeddings';
import type { ConversationTurn } from '@omadia/plugin-api';

// --- Test doubles ---------------------------------------------------------

/**
 * Stub that returns fixed vectors based on prefix matches. Two strings
 * starting with the same "topic"-marker get the same vector → similarity=1.
 * Different markers → orthogonal.
 */
function stubEmbeddings(topicMap: Record<string, number[]>): EmbeddingClient {
  return {
    embed(text: string): Promise<number[]> {
      for (const [marker, vec] of Object.entries(topicMap)) {
        if (text.startsWith(marker)) return Promise.resolve(vec.slice());
      }
      return Promise.resolve([0, 0, 0, 1]);
    },
  };
}

function stubAnthropic(verdict: string): unknown {
  return {
    complete: () =>
      Promise.resolve({
        content: [{ type: 'text', text: verdict }],
      }),
  };
}

const A: ConversationTurn = {
  userMessage: 'topicA: Umsatz 2025 als Balken',
  assistantAnswer: 'Hier das Chart',
  at: 1,
};
const A2: ConversationTurn = {
  userMessage: 'topicA: und nun ohne Gutschriften',
  assistantAnswer: 'Hier die Variante',
  at: 2,
};

describe('TopicDetector', () => {
  it('auto-continues for empty history', async () => {
    const det = new TopicDetector(
      stubEmbeddings({}),
      stubAnthropic('unsure') as never,
    );
    const r = await det.classify({ userMessage: 'hi', history: [] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'no-history');
  });

  it('auto-continues when similarity is above upper threshold', async () => {
    const embeddings = stubEmbeddings({ topicA: [1, 0, 0, 0] });
    const det = new TopicDetector(embeddings, stubAnthropic('continue') as never, {
      upperThreshold: 0.5,
      lowerThreshold: 0.1,
    });
    const r = await det.classify({
      userMessage: 'topicA: weitere Variante',
      history: [A, A2],
    });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'similarity-high');
  });

  it('auto-resets when similarity is below lower threshold', async () => {
    const embeddings = stubEmbeddings({
      topicA: [1, 0, 0, 0],
      topicB: [0, 1, 0, 0],
    });
    const det = new TopicDetector(embeddings, stubAnthropic('reset') as never, {
      upperThreshold: 0.6,
      lowerThreshold: 0.2,
    });
    const r = await det.classify({
      userMessage: 'topicB: ganz was anderes',
      history: [A, A2],
    });
    assert.equal(r.decision, 'reset');
    assert.equal(r.reason, 'similarity-low');
  });

  it('escalates ambiguous similarity to classifier (continue)', async () => {
    const embeddings = stubEmbeddings({
      topicA: [1, 0, 0, 0],
      topicMid: [0.8, 0.3, 0, 0],
    });
    const det = new TopicDetector(
      embeddings,
      stubAnthropic('continue') as never,
      { upperThreshold: 0.95, lowerThreshold: 0.05 },
    );
    const r = await det.classify({
      userMessage: 'topicMid: irgendwas dazu',
      history: [A, A2],
    });
    assert.equal(r.decision, 'continue');
    assert.equal(r.classifier, 'continue');
    assert.equal(r.reason, 'classifier-continue');
  });

  it('escalates ambiguous similarity to classifier (reset)', async () => {
    const embeddings = stubEmbeddings({
      topicA: [1, 0, 0, 0],
      topicMid: [0.8, 0.3, 0, 0],
    });
    const det = new TopicDetector(
      embeddings,
      stubAnthropic('reset') as never,
      { upperThreshold: 0.95, lowerThreshold: 0.05 },
    );
    const r = await det.classify({
      userMessage: 'topicMid: was Neues',
      history: [A, A2],
    });
    assert.equal(r.decision, 'reset');
    assert.equal(r.classifier, 'reset');
  });

  it('asks the user when classifier returns unsure', async () => {
    const embeddings = stubEmbeddings({
      topicA: [1, 0, 0, 0],
      topicMid: [0.8, 0.3, 0, 0],
    });
    const det = new TopicDetector(
      embeddings,
      stubAnthropic('unsure') as never,
      { upperThreshold: 0.95, lowerThreshold: 0.05 },
    );
    const r = await det.classify({
      userMessage: 'topicMid: kann man so oder so',
      history: [A, A2],
    });
    assert.equal(r.decision, 'ask');
    assert.equal(r.classifier, 'unsure');
  });

  it('falls back to configured decision when embeddings fail', async () => {
    const brokenEmbeddings: EmbeddingClient = {
      embed: () => Promise.reject(new Error('sidecar down')),
    };
    const det = new TopicDetector(
      brokenEmbeddings,
      stubAnthropic('continue') as never,
      { fallbackDecision: 'continue' },
    );
    const r = await det.classify({
      userMessage: 'topicA: something',
      history: [A],
    });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'embedding-failed');
  });

  it('budgets the classifier for an always-thinking model: room for thinking, low effort, no thinking where allowed', async () => {
    const embeddings = stubEmbeddings({ topicA: [1, 0, 0, 0], topicMid: [0.8, 0.3, 0, 0] });
    const seen: LlmRequest[] = [];
    const llm = {
      complete: (req: LlmRequest) => {
        seen.push(req);
        // An always-thinking model on the old 64-token budget: thinking ate
        // it all and the reply came back empty.
        const text = req.maxTokens <= 64 ? '' : 'continue';
        return Promise.resolve({ content: [{ type: 'text', text }] });
      },
    };
    const det = new TopicDetector(embeddings, llm as never, { upperThreshold: 0.95, lowerThreshold: 0.05 });
    const r = await det.classify({ userMessage: 'topicMid: irgendwas dazu', history: [A, A2] });
    assert.equal(r.classifier, 'continue');
    assert.equal(seen[0]?.maxTokens, TOPIC_CLASSIFIER_MAX_TOKENS);
    assert.ok(TOPIC_CLASSIFIER_MAX_TOKENS >= 1024);
    assert.equal(seen[0]?.effort, 'low');
    assert.equal(seen[0]?.thinking, 'off');
    assert.equal(seen[0]?.temperature, undefined, 'no temperature next to an effort');
  });
});
