/**
 * Fast path on a typed decision model (`decisionModel@1`, @omadia/fast-path
 * decisionRouter.ts + triageTurn.ts): the model yes/no gate BEFORE any
 * triage model call, the source choice over every offered tool, learned
 * plans run without the planner, and the LLM fallback on any failure. Plus
 * the MCP side: read-only declared tools become plannable, with their own
 * executor.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  normalizeDecisionChoice,
  type DecisionChoiceRequest,
  type DecisionChoiceResult,
  type DecisionModelService,
} from '@omadia/plugin-api';

import type { ChatAgent, ChatStreamEvent } from '@omadia/channel-sdk';

import { wrapChatAgentWithFastPath } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import {
  DIRECT_PLAN_TASK,
  GATE_TASK,
  isDirectPlan,
  routeByDecision,
  SOURCE_TASK,
} from '../packages/harness-plugin-fast-path/src/decisionRouter.js';
import type { FastLlm } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { genericToolSpecs, isPlannableReadTool } from '../packages/harness-plugin-fast-path/src/genericToolSpecs.js';
import { createLearnedPlanStore, type LearnedPlan } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { PLAN_EXAMPLE, PLANNER_TOOL } from '../packages/harness-plugin-fast-path/src/planner.js';
import { ROUTER_TOOL } from '../packages/harness-plugin-fast-path/src/router.js';
import { createFastPathService, type ChatTriageOutcome } from '../packages/harness-plugin-fast-path/src/service.js';
import type { StoredTextPrivacyRun } from '../packages/harness-plugin-fast-path/src/storedTextPrivacy.js';
import { triageTurn } from '../packages/harness-plugin-fast-path/src/triageTurn.js';

type Req = Parameters<FastLlm['complete']>[0];
type Res = Awaited<ReturnType<FastLlm['complete']>>;

const TOOLS = [
  { name: 'odoo_query', spec: 'odoo_query — Odoo search_read.' },
  { name: 'mcp__github__issues', spec: 'mcp__github__issues [generic] — GitHub issues.', purpose: 'GitHub issues', generic: true as const },
];
const ALLOWED = new Set(TOOLS.map((t) => t.name));

function fakeLlm(): { llm: FastLlm; reqs: Req[] } {
  const reqs: Req[] = [];
  return {
    reqs,
    llm: {
      complete: (req) => {
        reqs.push(req);
        const name = req.toolChoice?.name;
        const input =
          name === PLANNER_TOOL
            ? PLAN_EXAMPLE
            : { decision: 'deterministic', tool: 'odoo_query', confidence: 0.9 };
        return Promise.resolve({ text: '', toolCalls: [{ name: name ?? ROUTER_TOOL, input }] } as Res);
      },
    },
  };
}

/** A decision model answering per task; a thrown answer is a provider error. */
function fakeDecide(
  answers: Partial<Record<string, Partial<DecisionChoiceResult> | Error>>,
): { decide: DecisionModelService; reqs: DecisionChoiceRequest[] } {
  const reqs: DecisionChoiceRequest[] = [];
  return {
    reqs,
    decide: {
      provider: 'fake',
      choose: (req) => {
        reqs.push(req);
        const a = answers[req.task];
        if (a instanceof Error) return Promise.reject(a);
        if (a === undefined) return Promise.reject(new Error(`no answer for ${req.task}`));
        return Promise.resolve({ choice: '', confidence: 0, ...a } as DecisionChoiceResult);
      },
    },
  };
}

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

function triage(opts: {
  llm: FastLlm;
  decide?: DecisionModelService;
  question?: string;
  offered?: LearnedPlan[];
  privacy?: StoredTextPrivacyRun;
  directPlans?: boolean;
  logs?: string[];
}): ReturnType<typeof triageTurn> {
  return triageTurn({
    llm: opts.llm,
    model: 'class:fast',
    channel: 'web',
    question: opts.question ?? 'Welche Posten sind noch offen?',
    tools: TOOLS,
    offered: opts.offered ?? [],
    allowedTools: ALLOWED,
    ...(opts.decide ? { decide: opts.decide, directPlans: opts.directPlans ?? true } : {}),
    ...(opts.privacy ? { privacy: opts.privacy } : {}),
    log: (m) => opts.logs?.push(m),
  });
}

