/**
 * The canvas on a typed decision model (`decisionModel@1`, omadia-ui-orchestrator
 * decisionCanvas.ts): the gate picks the VIEW — `data` → the plan's skeleton
 * without the composer, `model`+`simple` → a plain answer view the agent's
 * answer fills, anything else → the composer as before; `canvas.layout`
 * turns a planned table into a chart when the rows fit one; every answer of
 * the decision model rides on `done.fastPathDecision` and, on the canvas
 * wire, on `turn_complete.decision`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DecisionChoiceRequest, DecisionChoiceResult, DecisionModelService } from '@omadia/plugin-api';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
  type FastPathDecision,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import type { CompositionLlm } from '../packages/omadia-ui-orchestrator/src/composition.js';
import {
  canvasDecision,
  chartColumns,
  LAYOUT_TASK,
  peekGate,
} from '../packages/omadia-ui-orchestrator/src/decisionCanvas.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { GATE_TASK, SOURCE_TASK, type GateSignal } from '../packages/harness-plugin-fast-path/src/decisionRouter.js';
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import { triageTurn } from '../packages/harness-plugin-fast-path/src/triageTurn.js';
import { toTurnDecision } from '../packages/omadia-ui-channel/src/canvasConnection.js';
import { withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const INVOICES = [
  { id: 11, name: 'R/2026/011', partner_id: [1, 'Alpha GmbH'], amount_residual: 1200.5 },
  { id: 12, name: 'R/2026/012', partner_id: [2, 'Beta AG'], amount_residual: 800 },
  { id: 13, name: 'R/2026/013', partner_id: [3, 'Gamma KG'], amount_residual: 450.25 },
];

const odooOutput = (records: unknown[]): string =>
  JSON.stringify({ model: 'account.move', scope: 'accounting', count: records.length, truncated: false, records });

const INVOICE_FETCH = {
  tool: 'odoo_query',
  input: {
    model: 'account.move',
    domain: [['payment_state', '=', 'not_paid']],
    fields: ['name', 'partner_id', 'amount_residual'],
    limit: 100,
  },
  map: { name: 'name', partner: 'partner_id.1', amount_residual: 'amount_residual' },
  rowKey: 'id',
};

/** The legacy composer text: the router/planner fake derives the plan from it. */
const COMPOSER = JSON.stringify({
  tree: {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      {
        type: 'table',
        id: 'invoices',
        loading: 'skeleton',
        columns: [
          { fieldKey: 'name', label: 'Rechnung' },
          { fieldKey: 'partner', label: 'Kunde' },
          { fieldKey: 'amount_residual', label: 'Offen' },
        ],
        rows: [],
      },
    ],
  },
  dataRequirements: [
    {
      containerId: 'invoices',
      description: 'Offene Rechnungen',
      fields: [
        { fieldKey: 'name', label: 'Rechnung' },
        { fieldKey: 'partner', label: 'Kunde' },
        { fieldKey: 'amount_residual', label: 'Offen' },
      ],
      fetch: INVOICE_FETCH,
    },
  ],
  summary: '{count} offene Rechnungen.',
});

const isComposer = (system: string): boolean => /Tier-2 composer/.test(system);

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

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  systems: string[];
  baseInputs: ChatTurnInput[];
}

async function harness(opts: {
  decide?: DecisionModelService;
  baseEvents?: ChatStreamEvent[];
  records?: unknown[];
  config?: Record<string, string>;
}): Promise<Harness> {
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const systems: string[] = [];
  const baseInputs: ChatTurnInput[] = [];
  const inner: CompositionLlm = {
    complete: (req) => {
      systems.push(req.system ?? '');
      return Promise.resolve({ text: COMPOSER });
    },
  };
  const ctx = {
    log: (m: string) => logs.push(m),
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: withRouterPlanner(inner),
    config: { get: <T>(k: string): T | undefined => opts.config?.[k] as T | undefined },
    tools: {
      register: () => () => {},
      invoke: (name: string) =>
        name === 'odoo_query'
          ? Promise.resolve(odooOutput(opts.records ?? INVOICES))
          : Promise.reject(new Error(`tools.invoke: '${name}' is unknown or handler-less`)),
    },
  } as unknown as PluginContext;
  const baseEvents: ChatStreamEvent[] = opts.baseEvents ?? [
    { type: 'text_delta', text: 'Hallo! Wie kann ich helfen?' },
    { type: 'done', answer: 'Hallo! Wie kann ich helfen?', toolCalls: 0, iterations: 1 },
  ];
  reg.set(CHAT_AGENT_SERVICE, {
    agent: {
      offeredToolNames: () => new Set(['odoo_query']),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        await Promise.resolve();
        yield* baseEvents;
      },
    },
  } satisfies ChatAgentBundle);
  reg.set(
    FAST_PATH_SERVICE,
    createFastPathService({
      config: ctx.config,
      model: 'class:fast',
      privacyGuard: () => undefined,
      privacyForced: () => false,
      log: (m) => logs.push(m),
      ...(opts.decide ? { decisionModel: () => opts.decide } : {}),
    }),
  );
  await activate(ctx);
  const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  return { agent, logs, systems, baseInputs };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const turn = (userMessage: string): ChatTurnInput =>
  ({ userMessage, canvasSessionId: `cs-${Math.random().toString(36).slice(2)}` }) as ChatTurnInput;

