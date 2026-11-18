/**
 * Recall relevance judge on `decisionModel@1`: one batch with a yes/no per
 * recalled item instead of the LLM call; the LLM stays the fallback for a
 * throw, missing answers or a provider without `decideAll`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { DecisionBatchRequest, DecisionModelService } from '@omadia/plugin-api';

import { createJobPrivacy } from '../packages/harness-orchestrator-extras/src/jobPrivacy.js';
import {
  createRecallRelevanceJudge,
  type RecallCandidate,
} from '../packages/harness-orchestrator-extras/src/recallRelevanceJudge.js';

const CANDIDATES: RecallCandidate[] = [
  { id: 'plan:a', kind: 'plan', text: 'weekly course list for Kurse' },
  { id: 'process:b', kind: 'process', text: 'deploy to staging' },
  { id: 'mk:c', kind: 'insight', text: 'generic: no Odoo access, use Dynamics' },
];

function recordingLlm(relevant: string[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      requests.push(req);
      return {
        content: [{ type: 'text', text: JSON.stringify({ relevant }) }],
      } as unknown as LlmResponse;
    },
  } as unknown as LlmProvider & { requests: LlmRequest[] };
}

function fakeDecision(
  answer: (req: DecisionBatchRequest) => Record<string, unknown> | Error,
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
      const out = answer(req);
      if (out instanceof Error) throw out;
      return { answers: out as never };
    },
  };
}

const yes = (p: number) => ({ kind: 'yesno', probability: p });

describe('recall judge · decisionModel@1', () => {
  it('keeps items with probability >= 0.5 from ONE batch, without an LLM call', async () => {
    const llm = recordingLlm(['mk:c']);
    const decide = fakeDecision(() => ({ item_0: yes(0.91), item_1: yes(0.5), item_2: yes(0.12) }));
    const logs: string[] = [];
    const judge = createRecallRelevanceJudge({
      llm,
      model: 'fast',
      decide: () => decide,
      log: (m) => logs.push(m),
    });
    const kept = await judge.filterRelevant('Kurse diese Woche', CANDIDATES);
    assert.deepEqual([...kept].sort(), ['plan:a', 'process:b']);
    assert.equal(llm.requests.length, 0);
    assert.equal(decide.requests.length, 1);
    const req = decide.requests[0]!;
    assert.equal(req.input, 'Kurse diese Woche');
    assert.deepEqual(Object.keys(req.questions), ['item_0', 'item_1', 'item_2']);
    assert.equal(req.questions['item_2']?.kind, 'yesno');
    assert.match(req.questions['item_2']!.instruction, /generic: no Odoo access/);
    // one log line, counts only — never the message or item text
    const line = logs.find((l) => l.includes('decision model'));
    assert.ok(line);
    assert.match(line, /provider=fake ms=\d+ kept=2\/3/);
    assert.ok(!logs.join('\n').includes('Kurse'));
  });

  it('replays a cached decision verdict without asking again', async () => {
    const llm = recordingLlm([]);
    const decide = fakeDecision(() => ({ item_0: yes(0.9), item_1: yes(0.1), item_2: yes(0.1) }));
    const judge = createRecallRelevanceJudge({ llm, model: 'fast', decide: () => decide, log: () => {} });
    await judge.filterRelevant('Kurse diese Woche', CANDIDATES);
    const again = await judge.filterRelevant('Kurse diese Woche', CANDIDATES);
    assert.deepEqual([...again], ['plan:a']);
    assert.equal(decide.requests.length, 1);
    assert.equal(llm.requests.length, 0);
  });

  for (const [name, answer] of [
    ['a throw', () => new Error('timeout')],
    ['a missing answer', () => ({ item_0: yes(0.9), item_1: yes(0.1) })],
    ['a wrong-kind answer', () => ({ item_0: yes(0.9), item_1: yes(0.1), item_2: { kind: 'choice', choice: 'x', confidence: 1 } })],
    ['a non-finite probability', () => ({ item_0: yes(0.9), item_1: yes(Number.NaN), item_2: yes(0.1) })],
  ] as const) {
    it(`falls back to the LLM on ${name}`, async () => {
      const llm = recordingLlm(['mk:c']);
      const decide = fakeDecision(answer as never);
      const judge = createRecallRelevanceJudge({ llm, model: 'fast', decide: () => decide, log: () => {} });
      const kept = await judge.filterRelevant('Kurse diese Woche', CANDIDATES);
      assert.deepEqual([...kept], ['mk:c']);
      assert.equal(decide.requests.length, 1);
      assert.equal(llm.requests.length, 1);
    });
  }

  it('falls back to the LLM when the provider has no decideAll, the lookup throws, or none runs', async () => {
    const choiceOnly: DecisionModelService = {
      provider: 'single',
      choose: async () => ({ choice: 'x', confidence: 1 }),
    };
    const lookups: Array<() => DecisionModelService | undefined> = [
      () => choiceOnly,
      () => {
        throw new Error('ServiceNotDeclaredError');
      },
      () => undefined,
    ];
    for (const decide of lookups) {
      const llm = recordingLlm(['plan:a']);
      const judge = createRecallRelevanceJudge({ llm, model: 'fast', decide, log: () => {} });
      const kept = await judge.filterRelevant('Kurse diese Woche', CANDIDATES);
      assert.deepEqual([...kept], ['plan:a']);
      assert.equal(llm.requests.length, 1);
    }
  });

  it('sends only the masked message and items to the decision model', async () => {
    const REAL = 'Erika Mustermann';
    const guard = {
      openStoredTextScope: () => ({
        maskStoredText: async (text: string) => ({
          outcome: 'masked',
          maskedText: text.split(REAL).join('[PERSON_1]'),
        }),
        restoreStoredText: async (text: string) => text,
      }),
    };
    const decide = fakeDecision(() => ({ item_0: yes(0.9), item_1: yes(0.9) }));
    const llm = recordingLlm([]);
    const judge = createRecallRelevanceJudge({
      llm,
      model: 'fast',
      decide: () => decide,
      privacy: createJobPrivacy(() => guard as never, {}),
      log: () => {},
    });
    const kept = await judge.filterRelevant(`Kurse von ${REAL}\nnächste Woche`, [
      { id: 'plan:a', kind: 'plan', text: `Kursliste ${REAL}` },
      { id: 'process:b', kind: 'process', text: 'deploy' },
    ]);
    assert.equal(kept.size, 2);
    const wire = JSON.stringify(decide.requests);
    assert.ok(!wire.includes(REAL), wire);
    assert.ok(wire.includes('[PERSON_1]'));
    assert.equal(decide.requests[0]?.input, 'Kurse von [PERSON_1]\nnächste Woche');
  });
});