describe('decisionModel@1 — normalizeDecisionChoice', () => {
  const req = { options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }] };
  it('accepts a known choice, clamps confidence and probabilities', () => {
    assert.deepEqual(normalizeDecisionChoice(req, { choice: 'a', confidence: 1.4, probabilities: { a: 0.9, x: 0.1 }, model: 'jev-1.13.0' }), {
      choice: 'a',
      confidence: 1,
      probabilities: { a: 0.9 },
      model: 'jev-1.13.0',
    });
  });
  it('refuses an unknown choice or a non-finite confidence', () => {
    assert.equal(normalizeDecisionChoice(req, { choice: 'c', confidence: 0.9 }), undefined);
    assert.equal(normalizeDecisionChoice(req, { choice: 'a', confidence: Number.NaN }), undefined);
    assert.equal(normalizeDecisionChoice(req, { choice: 'a' }), undefined);
  });
});

describe('decision gate — model yes/no before any triage model call', () => {
  it('"model" → the agent with its route hint, ZERO LLM calls, no source decision', async () => {
    for (const [choice, route] of [['model_complex', 'complex'], ['model_simple', 'simple']] as const) {
      const f = fakeLlm();
      const d = fakeDecide({ [GATE_TASK]: { choice, confidence: 0.9 } });
      const out = await triage({ llm: f.llm, decide: d.decide });
      assert.equal(out.kind, 'agent');
      assert.equal(out.kind === 'agent' && out.route, route);
      assert.equal(f.reqs.length, 0, 'no router, no speculative planner');
      assert.deepEqual(d.reqs.map((r) => r.task), [GATE_TASK]);
    }
  });

  it('an unsure gate or source decides nothing → the LLM router ∥ planner', async () => {
    const cases = [
      { [GATE_TASK]: { choice: 'model_complex', confidence: 0.4 } },
      { [GATE_TASK]: { choice: 'data', confidence: 0.9 }, [SOURCE_TASK]: { choice: 'tool:odoo_query', confidence: 0.3 } },
    ];
    for (const answers of cases) {
      const f = fakeLlm();
      const out = await triage({ llm: f.llm, decide: fakeDecide(answers).decide });
      assert.equal(out.kind, 'plan');
      assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name).sort(), [PLANNER_TOOL, ROUTER_TOOL].sort());
    }
  });

  it('a provider that never answers is cut at the deadline → the LLM router', async () => {
    const f = fakeLlm();
    const logs: string[] = [];
    const hang: DecisionModelService = { provider: 'hang', choose: () => new Promise(() => {}) };
    const out = await triage({ llm: f.llm, decide: hang, logs });
    assert.equal(out.kind, 'plan');
    assert.ok(logs.some((m) => /decision fast-path\.gate provider=hang failed: timeout/.test(m)));
  });

  it('"data" → the source decision over EVERY offered tool (plugin and MCP), then ONE planner call', async () => {
    const f = fakeLlm();
    const d = fakeDecide({
      [GATE_TASK]: { choice: 'data', confidence: 0.95 },
      [SOURCE_TASK]: { choice: 'tool:odoo_query', confidence: 0.9 },
    });
    const out = await triage({ llm: f.llm, decide: d.decide });
    assert.equal(out.kind, 'plan');
    assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name), [PLANNER_TOOL], 'no router call');
    assert.deepEqual(f.reqs[0]?.tools?.[0]?.inputSchema && (f.reqs[0].tools[0].inputSchema as { properties: { tool: { enum: string[] } } }).properties.tool.enum, ['odoo_query'], 'planner sees only the chosen source');
    const sources = d.reqs.find((r) => r.task === SOURCE_TASK)?.options.map((o) => o.id);
    assert.deepEqual(sources, ['tool:odoo_query', 'tool:mcp__github__issues', 'none']);
  });

  it('"data" without a fitting source → the agent, no LLM call', async () => {
    const f = fakeLlm();
    const out = await triage({
      llm: f.llm,
      decide: fakeDecide({ [GATE_TASK]: { choice: 'data', confidence: 0.9 }, [SOURCE_TASK]: { choice: 'none', confidence: 0.9 } }).decide,
    });
    assert.deepEqual([out.kind, out.kind === 'agent' && out.reason], ['agent', 'decision-no-source']);
    assert.equal(f.reqs.length, 0);
  });

  it('a provider error or malformed answer → the LLM router ∥ planner, unchanged', async () => {
    for (const gate of [new Error('timeout'), { choice: 'maybe', confidence: 0.9 }]) {
      const f = fakeLlm();
      const logs: string[] = [];
      const out = await triage({ llm: f.llm, decide: fakeDecide({ [GATE_TASK]: gate }).decide, logs });
      assert.equal(out.kind, 'plan');
      assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name).sort(), [PLANNER_TOOL, ROUTER_TOOL].sort());
      assert.ok(logs.some((m) => m.includes('decision fast-path.gate provider=fake')));
    }
  });

  it('routes the MASKED message, never the raw question', async () => {
    const privacy: StoredTextPrivacyRun = {
      mask: (text) => Promise.resolve({ send: true, text: text.replace('Müller', '«PERSON_1»') }),
      restore: (text) => text.replace('«PERSON_1»', 'Müller'),
    } as StoredTextPrivacyRun;
    const d = fakeDecide({ [GATE_TASK]: { choice: 'model_complex', confidence: 0.9 } });
    await triage({ llm: fakeLlm().llm, decide: d.decide, privacy, question: 'Posten von Müller' });
    assert.match(d.reqs[0]?.input ?? '', /«PERSON_1»/);
    assert.doesNotMatch(d.reqs[0]?.input ?? '', /Müller/);
  });
});

