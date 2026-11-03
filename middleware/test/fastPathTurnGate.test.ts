/**
 * Fast-path TURN GATE (@omadia/fast-path turnGate.ts + slotCandidates.ts):
 * every decision of a turn in ONE decision-model batch — data/model, route,
 * plan hint, source, a speculative direct plan with its slots filled from
 * the turn (P2) — and the plan hint's way to the plan-runner.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DecisionBatchRequest, DecisionBatchResult, DecisionModelService } from '@omadia/plugin-api';

import type { FastLlm } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import type { LearnedPlan } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { PLAN_EXAMPLE, PLANNER_TOOL } from '../packages/harness-plugin-fast-path/src/planner.js';
import { ROUTER_TOOL } from '../packages/harness-plugin-fast-path/src/router.js';
import {
  fillSlots,
  fixedVocabulary,
  isFillable,
  planSlots,
  slotCandidates,
} from '../packages/harness-plugin-fast-path/src/slotCandidates.js';
import type { StoredTextPrivacyRun } from '../packages/harness-plugin-fast-path/src/storedTextPrivacy.js';
import { triageTurn } from '../packages/harness-plugin-fast-path/src/triageTurn.js';
import { TURN_GATE_TASK } from '../packages/harness-plugin-fast-path/src/turnGate.js';
import { passThroughReason } from '../packages/harness-orchestrator/src/fastPathAgent.js';

type Req = Parameters<FastLlm['complete']>[0];
type Res = Awaited<ReturnType<FastLlm['complete']>>;

const TOOLS = [{ name: 'odoo_query', spec: 'odoo_query — Odoo search_read.' }];
const ALLOWED = new Set(['odoo_query']);

function fakeLlm(): { llm: FastLlm; reqs: Req[] } {
  const reqs: Req[] = [];
  return {
    reqs,
    llm: {
      complete: (req) => {
        reqs.push(req);
        const name = req.toolChoice?.name;
        const input = name === PLANNER_TOOL ? PLAN_EXAMPLE : { decision: 'deterministic', tool: 'odoo_query', confidence: 0.9 };
        return Promise.resolve({ text: '', toolCalls: [{ name: name ?? ROUTER_TOOL, input }] } as Res);
      },
    },
  };
}

/** A batch-capable decision model answering from `answer(req)`. */
function batchModel(answer: (req: DecisionBatchRequest) => DecisionBatchResult | Error): {
  decide: DecisionModelService;
  reqs: DecisionBatchRequest[];
  chooses: number;
} {
  const state = { reqs: [] as DecisionBatchRequest[], chooses: 0 };
  return {
    get reqs() {
      return state.reqs;
    },
    get chooses() {
      return state.chooses;
    },
    decide: {
      provider: 'jev',
      choose: () => {
        state.chooses++;
        return Promise.reject(new Error('choose must not be called when decideAll exists'));
      },
      decideAll: (req) => {
        state.reqs.push(req);
        const r = answer(req);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    },
  };
}

const yes = (probability: number) => ({ kind: 'yesno' as const, probability });
const pick = (choice: string, confidence: number) => ({ kind: 'choice' as const, choice, confidence });

const OPEN_ITEMS_OF = {
  ...PLAN_EXAMPLE.input,
  domain: [...PLAN_EXAMPLE.input.domain, ['partner_id.name', 'ilike', '%{{text_1}}%']],
};

function learned(over: Partial<LearnedPlan> = {}): LearnedPlan {
  return {
    id: 'p1',
    tool: 'odoo_query',
    inputTemplate: PLAN_EXAMPLE.input,
    map: { ...PLAN_EXAMPLE.map },
    rowKey: 'id',
    itemsPath: 'records',
    examples: ['offene posten'],
    successes: 2,
    failures: 0,
    active: true,
    createdAt: '2026-11-01T00:00:00Z',
    lastUsed: '2026-11-01T00:00:00Z',
    ...over,
  };
}

/** a running shield that maps the surrogate back to the real name */
const shield = (surrogate?: [string, string]): StoredTextPrivacyRun =>
  ({
    mask: (t: string) => Promise.resolve({ send: true, text: surrogate ? t.split(surrogate[1]).join(surrogate[0]) : t }),
    restore: (t: string) => (surrogate ? t.split(surrogate[0]).join(surrogate[1]) : t),
  }) as unknown as StoredTextPrivacyRun;

function triage(opts: {
  llm: FastLlm;
  decide: DecisionModelService;
  question?: string;
  offered?: LearnedPlan[];
  privacy?: StoredTextPrivacyRun;
  logs?: string[];
}): ReturnType<typeof triageTurn> {
  return triageTurn({
    llm: opts.llm,
    model: 'class:fast',
    channel: 'web',
    question: opts.question ?? 'Welche Posten sind offen?',
    tools: TOOLS,
    offered: opts.offered ?? [],
    allowedTools: ALLOWED,
    decide: opts.decide,
    directPlans: true,
    ...(opts.privacy ? { privacy: opts.privacy } : {}),
    log: (m) => opts.logs?.push(m),
  });
}

describe('turn gate — ONE batch request', () => {
  it('asks data, complex, plan and source in one request; no choose, no LLM for a model turn', async () => {
    const f = fakeLlm();
    const m = batchModel(() => ({ answers: { data: yes(0.1), complex: yes(0.8), plan: yes(0.2) }, model: 'jev-1.14.0' }));
    const out = await triage({ llm: f.llm, decide: m.decide });
    assert.equal(m.reqs.length, 1);
    assert.equal(m.reqs[0]?.task, TURN_GATE_TASK);
    assert.deepEqual(Object.keys(m.reqs[0]?.questions ?? {}).sort(), ['complex', 'data', 'plan', 'source']);
    assert.equal(m.chooses, 0);
    assert.equal(f.reqs.length, 0);
    assert.equal(out.kind, 'agent');
    if (out.kind !== 'agent') return;
    assert.equal(out.route, 'complex');
    assert.equal(out.planHint, 'direct');
    assert.deepEqual({ ...out.decision, ms: 0 }, { provider: 'jev', model: 'jev-1.14.0', verdict: 'model', route: 'complex', confidence: 0.9, ms: 0 });
  });

  it('route and plan hint follow the yes/no probabilities', async () => {
    const simple = await triage({ llm: fakeLlm().llm, decide: batchModel(() => ({ answers: { data: yes(0.2), complex: yes(0.3), plan: yes(0.9) } })).decide });
    assert.equal(simple.kind === 'agent' && simple.route, 'simple');
    assert.equal(simple.kind === 'agent' && simple.planHint, 'plan');
    const unsurePlan = await triage({ llm: fakeLlm().llm, decide: batchModel(() => ({ answers: { data: yes(0.2), complex: yes(0.6), plan: yes(0.5) } })).decide });
    assert.equal(unsurePlan.kind === 'agent' && unsurePlan.planHint, undefined);
  });

  it('a data turn: the source from the batch, then ONE planner call (no router)', async () => {
    const f = fakeLlm();
    const m = batchModel(() => ({ answers: { data: yes(0.9), complex: yes(0.2), plan: yes(0.1), source: pick('tool:odoo_query', 0.95) } }));
    const out = await triage({ llm: f.llm, decide: m.decide });
    assert.equal(out.kind, 'plan');
    assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name), [PLANNER_TOOL]);
    assert.equal(out.decision?.verdict, 'data');
    assert.equal(out.decision?.tool, 'odoo_query');
  });

  it('undecided (data between the bars), a missing data answer or a provider error → the LLM router ∥ planner', async () => {
    for (const answer of [
      () => ({ answers: { data: yes(0.5), complex: yes(0.5), plan: yes(0.5) } }),
      () => ({ answers: { complex: yes(0.5) } }),
      () => new Error('HTTP 529'),
    ]) {
      const f = fakeLlm();
      const out = await triage({ llm: f.llm, decide: batchModel(answer).decide });
      assert.equal(out.kind, 'plan');
      assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name).sort(), [PLANNER_TOOL, ROUTER_TOOL].sort());
    }
  });
});

