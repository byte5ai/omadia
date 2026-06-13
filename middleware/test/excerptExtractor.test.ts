import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createHaikuPalaiaExcerptExtractor } from '@omadia/orchestrator-extras/dist/excerptExtractor.js';

// Mock Anthropic — captures `messages.create` payloads and replays a
// scripted reply. Exercises hint / parse / normalise paths without
// touching the real API.
interface CapturedCall {
  model: string;
  maxTokens: number;
  system: string;
  userContent: string;
}

function makeFakeAnthropic(opts: {
  reply?: string;
  throwOnCall?: boolean;
  rawText?: string;
}): {
  client: { complete: (req: unknown) => Promise<unknown> };
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client = {
    async complete(req: unknown): Promise<unknown> {
      if (opts.throwOnCall) throw new Error('haiku-down');
      const r = req as {
        model: string;
        maxTokens: number;
        system: string;
        messages: ReadonlyArray<{
          role: string;
          content: ReadonlyArray<{ type: string; text?: string }>;
        }>;
      };
      calls.push({
        model: r.model,
        maxTokens: r.maxTokens,
        system: r.system,
        userContent: r.messages[0]?.content[0]?.text ?? '',
      });
      return {
        content: [{ type: 'text', text: opts.rawText ?? opts.reply ?? '' }],
      };
    },
  };
  return { client, calls };
}

function makeExtractor(opts: { reply?: string; throwOnCall?: boolean; rawText?: string }) {
  const fake = makeFakeAnthropic(opts);
  const extractor = createHaikuPalaiaExcerptExtractor({
    llm: fake.client as never,
    log: () => {},
  });
  return { extractor, calls: fake.calls };
}

const ANSWER = 'Wir nutzen pgvector. Die Embedding-Dimension ist 768. Migration 0007 ist deployed.';

describe('Slice 4a · createHaikuPalaiaExcerptExtractor', () => {
  it('skips the LLM call when assistant answer is empty', async () => {
    const { extractor, calls } = makeExtractor({ reply: 'should-not-show' });
    const out = await extractor.extract({
      cleanedUserMessage: 'Welche Embedding-Dim?',
      cleanedAssistantAnswer: '   ',
    });
    assert.equal(out, undefined);
    assert.equal(calls.length, 0);
  });

  it('hint precedence: entryTypeHint=process → reference, source=hint, no LLM call', async () => {
    const { extractor, calls } = makeExtractor({ reply: 'should-not-show' });
    const out = await extractor.extract({
      cleanedUserMessage: 'Wie deploye ich?',
      cleanedAssistantAnswer: 'Schritt 1: build. Schritt 2: push.',
      entryTypeHint: 'process',
    });
    assert.ok(out);
    assert.equal(out.suggestedKind, 'reference');
    assert.equal(out.source, 'hint');
    assert.equal(out.excerpts.length, 0);
    assert.match(out.suggestedSummary, /Schritt 1: build\. Schritt 2: push\./);
    assert.equal(calls.length, 0);
  });

  it('hint mapping memory → insight', async () => {
    const { extractor } = makeExtractor({ reply: '' });
    const out = await extractor.extract({
      cleanedUserMessage: '',
      cleanedAssistantAnswer: 'fact body',
      entryTypeHint: 'memory',
    });
    assert.equal(out?.suggestedKind, 'insight');
  });

  it('hint mapping task → decision', async () => {
    const { extractor } = makeExtractor({ reply: '' });
    const out = await extractor.extract({
      cleanedUserMessage: '',
      cleanedAssistantAnswer: 'do the thing',
      entryTypeHint: 'task',
    });
    assert.equal(out?.suggestedKind, 'decision');
  });

  it('happy path: valid Haiku JSON → normalised PalaiaExcerpt with source=llm', async () => {
    const reply = JSON.stringify({
      kind: 'reference',
      summary: 'pgvector mit Dim 768 nach Migration 0007.',
      rationale: 'Hardcoded auf 768 wegen voyage-3-lite.',
      excerpts: [
        'Die Embedding-Dimension ist 768.',
        'Migration 0007 ist deployed.',
      ],
    });
    const { extractor, calls } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'Welche Embedding-Dim?',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.ok(out);
    assert.equal(out.suggestedKind, 'reference');
    assert.equal(out.source, 'llm');
    assert.equal(
      out.suggestedSummary,
      'pgvector mit Dim 768 nach Migration 0007.',
    );
    assert.equal(out.suggestedRationale, 'Hardcoded auf 768 wegen voyage-3-lite.');
    assert.equal(out.excerpts.length, 2);
    assert.equal(calls.length, 1);
    // Both <user> and <assistant> blocks made it into the prompt.
    assert.match(calls[0]!.userContent, /<user>/);
    assert.match(calls[0]!.userContent, /<assistant>/);
  });

  it('drops markdown fence around JSON reply', async () => {
    const reply = '```json\n{"kind":"insight","summary":"x","rationale":null,"excerpts":[]}\n```';
    const { extractor } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.equal(out?.suggestedKind, 'insight');
    assert.equal(out?.suggestedSummary, 'x');
    assert.equal(out?.suggestedRationale, undefined);
  });

  it('non-JSON reply → undefined', async () => {
    const { extractor } = makeExtractor({ reply: 'just some prose, no JSON' });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.equal(out, undefined);
  });

  it('empty Haiku response → undefined', async () => {
    const { extractor } = makeExtractor({ rawText: '' });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.equal(out, undefined);
  });

  it('invalid kind enum → fallback insight', async () => {
    const reply = JSON.stringify({
      kind: 'tag-cloud-overlord',
      summary: 'something',
      rationale: null,
      excerpts: [],
    });
    const { extractor } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.equal(out?.suggestedKind, 'insight');
  });

  it('empty summary → fallback to answer prefix', async () => {
    const reply = JSON.stringify({
      kind: 'insight',
      summary: '   ',
      rationale: null,
      excerpts: [],
    });
    const { extractor } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.ok(out);
    assert.ok(out.suggestedSummary.length > 0);
    assert.match(out.suggestedSummary, /pgvector|Migration/);
  });

  it('excerpts capped at 5 + each at 300 chars', async () => {
    const huge = 'x'.repeat(500);
    const reply = JSON.stringify({
      kind: 'reference',
      summary: 's',
      rationale: null,
      excerpts: [huge, huge, huge, huge, huge, huge, huge, 'small'],
    });
    const { extractor } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.equal(out?.excerpts.length, 5);
    for (const e of out!.excerpts) {
      assert.ok(e.length <= 300, `excerpt length ${e.length} > 300`);
    }
  });

  it('summary capped at 500 chars', async () => {
    const longSummary = 'a'.repeat(800);
    const reply = JSON.stringify({
      kind: 'insight',
      summary: longSummary,
      rationale: null,
      excerpts: [],
    });
    const { extractor } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.ok(out);
    assert.ok(out.suggestedSummary.length <= 500);
  });

  it('Anthropic throws → undefined (no propagation)', async () => {
    const { extractor } = makeExtractor({ throwOnCall: true });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.equal(out, undefined);
  });

  it('excerpts: non-string entries are dropped', async () => {
    const reply = JSON.stringify({
      kind: 'reference',
      summary: 's',
      rationale: null,
      excerpts: ['valid', 42, null, '', 'also-valid'],
    });
    const { extractor } = makeExtractor({ reply });
    const out = await extractor.extract({
      cleanedUserMessage: 'q',
      cleanedAssistantAnswer: ANSWER,
    });
    assert.deepEqual(out?.excerpts, ['valid', 'also-valid']);
  });
});
