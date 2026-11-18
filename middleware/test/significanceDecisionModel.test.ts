/**
 * Significance scorer on `decisionModel@1`: one batch (`significant` yes/no →
 * score, `entry_type` choice) instead of the LLM call; the LLM stays the
 * fallback. Plus the orchestrator-extras kill switches
 * (`recall_decision_model`, `significance_decision_model`) through the real
 * `activate()`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import YAML from 'yaml';
import type { LlmProvider, LlmProviderPool, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { DecisionBatchRequest, DecisionModelService } from '@omadia/plugin-api';

import { activate } from '../packages/harness-orchestrator-extras/src/plugin.js';
import { createHaikuSignificanceScorer } from '../packages/harness-orchestrator-extras/src/significanceScorer.js';
import { fakePluginContext } from './_helpers/fakePluginContext.js';

function recordingLlm(reply = '{"score":0.3,"entry_type":"memory"}'): LlmProvider & {
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      requests.push(req);
      return { content: [{ type: 'text', text: reply }] } as unknown as LlmResponse;
    },
  } as unknown as LlmProvider & { requests: LlmRequest[] };
}

function fakeDecision(
  answer: () => Record<string, unknown> | Error,
): DecisionModelService & { requests: DecisionBatchRequest[] } {
  const requests: DecisionBatchRequest[] = [];
  return {
    provider: 'fake',
    requests,
    choose: async () => {
      throw new Error('choose must not be used');
    },
    decideAll: async (req: DecisionBatchRequest) => {
      requests.push(req);
      const out = answer();
      if (out instanceof Error) throw out;
      return { answers: out as never };
    },
  };
}

const GOOD = {
  significant: { kind: 'yesno', probability: 0.87 },
  entry_type: { kind: 'choice', choice: 'process', confidence: 0.9 },
};

describe('significance scorer · decisionModel@1', () => {
  it('scores from ONE batch without an LLM call', async () => {
    const llm = recordingLlm();
    const decide = fakeDecision(() => GOOD);
    const logs: string[] = [];
    const scorer = createHaikuSignificanceScorer({ llm, decide: () => decide, log: (m) => logs.push(m) });
    const result = await scorer.score('Die Tabelle res.partner hält die Kunden.');
    assert.deepEqual(result, { score: 0.87, suggestedEntryType: 'process' });
    assert.equal(llm.requests.length, 0);
    assert.equal(decide.requests.length, 1);
    const req = decide.requests[0]!;
    assert.equal(req.input, 'Die Tabelle res.partner hält die Kunden.');
    assert.equal(req.questions['significant']?.kind, 'yesno');
    const entry = req.questions['entry_type'];
    assert.equal(entry?.kind, 'choice');
    assert.deepEqual(
      entry?.kind === 'choice' ? entry.options.map((o) => o.id) : [],
      ['memory', 'process', 'task'],
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /provider=fake ms=\d+ score=0\.87 entry_type=process/);
    assert.ok(!logs[0]!.includes('res.partner'));
  });

  for (const [name, answer] of [
    ['a throw', () => new Error('boom')],
    ['a missing entry_type', () => ({ significant: GOOD.significant })],
    ['an unknown entry_type', () => ({ ...GOOD, entry_type: { kind: 'choice', choice: 'note', confidence: 1 } })],
    ['a missing significance', () => ({ entry_type: GOOD.entry_type })],
  ] as const) {
    it(`falls back to the LLM on ${name}`, async () => {
      const llm = recordingLlm();
      const decide = fakeDecision(answer as never);
      const scorer = createHaikuSignificanceScorer({ llm, decide: () => decide, log: () => {} });
      const result = await scorer.score('hello');
      assert.deepEqual(result, { score: 0.3, suggestedEntryType: 'memory' });
      assert.equal(llm.requests.length, 1);
    });
  }

  it('falls back to the LLM without decideAll or without a provider', async () => {
    for (const decide of [
      () => ({ provider: 'single', choose: async () => ({ choice: 'x', confidence: 1 }) }) as DecisionModelService,
      () => undefined,
    ]) {
      const llm = recordingLlm();
      const scorer = createHaikuSignificanceScorer({ llm, decide, log: () => {} });
      await scorer.score('hello');
      assert.equal(llm.requests.length, 1);
    }
  });

  it('never asks the decision model when masking refuses the text', async () => {
    const decide = fakeDecision(() => GOOD);
    const scorer = createHaikuSignificanceScorer({
      llm: recordingLlm(),
      decide: () => decide,
      privacy: () => ({
        mask: async () => ({ send: false as const, reason: 'blocked' }),
        restore: async (t: string) => t,
      }),
      log: () => {},
    });
    await assert.rejects(() => scorer.score('Kunde X'), /privacy: blocked/);
    assert.equal(decide.requests.length, 0);
  });
});

describe('orchestrator-extras · decision model kill switches', () => {
  function kernelPool(complete: (req: LlmRequest) => Promise<LlmResponse>): LlmProviderPool {
    return {
      get: async (id: string) => (id === 'anthropic' ? ({ id, complete } as unknown as LlmProvider) : undefined),
      usable: async (id: string) => id === 'anthropic',
      invalidate: () => undefined,
      invalidateAll: () => undefined,
      cachedIds: () => ['anthropic'],
    } as unknown as LlmProviderPool;
  }

  async function classifyWith(config: Record<string, unknown>) {
    const llm = recordingLlm('{"score":0.9,"entry_type":"memory"}');
    const decide = fakeDecision(() => GOOD);
    const fake = fakePluginContext({
      config,
      services: {
        knowledgeGraph: {},
        embeddingClient: {},
        llmProviderPool: kernelPool((req) => llm.complete(req)),
        decisionModel: decide,
      },
    });
    const handle = await activate(fake.ctx);
    try {
      const filter = fake.provided.get('captureFilter') as {
        classify(input: { userMessage: string; assistantAnswer: string }): Promise<unknown>;
      };
      await filter.classify({
        userMessage: 'We moved the release to Friday.',
        assistantAnswer: 'Noted, the release is on Friday now.',
      });
      return { llm, decide, logs: fake.logs };
    } finally {
      await handle.close();
    }
  }

  it('scores on the decision model by default', async () => {
    const { llm, decide, logs } = await classifyWith({});
    assert.equal(decide.requests.length, 1);
    assert.equal(llm.requests.length, 0);
    assert.ok(logs.some((l) => l.includes('decision model: recall=on, significance=on')));
  });

  it('significance_decision_model=false keeps the scorer on the LLM', async () => {
    for (const off of [false, 'false']) {
      const { llm, decide, logs } = await classifyWith({ significance_decision_model: off });
      assert.equal(decide.requests.length, 0);
      assert.equal(llm.requests.length, 1);
      assert.ok(logs.some((l) => l.includes('significance=off')));
    }
  });

  it('recall_decision_model=false is read and logged', async () => {
    const { logs } = await classifyWith({ recall_decision_model: false });
    assert.ok(logs.some((l) => l.includes('decision model: recall=off, significance=on')));
  });

  it('the manifest declares decisionModel@1 and both switches (boolean, default on)', () => {
    const manifest = YAML.parse(
      readFileSync(new URL('../packages/harness-orchestrator-extras/manifest.yaml', import.meta.url), 'utf8'),
    ) as {
      optional_requires: string[];
      setup: { fields: Array<{ key: string; type: string; default?: string; label: Record<string, string>; help: Record<string, string> }> };
    };
    assert.ok(manifest.optional_requires.includes('decisionModel@1'));
    for (const key of ['recall_decision_model', 'significance_decision_model']) {
      const field = manifest.setup.fields.find((f) => f.key === key);
      assert.ok(field, key);
      assert.equal(field.type, 'boolean');
      assert.equal(field.default, 'true');
      assert.ok(field.label['en'] && field.label['de'] && field.help['en'] && field.help['de']);
    }
  });
});