describe('direct plans — a learned query without the planner', () => {
  /** a running shield that finds nothing to mask */
  const shield = { mask: (text: string) => Promise.resolve({ send: true, text }), restore: (text: string) => text } as unknown as StoredTextPrivacyRun;
  const data = { [GATE_TASK]: { choice: 'data', confidence: 0.95 }, [SOURCE_TASK]: { choice: 'tool:odoo_query', confidence: 0.95 } };

  it('a confident pick of a placeholder-free plan → the plan with ZERO LLM calls', async () => {
    const f = fakeLlm();
    const d = fakeDecide({ ...data, [DIRECT_PLAN_TASK]: { choice: 'plan:p1', confidence: 0.92 } });
    const out = await triage({ llm: f.llm, decide: d.decide, offered: [learned()], privacy: shield });
    assert.equal(out.kind, 'plan');
    assert.equal(out.kind === 'plan' && out.plan.fetch.tool, 'odoo_query');
    assert.deepEqual(out.kind === 'plan' && out.plan.fetch.input, PLAN_EXAMPLE.input);
    assert.equal(f.reqs.length, 0);
  });

  it('plan_new, a weak pick, a number in the question, a masked span or NO shield → the planner', async () => {
    const cases: Array<{ pick: Partial<DecisionChoiceResult>; question?: string; masked?: boolean; noShield?: boolean }> = [
      { pick: { choice: 'plan_new', confidence: 0.99 } },
      { pick: { choice: 'plan:p1', confidence: 0.7 } },
      { pick: { choice: 'plan:p1', confidence: 0.99 }, question: 'Die 5 offenen Posten' },
      { pick: { choice: 'plan:p1', confidence: 0.99 }, masked: true },
      { pick: { choice: 'plan:p1', confidence: 0.99 }, noShield: true },
    ];
    for (const c of cases) {
      const f = fakeLlm();
      const privacy = c.noShield
        ? undefined
        : c.masked
          ? ({ mask: (t: string) => Promise.resolve({ send: true, text: `${t} «X»` }), restore: (t: string) => t } as unknown as StoredTextPrivacyRun)
          : shield;
      const out = await triage({
        llm: f.llm,
        decide: fakeDecide({ ...data, [DIRECT_PLAN_TASK]: c.pick }).decide,
        offered: [learned()],
        ...(c.question ? { question: c.question } : {}),
        ...(privacy ? { privacy } : {}),
      });
      assert.equal(out.kind, 'plan');
      assert.deepEqual(f.reqs.map((r) => r.toolChoice?.name), [PLANNER_TOOL], JSON.stringify(c));
    }
  });

  it('switched off → never asks for a direct plan', async () => {
    const d = fakeDecide({ ...data, [DIRECT_PLAN_TASK]: { choice: 'plan:p1', confidence: 0.99 } });
    await triage({ llm: fakeLlm().llm, decide: d.decide, offered: [learned()], directPlans: false, privacy: shield });
    assert.ok(!d.reqs.some((r) => r.task === DIRECT_PLAN_TASK));
  });

  it('isDirectPlan: active, no placeholder, no top-N, with an example', () => {
    assert.equal(isDirectPlan(learned()), true);
    assert.equal(isDirectPlan(learned({ active: false })), false);
    assert.equal(isDirectPlan(learned({ take: 5 })), false);
    assert.equal(isDirectPlan(learned({ examples: [] })), false);
    assert.equal(
      isDirectPlan(learned({ inputTemplate: { ...PLAN_EXAMPLE.input, domain: [['partner_id.name', 'ilike', '{{text_1}}']] } })),
      false,
    );
  });
});

