/**
 * The fast-path side of the canvas decision model (`decisionModel@1`): on the
 * canvas the gate's data question carries the chart clause, and `triageTurn`
 * reports the gate verdict once through `onGate`.
 *
 * The canvas side (the gate picks the view, `canvas.layout`, the batch gate on
 * the canvas, decisionCanvas building blocks) is tested in the plugin repo
 * byte5ai/omadia-ui-support,
 * packages/ui-orchestrator/test/canvasDecisionModelCanvas.test.ts.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  DecisionChoiceRequest,
  DecisionChoiceResult,
  DecisionModelService,
} from '@omadia/plugin-api';

import {
  CANVAS_GATE_CLAUSE,
  GATE_TASK,
  routeByDecision,
  SOURCE_TASK,
  type GateSignal,
} from '../packages/harness-plugin-fast-path/src/decisionRouter.js';
import { DATA_QUESTION, turnGateQuestions } from '../packages/harness-plugin-fast-path/src/turnGate.js';
import { triageTurn } from '../packages/harness-plugin-fast-path/src/triageTurn.js';

// ── fixtures ──────────────────────────────────────────────────────────────

/** A decision model answering per task; a missing answer is a provider error. */
function fakeDecide(
  answers: Partial<Record<string, Partial<DecisionChoiceResult>>>,
): { decide: DecisionModelService; reqs: DecisionChoiceRequest[] } {
  const reqs: DecisionChoiceRequest[] = [];
  return {
    reqs,
    decide: {
      provider: 'jev',
      choose: (req) => {
        reqs.push(req);
        const a = answers[req.task];
        if (a === undefined) return Promise.reject(new Error(`no answer for ${req.task}`));
        return Promise.resolve({ choice: '', confidence: 0, ...a } as DecisionChoiceResult);
      },
    },
  };
}

const DATA = {
  [GATE_TASK]: { choice: 'data', confidence: 0.95, model: 'jev-1.14.0' },
  [SOURCE_TASK]: { choice: 'tool:odoo_query', confidence: 0.9 },
};

describe('gate wording — the canvas widens the data question', () => {
  const tools = [{ name: 'odoo_query', spec: 'odoo_query — Odoo search_read.' }];

  it('turn gate: the canvas adds the chart clause, other channels keep the plain question', () => {
    const canvas = turnGateQuestions({ tools, candidates: [], message: 'x', channel: 'canvas' });
    const web = turnGateQuestions({ tools, candidates: [], message: 'x', channel: 'web' });
    assert.equal(canvas.questions['data']?.instruction, DATA_QUESTION + CANVAS_GATE_CLAUSE);
    assert.equal(web.questions['data']?.instruction, DATA_QUESTION);
  });

  it('single gate: the same clause on the canvas only', async () => {
    for (const [channel, widened] of [
      ['canvas', true],
      ['web', false],
    ] as const) {
      const d = fakeDecide({ [GATE_TASK]: { choice: 'model_complex', confidence: 0.9 } });
      await routeByDecision({ decide: d.decide, channel, message: 'USER TURN: x', tools, log: () => {} });
      assert.equal(d.reqs[0]?.instruction.endsWith(CANVAS_GATE_CLAUSE), widened, channel);
    }
  });
});

describe('triageTurn — onGate', () => {
  const tools = [{ name: 'odoo_query', spec: 'odoo_query — Odoo search_read.' }];
  const llm = { complete: () => Promise.resolve({ text: '' }) };

  it('tells the gate once: data as soon as the gate answered, none without a decision model', async () => {
    const seen: GateSignal[] = [];
    await triageTurn({
      llm,
      model: 'm',
      channel: 'canvas',
      question: 'offene Rechnungen',
      tools,
      offered: [],
      allowedTools: new Set(['odoo_query']),
      decide: fakeDecide(DATA).decide,
      onGate: (g) => seen.push(g),
      log: () => {},
    });
    assert.deepEqual(seen, [{ verdict: 'data', confidence: 0.95 }]);
    const none: GateSignal[] = [];
    await triageTurn({
      llm,
      model: 'm',
      channel: 'canvas',
      question: 'x',
      tools,
      offered: [],
      allowedTools: new Set(['odoo_query']),
      onGate: (g) => none.push(g),
      log: () => {},
    });
    assert.deepEqual(none, [{ verdict: 'none' }]);
  });
});
