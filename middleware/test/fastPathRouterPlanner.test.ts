/**
 * Fast-path router + planner (@omadia/fast-path router.ts / planner.ts):
 * forced tool calls (no prose path), decision parsing, the confidence gate,
 * and the planner's whitelist / canvas-container rules.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { FastLlm } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import {
  PLANNER_MAX_TOKENS,
  PLANNER_TOOL,
  planQuery,
  PLAN_EXAMPLE,
} from '../packages/harness-plugin-fast-path/src/planner.js';
import {
  parseRoute,
  ROUTER_MAX_TOKENS,
  ROUTER_TOOL,
  routeTurn,
} from '../packages/harness-plugin-fast-path/src/router.js';

type Req = Parameters<FastLlm['complete']>[0];
type Res = Awaited<ReturnType<FastLlm['complete']>>;

const TOOLS = [{ name: 'odoo_query', spec: 'odoo_query — Odoo search_read. SPEC-BODY' }];
const ODOO = new Set(['odoo_query']);

function llm(answer: Res | (() => Promise<Res>)): { llm: FastLlm; reqs: Req[] } {
  const reqs: Req[] = [];
  return {
    reqs,
    llm: {
      complete: (req) => {
        reqs.push(req);
        return typeof answer === 'function' ? answer() : Promise.resolve(answer);
      },
    },
  };
}
const toolCall = (name: string, input: unknown): Res => ({ text: '', toolCalls: [{ name, input }] });

const route = (fake: FastLlm, logs: string[] = []): ReturnType<typeof routeTurn> =>
  routeTurn({ llm: fake, model: 'class:fast', channel: 'web', question: 'Geburtstage im Januar', tools: TOOLS, log: (m) => logs.push(m) });

describe('router — forced route_turn call', () => {
  it('request shape: ONE tool, forced by name, small budget, thinking off, low effort; catalog is one line per tool', async () => {
    const f = llm(toolCall(ROUTER_TOOL, { decision: 'agent_simple', confidence: 0.9 }));
    await route(f.llm);
    const req = f.reqs[0]!;
    assert.deepEqual(req.toolChoice, { name: ROUTER_TOOL });
    assert.deepEqual(req.tools?.map((t) => t.name), [ROUTER_TOOL]);
    assert.equal(req.maxTokens, ROUTER_MAX_TOKENS);
    assert.equal(req.thinking, 'off');
    assert.equal(req.effort, 'low');
    const schema = req.tools?.[0]?.inputSchema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    assert.deepEqual(schema.required, ['decision', 'confidence']);
    assert.deepEqual(schema.properties['tool']?.enum, ['odoo_query']);
    const user = req.messages[0]?.content ?? '';
    assert.match(user, /^TOOLS:\n- odoo_query: Odoo ERP read-only lookup/);
    assert.doesNotMatch(user, /SPEC-BODY/, 'the full spec is the planner\'s');
    assert.match(user, /USER TURN: Geburtstage im Januar$/);
  });

  it('decisions: agent_simple/complex carry the route hint; deterministic ≥ threshold plans; logged', async () => {
    const logs: string[] = [];
    assert.deepEqual(
      await route(llm(toolCall(ROUTER_TOOL, { decision: 'agent_simple', confidence: 0.8 })).llm, logs).then((r) => [r.kind, r.kind === 'agent' && r.route]),
      ['agent', 'simple'],
    );
    assert.deepEqual(
      await route(llm(toolCall(ROUTER_TOOL, { decision: 'agent_complex', confidence: 0.3 })).llm).then((r) => [r.kind, r.kind === 'agent' && r.route]),
      ['agent', 'complex'],
    );
    const plan = await route(llm(toolCall(ROUTER_TOOL, { decision: 'deterministic', tool: 'odoo_query', confidence: 0.85 })).llm, logs);
    assert.equal(plan.kind, 'plan');
    assert.ok(logs.some((m) => /^\[fast-path\] router channel=web decision=deterministic tool=odoo_query conf=0\.85 ms=\d+$/.test(m)));
  });

  it('low confidence, unknown tool, prose and errors → agent without a route hint', async () => {
    const cases: Array<[Res | (() => Promise<Res>), string]> = [
      [toolCall(ROUTER_TOOL, { decision: 'deterministic', tool: 'odoo_query', confidence: 0.4 }), 'router-low-confidence'],
      [toolCall(ROUTER_TOOL, { decision: 'deterministic', tool: 'odoo_execute', confidence: 0.9 }), 'router-tool-not-offered'],
      [toolCall(ROUTER_TOOL, { decision: 'maybe', confidence: 0.9 }), 'router-invalid'],
      [{ text: 'Gern! Hier sind die Geburtstage …' }, 'router-invalid'],
      [() => Promise.reject(new Error('400 bad request')), 'router-error'],
    ];
    for (const [answer, reason] of cases) {
      const r = await route(llm(answer).llm);
      assert.equal(r.kind, 'agent', reason);
      assert.equal(r.kind === 'agent' ? r.reason : '', reason);
      assert.equal(r.kind === 'agent' ? r.route : 'x', undefined, reason);
    }
  });

  it('a model that cannot force a tool may answer in text: its JSON object is accepted (via=text)', async () => {
    const logs: string[] = [];
    const r = await route(llm({ text: '{"decision":"deterministic","confidence":0.9}' }).llm, logs);
    assert.equal(r.kind === 'plan' ? r.tool : '', 'odoo_query', 'the only offered tool');
    assert.ok(logs.some((m) => m.endsWith(' via=text')));
  });

  it('parseRoute clamps confidence and never infers a tool for an agent decision', () => {
    assert.deepEqual(parseRoute({ decision: 'deterministic', confidence: 7 }, ['odoo_query']), {
      decision: 'deterministic',
      confidence: 1,
      tool: 'odoo_query',
    });
    assert.deepEqual(parseRoute({ decision: 'agent_simple', confidence: 0.5 }, ['odoo_query']), {
      decision: 'agent_simple',
      confidence: 0.5,
    });
  });

  it('privacy: the prompt is masked; a refused mask skips the call', async () => {
    const f = llm(toolCall(ROUTER_TOOL, { decision: 'agent_simple', confidence: 0.9 }));
    await routeTurn({
      llm: f.llm,
      model: 'm',
      channel: 'web',
      question: 'Geburtstag von Anna Schmidt',
      tools: TOOLS,
      privacy: { mask: async (t) => ({ send: true, text: t.replace('Anna Schmidt', 'Lukas Becker') }), restore: (t) => t },
      log: () => {},
    });
    assert.ok(!(f.reqs[0]?.messages[0]?.content ?? '').includes('Anna Schmidt'));
    const refused = llm(toolCall(ROUTER_TOOL, {}));
    const r = await routeTurn({
      llm: refused.llm,
      model: 'm',
      channel: 'web',
      question: 'x',
      tools: TOOLS,
      privacy: { mask: async () => ({ send: false, reason: 'blocked' }), restore: (t) => t },
      log: () => {},
    });
    assert.equal(r.kind === 'agent' ? r.reason : '', 'privacy-refused');
    assert.equal(refused.reqs.length, 0);
  });
});

describe('planner — forced plan_query call', () => {
  const plan = (answer: Res | (() => Promise<Res>), over: Partial<Parameters<typeof planQuery>[0]> = {}) => {
    const f = llm(answer);
    const logs: string[] = [];
    return {
      f,
      logs,
      out: planQuery({
        llm: f.llm,
        model: 'm',
        channel: 'web',
        question: 'offene Posten',
        tool: TOOLS[0]!,
        allowedTools: ODOO,
        log: (m) => logs.push(m),
        ...over,
      }),
    };
  };

  it('request shape: plan_query forced; free-form input/map; full spec in the prompt', async () => {
    const { f, out } = plan(toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE }));
    const r = await out;
    assert.ok(r.ok);
    const req = f.reqs[0]!;
    assert.deepEqual(req.toolChoice, { name: PLANNER_TOOL });
    assert.equal(req.maxTokens, PLANNER_MAX_TOKENS);
    const schema = req.tools?.[0]?.inputSchema as { properties: Record<string, Record<string, unknown>> };
    assert.equal(schema.properties['input']?.['type'], 'object');
    assert.equal(schema.properties['input']?.['additionalProperties'], undefined, 'free-form object');
    assert.match(req.messages[0]?.content ?? '', /SPEC-BODY/);
    assert.equal(r.plan.fetch.tool, 'odoo_query');
    assert.match(r.plan.summary, /\{sum:open_amount\} \{currency\}/);
  });

  it('invalid plans are reasoned misses; a throwing call is planner-error', async () => {
    const cases: Array<[Res | (() => Promise<Res>), string]> = [
      [toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, tool: 'odoo_execute' }), 'planner-invalid:tool-not-allowed'],
      [toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, map: 'nope' }), 'planner-invalid:invalid-fetch'],
      [toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, input: { model: 'res.partner', domain: [['name', '=', '{{text_1}}']] } }), 'planner-invalid:unfilled-placeholder'],
      [{ text: 'Ich würde account.move abfragen.' }, 'planner-invalid:no-plan'],
      [() => Promise.reject(new Error('timeout')), 'planner-error'],
    ];
    for (const [answer, reason] of cases) {
      const r = await plan(answer).out;
      assert.equal(r.ok ? 'ok' : r.reason, reason);
    }
  });

  it('canvas: containerId is required (enum of the skeleton containers) and the map must cover its fieldKeys', async () => {
    const containers = [
      { containerId: 'items', description: 'Offene Posten', fields: [{ fieldKey: 'number', label: 'Nr.' }, { fieldKey: 'partner', label: 'Kunde' }] },
    ];
    const ok = plan(toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, containerId: 'items' }), { channel: 'canvas', containers });
    const r = await ok.out;
    assert.ok(r.ok);
    assert.equal(r.containerId, 'items');
    const schema = ok.f.reqs[0]?.tools?.[0]?.inputSchema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    assert.ok(schema.required.includes('containerId'));
    assert.deepEqual(schema.properties['containerId']?.enum, ['items']);
    assert.match(ok.f.reqs[0]?.messages[0]?.content ?? '', /DATA CONTAINERS:\n- items \(Offene Posten\): fieldKeys number "Nr\.", partner "Kunde"/);
    const mismatch = await plan(toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, map: { other: 'name' } }), { containers }).out;
    assert.equal(mismatch.ok ? '' : mismatch.reason, 'planner-invalid:map-mismatch');
  });

  it('privacy: masked prompt in, restored values in the plan out', async () => {
    const r = await plan(
      toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, input: { model: 'res.partner', domain: [['name', 'ilike', 'Lukas Becker']] } }),
      {
        question: 'Kontakt von Anna Schmidt',
        privacy: {
          mask: async (t) => ({ send: true, text: t.replaceAll('Anna Schmidt', 'Lukas Becker') }),
          restore: (t) => t.replaceAll('Lukas Becker', 'Anna Schmidt'),
        },
      },
    ).out;
    assert.ok(r.ok);
    assert.deepEqual((r.plan.fetch.input as { domain: unknown }).domain, [['name', 'ilike', 'Anna Schmidt']]);
  });
});