describe('routeByDecision — confidence of a data route', () => {
  it('is the product of gate and source confidence', async () => {
    const out = await routeByDecision({
      decide: fakeDecide({ [GATE_TASK]: { choice: 'data', confidence: 0.9 }, [SOURCE_TASK]: { choice: 'tool:odoo_query', confidence: 0.8 } }).decide,
      channel: 'web',
      message: 'USER TURN: x',
      tools: TOOLS,
      log: () => {},
    });
    assert.equal(out?.kind, 'plan');
    assert.ok(out?.kind === 'plan' && Math.abs(out.confidence - 0.72) < 1e-9);
  });
});

describe('MCP read tools — plannable by their read-only hint', () => {
  it('the hint alone never suffices: the own name must read, no write verb anywhere (camelCase-aware)', () => {
    assert.equal(isPlannableReadTool({ name: 'mcp__github__list_issues', readOnly: true }), true);
    assert.equal(isPlannableReadTool({ name: 'mcp__crm__getAccounts', readOnly: true }), true);
    assert.equal(isPlannableReadTool({ name: 'mcp__crm__accountsSearch', readOnly: true }), true);
    assert.equal(isPlannableReadTool({ name: 'mcp__github__issues', readOnly: true }), false, 'no read verb');
    assert.equal(isPlannableReadTool({ name: 'mcp__github__list_issues' }), false, 'no hint, no mcp read');
    assert.equal(isPlannableReadTool({ name: 'mcp__github__create_issue', readOnly: true }), false);
    assert.equal(isPlannableReadTool({ name: 'mcp__crm__createInvoice', readOnly: true }), false, 'camelCase write verb');
    assert.equal(isPlannableReadTool({ name: 'mcp__crm__getAndDeleteInvoice', readOnly: true }), false);
    assert.equal(isPlannableReadTool({ name: 'list_partners' }), true);
  });

  it('genericToolSpecs builds a spec for a read-only MCP definition', () => {
    const specs = genericToolSpecs([
      { name: 'mcp__github__list_issues', description: 'List GitHub issues.', input_schema: { type: 'object', properties: {} }, readOnly: true },
      { name: 'mcp__github__delete_issue', description: 'Delete.', readOnly: true },
    ]);
    assert.deepEqual(specs.map((s) => s.name), ['mcp__github__list_issues']);
  });
});