describe('turn gate — direct plans and slot filling (P2)', () => {
  const dataAnswers = { data: yes(0.95), complex: yes(0.1), plan: yes(0.1), source: pick('tool:odoo_query', 0.95) };

  it('a placeholder-free plan picked in the same request runs with ZERO LLM calls', async () => {
    const f = fakeLlm();
    const m = batchModel(() => ({ answers: { ...dataAnswers, direct: pick('plan:p1', 0.95) } }));
    const out = await triage({ llm: f.llm, decide: m.decide, offered: [learned()], privacy: shield() });
    assert.equal(out.kind, 'plan');
    assert.equal(f.reqs.length, 0);
    assert.equal(out.decision?.direct, true);
    assert.equal(m.reqs.length, 1, 'direct asked speculatively, not chained');
  });

  it('a plan with {{text_1}}: the slot is picked from the masked turn and restored to the real value', async () => {
    const f = fakeLlm();
    const plan = learned({ inputTemplate: OPEN_ITEMS_OF, examples: ['offene posten von {{text_1}}'] });
    const m = batchModel((req) => {
      const slot = req.questions['slot_0_0'];
      assert.ok(slot && slot.kind === 'choice');
      const idx = slot.options.findIndex((o) => o.description === 'Lukas Becker');
      assert.ok(idx >= 0, `surrogate offered as a candidate: ${JSON.stringify(slot.options)}`);
      assert.ok(!slot.options.some((o) => o.description === 'Anna Schmidt'), 'the real name never leaves');
      return { answers: { ...dataAnswers, direct: pick('plan:p1', 0.93), slot_0_0: pick(slot.options[idx]!.id, 0.97) } };
    });
    const out = await triage({
      llm: f.llm,
      decide: m.decide,
      question: 'Offene Posten von Anna Schmidt',
      offered: [plan],
      privacy: shield(['Lukas Becker', 'Anna Schmidt']),
    });
    assert.equal(out.kind, 'plan');
    assert.equal(f.reqs.length, 0, 'no planner');
    const domain = out.kind === 'plan' ? (out.plan.fetch.input as { domain: unknown[] }).domain : [];
    assert.deepEqual(domain.at(-1), ['partner_id.name', 'ilike', '%Anna Schmidt%']);
  });

  it('a weak slot pick, "none", a digit in the question or no shield → the planner', async () => {
    const plan = learned({ inputTemplate: OPEN_ITEMS_OF, examples: ['offene posten von {{text_1}}'] });
    const cases: Array<{ slot: [string, number]; question?: string; noShield?: boolean }> = [
      { slot: ['c0', 0.6] },
      { slot: ['none', 0.99] },
      { slot: ['c0', 0.99], question: 'Offene Posten von Anna Schmidt seit 2024' },
      { slot: ['c0', 0.99], noShield: true },
    ];
    for (const c of cases) {
      const f = fakeLlm();
      const m = batchModel(() => ({ answers: { ...dataAnswers, direct: pick('plan:p1', 0.95), slot_0_0: pick(c.slot[0], c.slot[1]) } }));
      const out = await triage({
        llm: f.llm,
        decide: m.decide,
        question: c.question ?? 'Offene Posten von Anna Schmidt',
        offered: [plan],
        ...(c.noShield ? {} : { privacy: shield() }),
      });
      assert.equal(out.kind, 'plan');
      assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name), [PLANNER_TOOL], JSON.stringify(c));
    }
  });

  it('a plan with an id slot or a top-N is never a candidate', async () => {
    const m = batchModel(() => ({ answers: dataAnswers }));
    await triage({
      llm: fakeLlm().llm,
      decide: m.decide,
      offered: [
        learned({ id: 'ids', inputTemplate: { ...PLAN_EXAMPLE.input, domain: [['partner_id', '=', '{{id_1}}']] } }),
        learned({ id: 'top', take: 5 }),
      ],
      privacy: shield(),
    });
    assert.equal(m.reqs[0]?.questions['direct'], undefined);
  });
});