const decisionOf = (events: readonly ChatStreamEvent[]): FastPathDecision | undefined => {
  const done = events.find((e) => e.type === 'done');
  return done?.type === 'done' ? done.fastPathDecision : undefined;
};

const snapshots = (events: readonly ChatStreamEvent[]): unknown[] =>
  events.flatMap((e) => (e.type === 'surface_snapshot' ? [e.tree] : []));

const nodeTypes = (tree: unknown): string[] =>
  ((tree as { children?: Array<{ type: string }> }).children ?? []).map((c) => c.type);

// ── the gate picks the view ─────────────────────────────────────────────────

describe('canvas — the decision gate picks the view', () => {
  it('gate data: the plan skeleton goes out without a composer call, the fast path fills it', async () => {
    const d = fakeDecide(DATA);
    const h = await harness({ decide: d.decide });
    const events = await collect(h.agent.chatStream(turn('Welche Rechnungen sind offen?')));
    assert.equal(h.systems.filter(isComposer).length, 0, 'no composer call');
    assert.equal(h.baseInputs.length, 0, 'answered without the agent');
    const [first] = snapshots(events);
    assert.deepEqual(nodeTypes(first), ['heading', 'table']);
    assert.ok(events.some((e) => e.type === 'surface_patch'), 'rows patched in');
    const decision = decisionOf(events);
    assert.equal(decision?.verdict, 'data');
    assert.equal(decision?.answered, true);
    assert.equal(decision?.tool, 'odoo_query');
    assert.deepEqual(decision?.ui, { skeleton: 'plan' });
    assert.deepEqual(
      decision?.steps?.map((s) => [s.task, s.choice]),
      [
        [GATE_TASK, 'data'],
        [SOURCE_TASK, 'tool:odoo_query'],
      ],
    );
    assert.ok(h.logs.some((l) => /skipped — decision gate data → plan skeleton/.test(l)));
  });

  it('gate simple: a plain answer view, no composer, the agent answer fills it', async () => {
    const d = fakeDecide({ [GATE_TASK]: { choice: 'model_simple', confidence: 0.9 } });
    const h = await harness({ decide: d.decide });
    const events = await collect(h.agent.chatStream(turn('Hallo!')));
    assert.equal(h.systems.filter(isComposer).length, 0, 'no composer call');
    assert.equal(h.baseInputs.length, 1);
    assert.equal(h.baseInputs[0]?.routeHint, 'simple', 'the gate’s route reaches the agent');
    const trees = snapshots(events);
    assert.equal(trees.length, 2, 'loading view + filled view');
    const filled = JSON.stringify(trees[1]);
    assert.match(filled, /Hallo! Wie kann ich helfen\?/);
    assert.doesNotMatch(filled, /"loading":"skeleton"/);
    const doneAt = events.findIndex((e) => e.type === 'done');
    const filledAt = events.findIndex((e, i) => i > 0 && e.type === 'surface_snapshot');
    assert.ok(filledAt < doneAt, 'the answer view goes out before done');
    const decision = decisionOf(events);
    assert.equal(decision?.verdict, 'model');
    assert.equal(decision?.route, 'simple');
    assert.equal(decision?.answered, undefined);
    assert.deepEqual(decision?.ui, { skeleton: 'simple' });
  });

  it('a simple turn whose agent publishes onto the canvas keeps that view', async () => {
    const d = fakeDecide({ [GATE_TASK]: { choice: 'model_simple', confidence: 0.9 } });
    const published: ChatStreamEvent = {
      type: 'surface_snapshot',
      canvasSessionId: 'x',
      surfaceSeq: 1,
      producesRevision: '1',
      tree: { type: 'container', id: 'root', layout: 'stack', children: [] },
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
    } as ChatStreamEvent;
    const h = await harness({
      decide: d.decide,
      baseEvents: [published, { type: 'done', answer: 'ok', toolCalls: 1, iterations: 1 }],
    });
    const events = await collect(h.agent.chatStream(turn('Hallo!')));
    assert.equal(snapshots(events).length, 2, 'skeleton + the agent’s own view, no answer view');
  });

  it('gate complex: the composer designs the view, the decision still reaches done', async () => {
    const d = fakeDecide({ [GATE_TASK]: { choice: 'model_complex', confidence: 0.9 } });
    const h = await harness({ decide: d.decide });
    const events = await collect(h.agent.chatStream(turn('Analysiere die Umsatzentwicklung je Kunde')));
    assert.equal(h.systems.filter(isComposer).length, 1);
    const decision = decisionOf(events);
    assert.equal(decision?.verdict, 'model');
    assert.equal(decision?.route, 'complex');
    assert.deepEqual(decision?.ui, { skeleton: 'composer' });
  });

  it('an unsure gate composes as before; done marks the decision as a fallback', async () => {
    const d = fakeDecide({ [GATE_TASK]: { choice: 'model_complex', confidence: 0.4 } });
    const h = await harness({ decide: d.decide });
    const events = await collect(h.agent.chatStream(turn('Welche Rechnungen sind offen?')));
    assert.equal(h.systems.filter(isComposer).length, 1, 'composer called');
    const decision = decisionOf(events);
    assert.equal(decision?.fallback, true);
    assert.equal(decision?.steps?.[0]?.confidence, 0.4);
    assert.deepEqual(decision?.ui, { skeleton: 'composer' });
  });

  it('fast_path_decision_canvas=false: the composer as before, the decision still on done', async () => {
    const d = fakeDecide({ ...DATA, [LAYOUT_TASK]: { choice: 'chart_bar', confidence: 0.9 } });
    const h = await harness({ decide: d.decide, config: { fast_path_decision_canvas: 'false' } });
    const events = await collect(h.agent.chatStream(turn('Welche Rechnungen sind offen?')));
    assert.equal(h.systems.filter(isComposer).length, 1, 'composer called');
    assert.equal(d.reqs.some((r) => r.task === LAYOUT_TASK), false, 'no layout decision');
    assert.deepEqual(decisionOf(events)?.ui, { skeleton: 'composer' });
    assert.equal(decisionOf(events)?.answered, true);
  });

  it('without a decision model nothing changes: composer, no decision on done', async () => {
    const h = await harness({});
    const events = await collect(h.agent.chatStream(turn('Welche Rechnungen sind offen?')));
    assert.equal(h.systems.filter(isComposer).length, 1);
    assert.equal(decisionOf(events), undefined);
  });
});