describe('chat triage service — decision model + MCP executor', () => {
  const MCP_TOOL = 'mcp__crm__list_accounts';
  const MCP_PLAN = {
    tool: MCP_TOOL,
    input: { city: 'Berlin' },
    map: { name: 'name', city: 'city' },
    itemsPath: 'value',
    labels: { name: 'Firma', city: 'Ort' },
    summary: '{count} Firmen.',
    locale: 'de-DE',
  };
  const OUTPUT = JSON.stringify({ value: [{ name: 'Acme GmbH', city: 'Berlin' }] });

  function service(decide: DecisionModelService | undefined, config: Record<string, unknown> = {}) {
    const llmCalls: string[] = [];
    const kernelInvokes: string[] = [];
    const ownInvokes: unknown[] = [];
    const svc = createFastPathService({
      config: { get: <T>(k: string): T | undefined => config[k] as T | undefined },
      llm: {
        complete: (req) => {
          llmCalls.push(req.toolChoice?.name ?? 'text');
          const input =
            req.toolChoice?.name === PLANNER_TOOL ? MCP_PLAN : { decision: 'deterministic', tool: MCP_TOOL, confidence: 0.9 };
          return Promise.resolve({ text: '', toolCalls: [{ name: req.toolChoice?.name ?? '', input }] });
        },
      },
      model: 'class:fast',
      invoke: (name) => {
        kernelInvokes.push(name);
        return Promise.reject(new Error(`unknown or handler-less tool ${name}`));
      },
      privacyGuard: () => undefined,
      privacyForced: () => false,
      ...(decide ? { decisionModel: () => decide } : {}),
      log: () => {},
      plans: createLearnedPlanStore({ log: () => {} }),
    });
    const triage = () =>
      svc.triageChatTurn({
        channel: 'web',
        userMessage: 'Welche Firmen sitzen in Berlin?',
        permittedTools: new Set([MCP_TOOL]),
        toolDefinitions: [
          {
            name: MCP_TOOL,
            description: 'CRM accounts by city.',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
            readOnly: true,
            invoke: (input) => {
              ownInvokes.push(input);
              return Promise.resolve(OUTPUT);
            },
          },
        ],
      });
    return { svc, triage, llmCalls, kernelInvokes, ownInvokes };
  }

  it('an MCP read tool is planned and runs through its OWN executor, not ctx.tools.invoke', async () => {
    const h = service(undefined);
    const out = await h.triage();
    assert.equal(out.kind, 'answer');
    assert.equal(out.kind === 'answer' && out.tool, MCP_TOOL);
    assert.deepEqual(h.ownInvokes, [{ city: 'Berlin' }]);
    assert.deepEqual(h.kernelInvokes, []);
  });

  it('with a decision model: gate + source decide, the router LLM call is gone', async () => {
    const d = fakeDecide({
      [GATE_TASK]: { choice: 'data', confidence: 0.95 },
      [SOURCE_TASK]: { choice: `tool:${MCP_TOOL}`, confidence: 0.9 },
    });
    const h = service(d.decide);
    assert.equal(h.svc.decisionModel()?.provider, 'fake');
    const out = await h.triage();
    assert.equal(out.kind, 'answer');
    assert.deepEqual(h.llmCalls, [PLANNER_TOOL]);
  });

  it('fast_path_decision_model=false ignores an installed decision model', async () => {
    const d = fakeDecide({ [GATE_TASK]: { choice: 'model_complex', confidence: 0.99 } });
    const h = service(d.decide, { fast_path_decision_model: false });
    assert.equal(h.svc.decisionModel(), undefined);
    await h.triage();
    assert.equal(d.reqs.length, 0);
    assert.ok(h.llmCalls.includes(ROUTER_TOOL));
  });
});