describe('slot candidates', () => {
  it('capitalised runs, company suffixes, quotes and e-mails — minus question words and the stored vocabulary', () => {
    const fixed = fixedVocabulary(['offene posten von {{text_1}}']);
    assert.deepEqual(
      slotCandidates('USER TURN: Welche offenen Posten hat die Müller GmbH und "acme labs" bei max@example.com?', fixed),
      ['acme labs', 'max@example.com', 'Müller GmbH'],
    );
  });

  it('planSlots / isFillable / fillSlots keep wildcards and refuse id slots', () => {
    assert.deepEqual(planSlots({ a: ['%{{text_1}}%', { b: '{{email_1}}' }] }), ['{{text_1}}', '{{email_1}}']);
    assert.equal(isFillable({ a: '{{text_1}}' }), true);
    assert.equal(isFillable({ a: '{{id_1}}' }), false);
    assert.equal(isFillable({ a: '{{text_1}} {{text_2}} {{text_3}}' }), false);
    assert.deepEqual(fillSlots({ d: ['name', 'ilike', '%{{text_1}}%'] }, new Map([['{{text_1}}', 'Acme']])), { d: ['name', 'ilike', '%Acme%'] });
    assert.equal(fillSlots({ d: '{{text_2}}' }, new Map([['{{text_1}}', 'Acme']])), undefined);
  });
});

describe('plan hint — a trusted wrapper field', () => {
  it('a turn that already carries a planHint is never triaged again', () => {
    assert.equal(passThroughReason({ userMessage: 'x', sessionScope: 'tab_1', planHint: 'plan' }), 'system');
  });
});
