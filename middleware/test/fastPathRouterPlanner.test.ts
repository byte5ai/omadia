/**
 * Fast-path router + speculative planner (@omadia/fast-path router.ts,
 * planner.ts, triageTurn.ts): forced tool calls (no prose path), fixed text
 * in the SYSTEM prompt and only the user-derived turn message in the (masked)
 * user message, router ∥ planner with discard on an agent route.
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
import type { StoredTextPrivacyRun } from '../packages/harness-plugin-fast-path/src/storedTextPrivacy.js';
import { buildTurnMessage, triageTurn } from '../packages/harness-plugin-fast-path/src/triageTurn.js';

type Req = Parameters<FastLlm['complete']>[0];
type Res = Awaited<ReturnType<FastLlm['complete']>>;

const TOOLS = [{ name: 'odoo_query', spec: 'odoo_query — Odoo search_read. SPEC-BODY account.move amount_residual' }];
const ODOO = new Set(['odoo_query']);
const MESSAGE = 'USER TURN: Geburtstage im Januar';

function llm(answer: Res | ((req: Req) => Promise<Res>)): { llm: FastLlm; reqs: Req[] } {
  const reqs: Req[] = [];
  return {
    reqs,
    llm: {
      complete: (req) => {
        reqs.push(req);
        return typeof answer === 'function' ? answer(req) : Promise.resolve(answer);
      },
    },
  };
}
const toolCall = (name: string, input: unknown): Res => ({ text: '', toolCalls: [{ name, input }] });

const route = (fake: FastLlm, logs: string[] = []): ReturnType<typeof routeTurn> =>
  routeTurn({ llm: fake, model: 'class:fast', channel: 'web', message: MESSAGE, tools: TOOLS, log: (m) => logs.push(m) });

describe('router — forced route_turn call', () => {
  it('request shape: ONE forced tool, small budget, thinking off; catalog in the SYSTEM prompt, user = turn message', async () => {
    const f = llm(toolCall(ROUTER_TOOL, { decision: 'agent_simple', confidence: 0.9 }));
    await routeTurn({
      llm: f.llm,
      model: 'm',
      channel: 'web',
      message: MESSAGE,
      tools: TOOLS,
      intents: [{ question: 'geburtstage im {{text_1}}', tool: 'odoo_query' }],
      log: () => {},
    });
    const req = f.reqs[0]!;
    assert.deepEqual(req.toolChoice, { name: ROUTER_TOOL });
    assert.deepEqual(req.tools?.map((t) => t.name), [ROUTER_TOOL]);
    assert.equal(req.maxTokens, ROUTER_MAX_TOKENS);
    assert.equal(req.thinking, 'off');
    assert.equal(req.effort, 'low');
    const schema = req.tools?.[0]?.inputSchema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    assert.deepEqual(schema.required, ['decision', 'confidence']);
    assert.deepEqual(schema.properties['tool']?.enum, ['odoo_query']);
    assert.match(req.system ?? '', /TOOLS:\n- odoo_query: Odoo ERP read-only lookup/);
    assert.match(req.system ?? '', /LEARNED INTENTS[\s\S]*"geburtstage im \{\{text_1\}\}" → odoo_query/);
    assert.doesNotMatch(req.system ?? '', /SPEC-BODY/, "the full spec is the planner's");
    assert.equal(req.messages[0]?.content, MESSAGE, 'the user message is the turn message only');
  });

  it('decisions: agent_simple/complex carry the route hint; deterministic ≥ threshold plans; logged', async () => {
    const logs: string[] = [];
    const simple = await route(llm(toolCall(ROUTER_TOOL, { decision: 'agent_simple', confidence: 0.8 })).llm, logs);
    assert.deepEqual([simple.kind, simple.kind === 'agent' && simple.route], ['agent', 'simple']);
    const complex = await route(llm(toolCall(ROUTER_TOOL, { decision: 'agent_complex', confidence: 0.3 })).llm);
    assert.deepEqual([complex.kind, complex.kind === 'agent' && complex.route], ['agent', 'complex']);
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
});

describe('planner — forced plan_query call', () => {
  const plan = (answer: Res | (() => Promise<Res>), over: Partial<Parameters<typeof planQuery>[0]> = {}) => {
    const f = llm(answer);
    return {
      f,
      out: planQuery({
        llm: f.llm,
        model: 'm',
        channel: 'web',
        message: 'USER TURN: offene Posten',
        question: 'offene Posten',
        tools: TOOLS,
        allowedTools: ODOO,
        log: () => {},
        ...over,
      }),
    };
  };

  it('request shape: plan_query forced, free-form input; spec/catalog in the SYSTEM prompt, NOT in the user message', async () => {
    const { f, out } = plan(toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE }));
    const r = await out;
    assert.ok(r.ok);
    const req = f.reqs[0]!;
    assert.deepEqual(req.toolChoice, { name: PLANNER_TOOL });
    assert.equal(req.maxTokens, PLANNER_MAX_TOKENS);
    const schema = req.tools?.[0]?.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
    assert.equal(schema.properties['input']?.['type'], 'object');
    assert.equal(schema.properties['input']?.['additionalProperties'], undefined, 'free-form object');
    assert.deepEqual(schema.properties['tool']?.['enum'], ['odoo_query']);
    assert.equal(schema.required.includes('containerId'), false, 'the planner never sees the skeleton');
    assert.match(req.system ?? '', /SPEC-BODY/);
    assert.equal(req.messages[0]?.content, 'USER TURN: offene Posten');
    assert.doesNotMatch(req.messages[0]?.content ?? '', /SPEC-BODY|account\.move|EXAMPLE|TOOLS/);
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

  it('restore: the plan strings are restored through the per-turn run', async () => {
    const r = await plan(
      toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, input: { model: 'res.partner', domain: [['name', 'ilike', 'Lukas Becker']] } }),
      { restore: (t) => t.replaceAll('Lukas Becker', 'Anna Schmidt') },
    ).out;
    assert.ok(r.ok);
    assert.deepEqual((r.plan.fetch.input as { domain: unknown }).domain, [['name', 'ilike', 'Anna Schmidt']]);
  });
});

describe('triageTurn — router ∥ speculative planner, one mask on the user part', () => {
  /** answers route_turn / plan_query; each call can be held until released */
  function gated(routeInput: unknown, planInput: unknown = { ...PLAN_EXAMPLE }) {
    const started: string[] = [];
    const pending = new Map<string, () => void>();
    const f = llm(
      (req) =>
        new Promise<Res>((resolve) => {
          const name = req.toolChoice?.name ?? '?';
          started.push(name);
          pending.set(name, () => resolve(toolCall(name, name === ROUTER_TOOL ? routeInput : planInput)));
        }),
    );
    return { f, started, release: (name: string) => pending.get(name)?.() };
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  };
  const masking = (): { run: StoredTextPrivacyRun; masked: string[] } => {
    const masked: string[] = [];
    return {
      masked,
      run: {
        mask: async (t) => {
          masked.push(t);
          return { send: true, text: t.replaceAll('Anna Schmidt', 'Lukas Becker') };
        },
        restore: (t) => t.replaceAll('Lukas Becker', 'Anna Schmidt'),
      },
    };
  };

  it('the planner starts BEFORE the router resolves; a deterministic route uses its plan', async () => {
    const g = gated({ decision: 'deterministic', tool: 'odoo_query', confidence: 0.9 });
    const out = triageTurn({
      llm: g.f.llm, model: 'm', channel: 'web', question: 'offene Posten', tools: TOOLS, offered: [], allowedTools: ODOO, log: () => {},
    });
    await flush();
    assert.deepEqual([...g.started].sort(), [PLANNER_TOOL, ROUTER_TOOL], 'both in flight, nothing resolved');
    g.release(ROUTER_TOOL);
    g.release(PLANNER_TOOL);
    const r = await out;
    assert.equal(r.kind, 'plan');
  });

  it('an agent route discards the speculative plan (logged) and keeps the route hint', async () => {
    const logs: string[] = [];
    const g = gated({ decision: 'agent_complex', confidence: 0.9 });
    const out = triageTurn({
      llm: g.f.llm, model: 'm', channel: 'canvas', question: 'Analysiere', tools: TOOLS, offered: [], allowedTools: ODOO, log: (m) => logs.push(m),
    });
    await flush();
    g.release(ROUTER_TOOL); // the planner never resolves — not awaited
    const r = await out;
    assert.deepEqual([r.kind, r.kind === 'agent' && r.route, r.kind === 'agent' && r.reason], ['agent', 'complex', 'agent:complex']);
    assert.ok(logs.includes('[fast-path] planner discarded (route=agent:complex)'));
    g.release(PLANNER_TOOL);
  });

  it('a plan for another tool than the router chose is discarded (planner-tool-mismatch)', async () => {
    const tools = [...TOOLS, { name: 'search_contracts', spec: 'search_contracts — learned read tool' }];
    const g = gated(
      { decision: 'deterministic', tool: 'search_contracts', confidence: 0.9 },
      { ...PLAN_EXAMPLE },
    );
    const out = triageTurn({
      llm: g.f.llm, model: 'm', channel: 'web', question: 'x', tools, offered: [], allowedTools: new Set(['odoo_query', 'search_contracts']), log: () => {},
    });
    await flush();
    g.release(ROUTER_TOOL);
    g.release(PLANNER_TOOL);
    const r = await out;
    assert.equal(r.kind === 'agent' ? r.reason : '', 'planner-tool-mismatch');
  });

  it('privacy: ONLY the user-derived turn message is masked, ONCE; both calls get the masked text; the plan is restored', async () => {
    const m = masking();
    const previous = { question: 'Kontakt von Anna Schmidt', fetch: { tool: 'odoo_query', input: { model: 'res.partner' }, map: { name: 'name' } } };
    const f = llm((req) =>
      Promise.resolve(
        req.toolChoice?.name === ROUTER_TOOL
          ? toolCall(ROUTER_TOOL, { decision: 'deterministic', tool: 'odoo_query', confidence: 0.9 })
          : toolCall(PLANNER_TOOL, { ...PLAN_EXAMPLE, input: { model: 'res.partner', domain: [['name', 'ilike', 'Lukas Becker']] } }),
      ),
    );
    const r = await triageTurn({
      llm: f.llm, model: 'm', channel: 'web', question: 'Telefon von Anna Schmidt', tools: TOOLS, offered: [], allowedTools: ODOO, previous, privacy: m.run, log: () => {},
    });
    assert.equal(m.masked.length, 1, 'one mask call per turn');
    assert.equal(m.masked[0], buildTurnMessage({ question: 'Telefon von Anna Schmidt', previous }));
    assert.doesNotMatch(m.masked[0] ?? '', /SPEC-BODY|TOOLS|EXAMPLE|route_turn/, 'fixed text is never masked');
    for (const req of f.reqs) {
      assert.ok(!(req.messages[0]?.content ?? '').includes('Anna Schmidt'), 'masked user message');
      assert.match(req.messages[0]?.content ?? '', /USER TURN: Telefon von Lukas Becker/);
    }
    assert.ok(r.kind === 'plan');
    assert.deepEqual((r.plan.fetch.input as { domain: unknown }).domain, [['name', 'ilike', 'Anna Schmidt']]);
  });

  it('a refused mask skips both calls', async () => {
    const f = llm(toolCall(ROUTER_TOOL, {}));
    const r = await triageTurn({
      llm: f.llm, model: 'm', channel: 'web', question: 'x', tools: TOOLS, offered: [], allowedTools: ODOO,
      privacy: { mask: async () => ({ send: false, reason: 'blocked' }), restore: (t) => t },
      log: () => {},
    });
    assert.equal(r.kind === 'agent' ? r.reason : '', 'privacy-refused');
    assert.equal(f.reqs.length, 0);
  });
});