// ── canvas.layout ───────────────────────────────────────────────────────────

describe('canvas — the decision model picks the layout of planned rows', () => {
  it('chart_bar: the rows go out as a bar chart of label/value points, the recipe replays them', async () => {
    const d = fakeDecide({ ...DATA, [LAYOUT_TASK]: { choice: 'chart_bar', confidence: 0.9 } });
    const h = await harness({ decide: d.decide });
    const events = await collect(h.agent.chatStream(turn('Vergleiche die offenen Beträge je Kunde')));
    const layoutReq = d.reqs.find((r) => r.task === LAYOUT_TASK);
    assert.ok(layoutReq, 'layout asked');
    assert.match(layoutReq.input, /USER TURN: Vergleiche/);
    const trees = snapshots(events);
    assert.deepEqual(nodeTypes(trees[0]), ['heading', 'table'], 'table skeleton first');
    assert.deepEqual(nodeTypes(trees[1]), ['heading', 'chart'], 'then the chart view');
    const points = events
      .filter((e) => e.type === 'surface_patch')
      .flatMap((e) => (e as unknown as { patches: Array<{ path: string; value: unknown }> }).patches)
      .filter((p) => /\/points/.test(p.path))
      .flatMap((p) => (Array.isArray(p.value) ? p.value : [p.value])) as Array<{ label: string; value: number }>;
    assert.deepEqual(
      points.map((p) => [p.label, p.value]),
      [
        ['R/2026/011', 1200.5],
        ['R/2026/012', 800],
        ['R/2026/013', 450.25],
      ],
    );
    const decision = decisionOf(events);
    assert.deepEqual(decision?.ui, { skeleton: 'plan', layout: 'bar' });
    assert.deepEqual(decision?.steps?.map((s) => s.task), [GATE_TASK, SOURCE_TASK, LAYOUT_TASK]);
    assert.ok(h.logs.some((l) => /recipe captured: results via odoo_query/.test(l)));
  });

  it('a chart the rows cannot be stays the table', async () => {
    const d = fakeDecide({ ...DATA, [LAYOUT_TASK]: { choice: 'chart_line', confidence: 0.9 } });
    const h = await harness({ decide: d.decide, records: [INVOICES[0]] });
    const events = await collect(h.agent.chatStream(turn('Verlauf der offenen Beträge')));
    assert.equal(snapshots(events).length, 1, 'only the table skeleton');
    assert.ok(events.some((e) => e.type === 'surface_patch'));
    assert.deepEqual(decisionOf(events)?.ui, { skeleton: 'plan' });
    assert.ok(h.logs.some((l) => /decision layout line not applicable/.test(l)));
  });

  it('a table pick or an unsure layout keeps the table', async () => {
    const d = fakeDecide({ ...DATA, [LAYOUT_TASK]: { choice: 'chart_pie', confidence: 0.5 } });
    const h = await harness({ decide: d.decide });
    const events = await collect(h.agent.chatStream(turn('Welche Rechnungen sind offen?')));
    assert.equal(snapshots(events).length, 1);
    assert.deepEqual(decisionOf(events)?.ui, { skeleton: 'plan' });
  });
});