describe('decision trace → web chat (`done.fastPathDecision`)', () => {
  const answered = { [GATE_TASK]: { choice: 'data', confidence: 0.95, model: 'jev-1.13.0' }, [SOURCE_TASK]: { choice: 'tool:odoo_query', confidence: 0.9 } };

  it('the triage carries the decision: model verdict with route, data verdict with source, direct flag', async () => {
    const model = await triage({ llm: fakeLlm().llm, decide: fakeDecide({ [GATE_TASK]: { choice: 'model_complex', confidence: 0.8 } }).decide });
    assert.deepEqual(
      model.decision && { ...model.decision, ms: 0 },
      { provider: 'fake', verdict: 'model', route: 'complex', confidence: 0.8, ms: 0 },
    );
    const planned = await triage({ llm: fakeLlm().llm, decide: fakeDecide(answered).decide });
    assert.equal(planned.decision?.verdict, 'data');
    assert.equal(planned.decision?.tool, 'odoo_query');
    assert.equal(planned.decision?.model, 'jev-1.13.0');
    assert.equal(planned.decision?.direct, undefined);
    const shield = { mask: (t: string) => Promise.resolve({ send: true, text: t }), restore: (t: string) => t } as unknown as StoredTextPrivacyRun;
    const direct = await triage({
      llm: fakeLlm().llm,
      decide: fakeDecide({ ...answered, [DIRECT_PLAN_TASK]: { choice: 'plan:p1', confidence: 0.95 } }).decide,
      offered: [learned()],
      privacy: shield,
    });
    assert.equal(direct.decision?.direct, true);
  });

  it('the LLM router path carries no decision', async () => {
    const out = await triage({ llm: fakeLlm().llm });
    assert.equal(out.decision, undefined);
  });

  async function collectEvents(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
    const out: ChatStreamEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }
  const TRACE = { provider: 'jev', model: 'jev-1.13.0', verdict: 'data' as const, tool: 'odoo_query', confidence: 0.9, ms: 12, direct: true as const };
  const innerAgent = (): ChatAgent =>
    ({
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream() {
        yield { type: 'text_delta', text: 'agent answer' } as ChatStreamEvent;
        yield { type: 'done', answer: 'agent answer', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
      },
    }) as unknown as ChatAgent;
  const wrap = (outcome: ChatTriageOutcome): ChatAgent =>
    wrapChatAgentWithFastPath(innerAgent(), {
      fastPath: () => ({ channelEnabled: () => true, triageChatTurn: () => Promise.resolve(outcome) }),
      privacyGuarded: () => false,
      permittedTools: () => new Set(['odoo_query']),
      log: () => {},
    });

  it('a fast-path answer: `done` says Jev answered it without the agent', async () => {
    const events = await collectEvents(
      wrap({ kind: 'answer', text: 'rows', tool: 'odoo_query', rows: 2, toolCalls: 1, ms: 30, decision: TRACE }).chatStream({ userMessage: 'Offene Posten?', sessionScope: 'tab_1' }),
    );
    const done = events.find((e) => e.type === 'done');
    assert.deepEqual(done && done.type === 'done' ? done.fastPathDecision : undefined, { ...TRACE, answered: true });
  });

  it('an agent turn Jev routed: the agent\'s own `done` is stamped, other events untouched', async () => {
    const events = await collectEvents(
      wrap({
        kind: 'agent',
        route: 'complex',
        reason: 'agent:complex',
        ms: 9,
        decision: { provider: 'jev', verdict: 'model', route: 'complex', confidence: 0.82, ms: 9 },
      }).chatStream({ userMessage: 'Warum?', sessionScope: 'tab_1' }),
    );
    assert.deepEqual(events[0], { type: 'text_delta', text: 'agent answer' });
    const done = events[1];
    assert.equal(done?.type, 'done');
    assert.deepEqual(done?.type === 'done' ? done.fastPathDecision : undefined, {
      provider: 'jev',
      verdict: 'model',
      route: 'complex',
      confidence: 0.82,
      ms: 9,
    });
  });

  it('no decision → `done` unchanged', async () => {
    const events = await collectEvents(wrap({ kind: 'agent', reason: 'agent:simple', route: 'simple', ms: 1 }).chatStream({ userMessage: 'Hallo', sessionScope: 'tab_1' }));
    const done = events.find((e) => e.type === 'done');
    assert.equal(done && 'fastPathDecision' in done, false);
  });
});