describe('decisionCanvas — building blocks', () => {
  it('chartColumns: a text label and a numeric value (amount-like first), ids skipped', () => {
    const rows = [
      { id: 1, name: 'A', qty: 2, amount_total: 10 },
      { id: 2, name: 'B', qty: 3, amount_total: 20 },
    ];
    assert.deepEqual(chartColumns(rows, ['id', 'name', 'qty', 'amount_total'], 'bar'), {
      labelKey: 'name',
      valueKey: 'amount_total',
    });
    assert.equal(chartColumns([rows[0]!], ['name', 'amount_total'], 'bar'), undefined, 'one row');
    assert.equal(chartColumns(rows, ['id', 'name'], 'bar'), undefined, 'no value');
    assert.equal(
      chartColumns([{ name: 'A', v: -1 }, { name: 'B', v: 2 }], ['name', 'v'], 'pie'),
      undefined,
      'negative share',
    );
  });

  it('peekGate: the verdict within the window, else undefined', async () => {
    assert.deepEqual(await peekGate(Promise.resolve<GateSignal>({ verdict: 'data' }), 50), { verdict: 'data' });
    assert.equal(await peekGate(new Promise<GateSignal>(() => {}), 10), undefined);
    assert.equal(await peekGate(undefined), undefined);
  });

  it('canvasDecision: nothing without a step; the wire copy keeps known fields only', () => {
    assert.equal(
      canvasDecision({ provider: 'jev', trace: undefined, steps: [], ui: { skeleton: 'composer' }, answered: false }),
      undefined,
    );
    const d = canvasDecision({
      provider: 'jev',
      trace: undefined,
      steps: [{ task: GATE_TASK, choice: 'data', confidence: 0.5, ms: 12 }],
      ui: { skeleton: 'composer' },
      answered: false,
    });
    assert.deepEqual(d, {
      provider: 'jev',
      verdict: 'data',
      confidence: 0.5,
      ms: 12,
      fallback: true,
      steps: [{ task: GATE_TASK, choice: 'data', confidence: 0.5, ms: 12 }],
      ui: { skeleton: 'composer' },
    });
    const wire = toTurnDecision({ ...d!, extra: 'x' } as unknown as FastPathDecision);
    assert.equal('extra' in wire, false);
    assert.deepEqual(wire.ui, { skeleton: 'composer' });
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
