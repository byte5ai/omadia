/**
 * Learned fast path — plans learned from successful agent canvas turns.
 *
 *   - learnable-tool classifier (read vs write names) and literal stripping
 *     of tool inputs and questions (tenant-wide plans carry no user literals);
 *   - capture: a candidate becomes ACTIVE only after two structurally equal,
 *     non-blocked, error-free agent turns; blocked / error / multi-tool turns
 *     never count;
 *   - persistence: schema-versioned JSON in the plugin memory scope, round
 *     trip, corrupt-file tolerance, no literal ever persisted;
 *   - use: the composer receives the top-K active plans, a learned tool is
 *     whitelisted and executed, an in-place follow-up re-fills the existing
 *     table without an agent turn; demotion after 2 failures; the
 *     `fast_path_tools=""` kill switch and force-guarded privacy skip both.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import { PRIVACY_FORCE_GUARDED_ENV_VAR, type PluginContext } from '../packages/plugin-api/src/index.js';
import {
  createLearnedPlanStore,
  PLANS_PATH,
  type PlanCandidate,
  type PlanMemory,
} from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import {
  isLearnableToolName,
  isRowTool,
  stripLiterals,
  stripQuestion,
  templateShape,
} from '../packages/harness-plugin-fast-path/src/literalStripping.js';
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import { activate, handleCanvasPublishRows } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { markSurrogates, maskExampleQuestion, PERSON_CANARY } from '../packages/harness-plugin-fast-path/src/exampleMasking.js';
import type {
  PrivacyPromptMaskResult,
  PrivacyStoredTextScope,
} from '../packages/plugin-api/src/index.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const invoiceInput = (partner: string, from: string, to: string): Record<string, unknown> => ({
  model: 'account.move',
  domain: [
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
    ['partner_id.name', 'ilike', partner],
    ['invoice_date', '>=', from],
    ['invoice_date', '<', to],
  ],
  fields: ['name', 'partner_id', 'invoice_date', 'amount_residual', 'currency_id'],
  limit: 100,
  order: 'invoice_date asc',
});

const INVOICE_MAP = { number: 'name', partner: 'partner_id.1', date: 'invoice_date', open: 'amount_residual' };

const invoiceSource = (partner: string, from: string, to: string): Record<string, unknown> => ({
  tool: 'odoo_query',
  input: invoiceInput(partner, from, to),
  map: INVOICE_MAP,
  rowKey: 'id',
});

const INVOICES = [
  { id: 11, name: 'RE/2026/0001', partner_id: [7, 'Müller GmbH'], invoice_date: '2026-01-10', amount_residual: 100, currency_id: [1, 'EUR'] },
  { id: 12, name: 'RE/2026/0002', partner_id: [7, 'Müller GmbH'], invoice_date: '2026-01-20', amount_residual: 50, currency_id: [1, 'EUR'] },
];
const odooOutput = (records: unknown[], truncated = false): string =>
  JSON.stringify({ model: 'account.move', scope: 'acc', count: records.length, truncated, records });

const COLUMNS = [
  { fieldKey: 'number', label: 'Nummer' },
  { fieldKey: 'partner', label: 'Kunde' },
  { fieldKey: 'date', label: 'Datum' },
  { fieldKey: 'open', label: 'Offen' },
];
const INVOICE_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [{ type: 'table', id: 'invoices', loading: 'skeleton', columns: COLUMNS, rows: [] }],
};

const composerOutput = (fetch?: unknown, summary?: string): string =>
  JSON.stringify({
    tree: INVOICE_TREE,
    dataRequirements: [
      { containerId: 'invoices', description: 'Offene Rechnungen', fields: COLUMNS, ...(fetch ? { fetch } : {}) },
    ],
    ...(summary ? { summary } : {}),
  });

/** One agent turn: a domain sub-agent runs ONE read query, the main turn
 *  publishes the rows with a `source` recipe. */
async function agentTurn(opts: {
  tool?: string;
  input: unknown;
  source?: unknown;
  done?: Partial<Extract<ChatStreamEvent, { type: 'done' }>>;
  extra?: ChatStreamEvent[];
  resultError?: boolean;
  containerId?: string;
}): Promise<ChatStreamEvent[]> {
  const tool = opts.tool ?? 'odoo_query';
  const publish = await handleCanvasPublishRows({
    containerId: opts.containerId ?? 'invoices',
    rows: [{ number: 'RE/2026/0001', partner: 'Müller GmbH', date: '2026-01-10', open: 100 }],
    ...(opts.source ? { source: opts.source } : {}),
  });
  return [
    { type: 'tool_use', id: 'q1', name: 'query_odoo_accounting', input: { question: 'x' } },
    { type: 'sub_tool_use', parentId: 'q1', id: 's1', name: tool, input: opts.input },
    {
      type: 'sub_tool_result',
      parentId: 'q1',
      id: 's1',
      output: opts.resultError ? 'Error: odoo down' : odooOutput(INVOICES),
      durationMs: 5,
      isError: opts.resultError === true,
    },
    { type: 'tool_result', id: 'q1', output: 'ok', durationMs: 10 },
    ...(opts.extra ?? []),
    { type: 'tool_use', id: 'p1', name: 'canvas_publish_rows', input: { containerId: 'invoices' } },
    { type: 'tool_result', id: 'p1', output: publish, durationMs: 1 },
    { type: 'text_delta', text: 'Fertig.' },
    { type: 'done', answer: 'Fertig.', toolCalls: 2, iterations: 2, ...opts.done },
  ];
}

const janTurn = (): Promise<ChatStreamEvent[]> =>
  agentTurn({
    input: invoiceInput('Müller GmbH', '2026-01-01', '2026-02-01'),
    source: invoiceSource('Müller GmbH', '2026-01-01', '2026-02-01'),
  });
const marTurn = (): Promise<ChatStreamEvent[]> =>
  agentTurn({
    input: invoiceInput('Schmidt AG', '2026-03-01', '2026-04-01'),
    source: invoiceSource('Schmidt AG', '2026-03-01', '2026-04-01'),
  });
const JAN_Q = 'Offene Rechnungen von Müller GmbH im Januar 2026';
const MAR_Q = 'Offene Rechnungen von Schmidt AG im März 2026!';

function fakeMemory(initial?: Record<string, string>): PlanMemory & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial ?? {}));
  return {
    files,
    exists: (p) => Promise.resolve(files.has(p)),
    readFile: (p) => {
      const v = files.get(p);
      return v === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(v);
    },
    writeFile: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
  };
}

type PrivacyMode = 'ok' | 'blocked' | 'degraded' | 'unconfigured' | 'absent';

/** Fake Privacy Shield stored-text scope: C1 finds the listed persons
 *  (realistic surrogates, like the real guard), C0 finds e-mails. */
const PERSONS: Record<string, string> = {
  'Anna Schmidt': 'Lukas Becker',
  'Peter Wagner': 'Jonas Frank',
  'Klaus Meier': 'Tim Vogel',
};
function fakePrivacy(mode: () => PrivacyMode): { openStoredTextScope: () => PrivacyStoredTextScope } {
  return {
    openStoredTextScope: () => ({
      restoreStoredText: (t) => t,
      maskStoredText: (text): Promise<PrivacyPromptMaskResult> => {
        const m = mode();
        if (m === 'blocked' && text !== PERSON_CANARY) {
          return Promise.resolve({ outcome: 'blocked', reason: 'residual PII span survived substitution' });
        }
        const spans: Array<{ type: string; detector: string }> = [];
        let masked = text.replace(/[^\s@]+@[^\s@]+\.[a-z]+/g, () => {
          spans.push({ type: 'email', detector: 'c0' });
          return 'max.muster@example.net';
        });
        if (m !== 'unconfigured' && m !== 'degraded') {
          for (const [real, surrogate] of Object.entries(PERSONS)) {
            if (masked.includes(real)) {
              masked = masked.split(real).join(surrogate);
              spans.push({ type: 'person', detector: 'c1-gliner' });
            }
          }
        }
        return Promise.resolve({ outcome: 'masked', maskedText: masked, spans, degraded: m === 'degraded' });
      },
    }),
  };
}

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  invokeCalls: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
  composerSystems: string[];
  plannerUsers: string[];
  memory: ReturnType<typeof fakeMemory>;
  /** mutable script */
  s: { composer: string; planner: string; turns: ChatStreamEvent[][]; privacy: PrivacyMode };
}

async function harness(opts: {
  config?: Record<string, string>;
  invoke?: (name: string, input: unknown) => Promise<string>;
  memory?: ReturnType<typeof fakeMemory>;
  privacy?: PrivacyMode;
  /** the base agent's own tool list (default: odoo_query) */
  offeredTools?: string[];
} = {}): Promise<Harness> {
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const invokeCalls: Array<{ name: string; input: unknown }> = [];
  const baseInputs: ChatTurnInput[] = [];
  const composerSystems: string[] = [];
  const plannerUsers: string[] = [];
  const memory = opts.memory ?? fakeMemory();
  const s = {
    composer: composerOutput(),
    planner: '{"none":true}',
    turns: [] as ChatStreamEvent[][],
    privacy: opts.privacy ?? ('ok' as PrivacyMode),
  };
  if (s.privacy !== 'absent') reg.set('privacyRedact', fakePrivacy(() => s.privacy));
  const ctx = {
    log: (m: string) => logs.push(m),
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: {
      complete: (req: { system?: string; messages: Array<{ content: string }> }) => {
        if (req.system?.includes('in-place fast-path planner')) {
          plannerUsers.push(req.messages[0]?.content ?? '');
          return Promise.resolve({ text: s.planner });
        }
        composerSystems.push(req.system ?? '');
        return Promise.resolve({ text: s.composer });
      },
    },
    config: { get: <T>(k: string): T | undefined => opts.config?.[k] as T | undefined },
    memory,
    tools: {
      register: () => () => {},
      invoke: async (name: string, input: unknown): Promise<string> => {
        invokeCalls.push({ name, input });
        if (opts.invoke) return opts.invoke(name, input);
        if (name === 'odoo_query') return odooOutput(INVOICES);
        throw new Error(`tools.invoke: '${name}' is unknown or handler-less`);
      },
    },
  } as unknown as PluginContext;
  reg.set(CHAT_AGENT_SERVICE, {
    agent: {
      // the base agent's own tool list — the fast path stays within it
      offeredToolNames: () => new Set(opts.offeredTools ?? ['odoo_query']),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        await Promise.resolve();
        yield* s.turns.shift() ?? [{ type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 }];
      },
    },
  } satisfies ChatAgentBundle);
  reg.set(
    FAST_PATH_SERVICE,
    createFastPathService({
      config: ctx.config,
      model: 'class:fast',
      memory,
      privacyGuard: () => reg.get('privacyRedact') as never,
      privacyForced: () => false,
      log: (m) => logs.push(m),
    }),
  );
  await activate(ctx);
  const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  return { agent, logs, invokeCalls, baseInputs, composerSystems, plannerUsers, memory, s };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const turn = (userMessage: string, over?: Partial<ChatTurnInput>): ChatTurnInput =>
  ({ userMessage, canvasSessionId: 'cs-learn', ...over }) as ChatTurnInput;

const field = (e: ChatStreamEvent | undefined, k: string): unknown =>
  (e as unknown as Record<string, unknown> | undefined)?.[k];

/** Run two clean learning turns (Jan + Mar) → the invoice plan is active. */
async function learnInvoicePlan(h: Harness): Promise<string> {
  h.s.turns.push(await janTurn(), await marTurn());
  await collect(h.agent.chatStream(turn(JAN_Q)));
  await collect(h.agent.chatStream(turn(MAR_Q)));
  const activated = h.logs.find((m) => m.includes('learned plan activated'));
  assert.ok(activated, `activated (logs: ${h.logs.filter((m) => m.includes('learned')).join(' | ')})`);
  return /plan=([0-9a-f]+)/.exec(activated)?.[1] ?? '';
}

const FEB_FETCH = { ...invoiceSource('Weber KG', '2026-02-01', '2026-03-01') };

// ── classifier + stripping ─────────────────────────────────────────────────

describe('learned fast path — learnable tool names', () => {
  it('read names are learnable, write names never', () => {
    for (const n of ['odoo_query', 'query_invoices', 'get_partner', 'list_contracts', 'search_leads', 'crm_search', 'hr_lookup', 'describe_model', 'Fetch_Orders']) {
      assert.equal(isLearnableToolName(n), true, n);
    }
    for (const n of ['create_invoice', 'odoo_execute', 'send_mail', 'get_and_update_partner', 'list_delete', 'search_and_post', 'query_sync', 'canvas_publish_rows', 'memory', 'v4_select', 'run_query', 'lookup_pay']) {
      assert.equal(isLearnableToolName(n), false, n);
    }
  });

  it('describe-tools are learnable but not row sources', () => {
    assert.equal(isRowTool('describe_model'), false);
    assert.equal(isRowTool('odoo_describe'), false);
    assert.equal(isRowTool('odoo_query'), true);
  });
});

describe('learned fast path — literal stripping', () => {
  it('strips names, free text and emails; keeps models, fields, operators, enums, dates, limits', () => {
    const { template, literals } = stripLiterals({
      ...invoiceInput('Müller GmbH', '2026-01-01', '2026-02-01'),
      extra: [['email', '=', 'anna@example.com'], ['partner_id', '=', 42], ['is_company', '=', true]],
    });
    const t = template as Record<string, unknown>;
    assert.equal(t['model'], 'account.move');
    assert.deepEqual(t['fields'], ['name', 'partner_id', 'invoice_date', 'amount_residual', 'currency_id']);
    assert.equal(t['limit'], 100);
    assert.equal(t['order'], 'invoice_date asc');
    assert.deepEqual(t['domain'], [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['partner_id.name', 'ilike', '{{text_1}}'],
      ['invoice_date', '>=', '2026-01-01'],
      ['invoice_date', '<', '2026-02-01'],
    ]);
    assert.deepEqual(t['extra'], [['email', '=', '{{email_1}}'], ['partner_id', '=', '{{id_1}}'], ['is_company', '=', true]]);
    assert.equal(literals.get('{{text_1}}'), 'Müller GmbH');
    assert.equal(literals.get('{{email_1}}'), 'anna@example.com');
    assert.equal(literals.get('{{id_1}}'), 42);
    assert.doesNotMatch(JSON.stringify(template), /Müller|anna@|42/);
  });

  it('strips free-text keys of generic tools; a lowercase enum on a non-personal field stays', () => {
    const { template } = stripLiterals({ query: 'acme', status: 'active', name: 'Bob', limit: 20 });
    assert.deepEqual(template, { query: '{{text_1}}', status: 'active', name: '{{text_2}}', limit: 20 });
    const lower = stripLiterals({ domain: [['partner_id.name', '=', 'mueller'], ['state', '=', 'draft']] });
    assert.deepEqual((lower.template as { domain: unknown }).domain, [
      ['partner_id.name', '=', '{{text_1}}'],
      ['state', '=', 'draft'],
    ]);
  });

  it('strips the question: the turn literals, emails, long numbers — lowercase, no punctuation', () => {
    const { literals } = stripLiterals(invoiceInput('Müller GmbH', '2026-01-01', '2026-02-01'));
    assert.equal(stripQuestion(`${JAN_Q}?`, literals), 'offene rechnungen von {{text_1}} im januar 2026');
    assert.equal(
      stripQuestion('Kontakt anna@example.com, Kunde 4711234!', new Map()),
      'kontakt {{email}} kunde {{number}}',
    );
  });

  it('January and March asks share one structural shape; another enum does not', () => {
    const jan = stripLiterals(invoiceInput('Müller GmbH', '2026-01-01', '2026-02-01')).template;
    const mar = stripLiterals(invoiceInput('Schmidt AG', '2026-03-01', '2026-04-01')).template;
    assert.deepEqual(templateShape(jan), templateShape(mar));
    const payables = stripLiterals({ ...invoiceInput('X', '2026-03-01', '2026-04-01'), domain: [['move_type', '=', 'in_invoice']] }).template;
    assert.notDeepEqual(templateShape(jan), templateShape(payables));
  });
});

// ── store ───────────────────────────────────────────────────────────────────

const candidate = (partner: string, from: string, to: string, example: string): PlanCandidate => {
  const { template } = stripLiterals(invoiceInput(partner, from, to));
  return { tool: 'odoo_query', inputTemplate: template, map: INVOICE_MAP, rowKey: 'id', example };
};

describe('learned fast path — plan store', () => {
  it('activates only after 2 structurally equal successes; a different map is another plan', async () => {
    const logs: string[] = [];
    const store = createLearnedPlanStore({ memory: fakeMemory(), log: (m) => logs.push(m) });
    await store.load();
    const a = await store.recordSuccess(candidate('{{text_1}}', '2026-01-01', '2026-02-01', 'q jan'));
    assert.equal(a.activated, false);
    assert.equal(store.active().length, 0);
    const other = await store.recordSuccess({ ...candidate('x', '2026-01-01', '2026-02-01', 'q'), map: { number: 'name' } });
    assert.notEqual(other.plan.id, a.plan.id);
    const b = await store.recordSuccess(candidate('{{text_1}}', '2026-03-01', '2026-04-01', 'q mar'));
    assert.equal(b.plan.id, a.plan.id);
    assert.equal(b.activated, true);
    assert.equal(b.plan.successes, 2);
    assert.deepEqual(b.plan.examples, ['q mar', 'q jan']);
    assert.deepEqual(store.active().map((p) => p.id), [a.plan.id]);
    assert.ok(logs.includes(`[fast-path] learned plan activated plan=${a.plan.id} tool=odoo_query`));
  });

  it('persists a schema-versioned file and reloads it (round trip)', async () => {
    const memory = fakeMemory();
    const s1 = createLearnedPlanStore({ memory, log: () => {} });
    await s1.load();
    await s1.recordSuccess(candidate('{{text_1}}', '2026-01-01', '2026-02-01', 'offene rechnungen januar'));
    const { plan } = await s1.recordSuccess(candidate('{{text_1}}', '2026-03-01', '2026-04-01', 'offene rechnungen märz'));
    const doc = JSON.parse(memory.files.get(PLANS_PATH) ?? '{}') as { schemaVersion: number; plans: unknown[] };
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.plans.length, 1);
    const s2 = createLearnedPlanStore({ memory, log: () => {} });
    await s2.load();
    assert.deepEqual(s2.get(plan.id), plan);
    assert.equal(s2.rank('Offene Rechnungen im März?', 5)[0]?.plan.id, plan.id);
    assert.deepEqual(s2.rank('Geburtstage im Juni', 5), [], 'no overlap → nothing offered');
  });

  it('a corrupt or foreign file starts empty and is logged', async () => {
    for (const content of ['{not json', JSON.stringify({ schemaVersion: 99, plans: [] })]) {
      const logs: string[] = [];
      const store = createLearnedPlanStore({ memory: fakeMemory({ [PLANS_PATH]: content }), log: (m) => logs.push(m) });
      await store.load();
      assert.equal(store.active().length, 0);
      assert.ok(logs.some((m) => /learned plans: (unreadable|unsupported) file/.test(m)), logs.join('|'));
    }
  });

  it('is bounded: LRU by lastUsed', async () => {
    let t = 0;
    const store = createLearnedPlanStore({ log: () => {}, maxPlans: 2, now: () => new Date(1_000 * ++t) });
    const a = await store.recordSuccess({ ...candidate('x', '2026-01-01', '2026-02-01', 'a'), map: { a: 'a' } });
    const b = await store.recordSuccess({ ...candidate('x', '2026-01-01', '2026-02-01', 'b'), map: { b: 'b' } });
    await store.recordSuccess({ ...candidate('x', '2026-01-01', '2026-02-01', 'c'), map: { c: 'c' } });
    assert.equal(store.get(a.plan.id), undefined, 'oldest evicted');
    assert.ok(store.get(b.plan.id));
  });

  it('deactivates after 2 consecutive execution failures; a success resets the streak', async () => {
    const logs: string[] = [];
    const store = createLearnedPlanStore({ log: (m) => logs.push(m) });
    await store.recordSuccess(candidate('x', '2026-01-01', '2026-02-01', 'a'));
    const { plan } = await store.recordSuccess(candidate('x', '2026-03-01', '2026-04-01', 'b'));
    await store.recordExecution(plan.id, false, 'tool-error');
    await store.recordExecution(plan.id, true);
    assert.equal((await store.recordExecution(plan.id, false, 'unmappable')).deactivated, false);
    assert.equal((await store.recordExecution(plan.id, false, 'truncated')).deactivated, true);
    assert.equal(store.active().length, 0);
    assert.ok(logs.some((m) => m.startsWith(`[fast-path] learned plan deactivated plan=${plan.id}`)));
  });
});

// ── capture on the agent path ───────────────────────────────────────────────

describe('learned fast path — capture from agent turns', () => {
  afterEach(() => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
  });

  it('candidate after one clean turn, active after the second; persisted without literals', async () => {
    const h = await harness();
    const id = await learnInvoicePlan(h);
    assert.ok(h.logs.includes(`[fast-path] learned candidate plan=${id} tool=odoo_query successes=1`));
    assert.ok(h.logs.includes(`[fast-path] learned candidate plan=${id} tool=odoo_query successes=2`));
    const file = h.memory.files.get(PLANS_PATH) ?? '';
    assert.match(file, /offene rechnungen von \{\{text_1\}\} im märz 2026/);
    assert.doesNotMatch(file, /Müller|Schmidt|müller|schmidt|RE\/2026/, 'no literal, no row data persisted');
  });

  it('verifier-blocked and error turns never count', async () => {
    const h = await harness();
    h.s.turns.push(
      await agentTurn({ input: invoiceInput('A', '2026-01-01', '2026-02-01'), source: invoiceSource('A', '2026-01-01', '2026-02-01'), done: { answerSource: 'verifier-blocked' } }),
      await agentTurn({ input: invoiceInput('A', '2026-01-01', '2026-02-01'), source: invoiceSource('A', '2026-01-01', '2026-02-01'), resultError: true }),
      await agentTurn({ input: invoiceInput('A', '2026-01-01', '2026-02-01'), source: invoiceSource('A', '2026-01-01', '2026-02-01'), extra: [{ type: 'error', message: 'boom' }] }),
      await janTurn(),
    );
    for (let i = 0; i < 4; i += 1) await collect(h.agent.chatStream(turn(JAN_Q)));
    assert.ok(h.logs.includes('[fast-path] learned skip reason=blocked'));
    assert.ok(h.logs.includes('[fast-path] learned skip reason=tool-error'));
    assert.ok(h.logs.includes('[fast-path] learned skip reason=turn-error'));
    assert.equal(h.logs.filter((m) => m.includes('learned candidate')).length, 1);
    assert.ok(h.logs.some((m) => m.includes('successes=1')));
    assert.equal(h.logs.some((m) => m.includes('activated')), false);
  });

  it('multi-tool, write-tool and source-less turns are not learned', async () => {
    const h = await harness();
    const second: ChatStreamEvent[] = [
      { type: 'sub_tool_use', parentId: 'q1', id: 's2', name: 'odoo_query', input: { model: 'res.partner' } },
      { type: 'sub_tool_result', parentId: 'q1', id: 's2', output: '{}', durationMs: 1, isError: false },
    ];
    const write: ChatStreamEvent[] = [{ type: 'tool_use', id: 'w', name: 'odoo_execute', input: {} }];
    h.s.turns.push(
      await agentTurn({ input: invoiceInput('A', '2026-01-01', '2026-02-01'), source: invoiceSource('A', '2026-01-01', '2026-02-01'), extra: second }),
      await agentTurn({ input: invoiceInput('A', '2026-01-01', '2026-02-01'), source: invoiceSource('A', '2026-01-01', '2026-02-01'), extra: write }),
      await agentTurn({ input: invoiceInput('A', '2026-01-01', '2026-02-01') }),
    );
    for (let i = 0; i < 3; i += 1) await collect(h.agent.chatStream(turn(JAN_Q)));
    assert.ok(h.logs.includes('[fast-path] learned skip reason=read-calls=2'));
    assert.ok(h.logs.includes('[fast-path] learned skip reason=non-read-tool'));
    assert.ok(h.logs.includes('[fast-path] learned skip reason=no-map'));
    assert.equal(h.logs.some((m) => m.includes('learned candidate')), false);
  });

  it('kill switch fast_path_tools="": nothing learned, nothing persisted, no in-place planner', async () => {
    const h = await harness({ config: { fast_path_tools: '' } });
    h.s.turns.push(await janTurn(), await marTurn());
    await collect(h.agent.chatStream(turn(JAN_Q)));
    await collect(h.agent.chatStream(turn(MAR_Q)));
    await collect(h.agent.chatStream(turn('und im Februar?', { canvasState: { basedOnRevision: '3', currentTree: INVOICE_TREE } })));
    assert.equal(h.logs.some((m) => /learned (candidate|skip)|learned-plan/.test(m)), false);
    assert.equal(h.memory.files.size, 0);
    assert.equal(h.plannerUsers.length, 0);
    assert.equal(h.baseInputs.length, 3);
  });

  it('privacy force-guarded: nothing learned, no planner call', async () => {
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true';
    const h = await harness({ privacy: 'absent' });
    h.s.turns.push(await janTurn(), await marTurn());
    await collect(h.agent.chatStream(turn(JAN_Q)));
    await collect(h.agent.chatStream(turn(MAR_Q)));
    await collect(h.agent.chatStream(turn('und im Februar?', { canvasState: { basedOnRevision: '3', currentTree: INVOICE_TREE } })));
    assert.equal(h.logs.some((m) => m.includes('learned candidate')), false);
    assert.ok(h.logs.includes('[ui-orchestrator] learned-plan miss reason=privacy-forced path=in-place'));
    assert.equal(h.plannerUsers.length, 0);
    assert.equal(h.memory.files.size, 0);
  });
});

// ── example masking (Privacy Shield stored-text scope) ──────────────────────

describe('learned fast path — example questions are privacy-masked before storing', () => {
  const PERSON_Q = 'Offene Rechnungen von Müller GmbH, die Anna Schmidt gebucht hat';

  it('markSurrogates: surrogate runs become typed placeholders, carried words stay', () => {
    const m = markSurrogates('Rechnung für Anna Schmidt an a@b.de', 'Rechnung für Lukas Becker an max.muster@example.net', ['person', 'email']);
    assert.equal(m.text, 'Rechnung für zzpii0zz an zzpii1zz');
    assert.deepEqual([...m.placeholders.values()], ['{{person}}', '{{email}}']);
  });

  it('maskExampleQuestion: canary fine but the question degraded/blocked → refused', async () => {
    for (const late of ['degraded', 'blocked'] as const) {
      let calls = 0;
      const scope: PrivacyStoredTextScope = {
        restoreStoredText: (t) => t,
        maskStoredText: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({ outcome: 'masked', maskedText: 'x', spans: [{ type: 'person', detector: 'c1-gliner' }], degraded: false });
          }
          return Promise.resolve(
            late === 'blocked'
              ? { outcome: 'blocked', reason: 'detector failed' }
              : { outcome: 'masked', maskedText: 'q', spans: [], degraded: true },
          );
        },
      };
      assert.deepEqual(await maskExampleQuestion('Rechnungen von Anna', new Map(), () => scope), {
        ok: false,
        detail: `question-${late}`,
      });
    }
  });

  it('a person name NOT in the tool input is stored as {{person}} — never in clear', async () => {
    const h = await harness();
    h.s.turns.push(await janTurn());
    await collect(h.agent.chatStream(turn(PERSON_Q)));
    const file = h.memory.files.get(PLANS_PATH) ?? '';
    assert.match(file, /offene rechnungen von \{\{text_1\}\} die \{\{person\}\} gebucht hat/);
    assert.doesNotMatch(file, /anna|schmidt|lukas|becker|müller/i, 'neither the real name nor its surrogate');
    assert.equal(h.logs.some((m) => /anna|schmidt/i.test(m)), false, 'the question is never logged');
  });

  for (const [mode, detail] of [
    ['blocked', 'question-blocked'],
    ['degraded', 'canary-degraded'],
    ['unconfigured', 'person-check-unavailable'],
    ['absent', 'privacy-unavailable'],
  ] as const) {
    it(`${mode} → no example stored, no success counted for a new plan`, async () => {
      const h = await harness({ privacy: mode });
      h.s.turns.push(await janTurn(), await marTurn());
      await collect(h.agent.chatStream(turn(PERSON_Q)));
      await collect(h.agent.chatStream(turn(MAR_Q)));
      assert.equal(
        h.logs.filter((m) => m === `[fast-path] learned skip reason=example-unmasked detail=${detail}`).length,
        2,
        h.logs.filter((m) => m.includes('learned')).join(' | '),
      );
      assert.equal(h.logs.some((m) => m.includes('learned candidate')), false);
      assert.equal(h.memory.files.size, 0, 'nothing persisted');
    });
  }

  it('a plan that already has a stored example still counts the success, without a new example', async () => {
    const h = await harness();
    h.s.turns.push(await janTurn(), await marTurn());
    await collect(h.agent.chatStream(turn(JAN_Q)));
    h.s.privacy = 'degraded';
    await collect(h.agent.chatStream(turn(PERSON_Q)));
    assert.ok(h.logs.includes('[fast-path] learned example not stored reason=example-unmasked detail=canary-degraded'));
    assert.ok(h.logs.some((m) => m.includes('learned plan activated')));
    const doc = JSON.parse(h.memory.files.get(PLANS_PATH) ?? '{}') as { plans: Array<{ examples: string[] }> };
    assert.deepEqual(doc.plans[0]?.examples, ['offene rechnungen von {{text_1}} im januar 2026']);
  });
});

// ── use ─────────────────────────────────────────────────────────────────────

describe('learned fast path — use', () => {
  it('the composer receives the active plan as a validated example and its adapted fetch is executed', async () => {
    const h = await harness();
    const id = await learnInvoicePlan(h);
    assert.doesNotMatch(h.composerSystems[0] ?? '', /VALIDATED EXAMPLES/, 'nothing offered before activation');
    h.s.composer = composerOutput(FEB_FETCH, '{count} offene Rechnungen.');
    const events = await collect(h.agent.chatStream(turn('Offene Rechnungen von Weber KG im Februar 2026')));
    const system = h.composerSystems.at(-1) ?? '';
    assert.match(system, /VALIDATED EXAMPLES/);
    assert.match(system, /user asked "offene rechnungen von \{\{text_1\}\} im märz 2026"/);
    assert.equal(h.baseInputs.length, 2, 'no agent turn for the third ask');
    assert.deepEqual(h.invokeCalls.at(-1), { name: 'odoo_query', input: FEB_FETCH.input });
    assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text')), ['2 offene Rechnungen.']);
    assert.ok(h.logs.includes(`[ui-orchestrator] learned-plan hit plan=${id} path=new-canvas`));
  });

  it('a fetch that still carries a placeholder is dropped → agent fallback', async () => {
    const h = await harness();
    await learnInvoicePlan(h);
    h.s.composer = composerOutput(invoiceSource('{{text_1}}', '2026-02-01', '2026-03-01'), '{count} offene Rechnungen.');
    await collect(h.agent.chatStream(turn('Offene Rechnungen von Weber KG im Februar 2026')));
    assert.equal(h.baseInputs.length, 3);
    assert.ok(h.logs.some((m) => m.startsWith('[ui-orchestrator] learned-plan miss reason=no-plan path=new-canvas')));
  });

  it('a learned non-built-in read tool gets a spec, passes the whitelist and is executed', async () => {
    const contractsSource = (q: string): Record<string, unknown> => ({
      tool: 'search_contracts',
      input: { query: q, status: 'active', limit: 50 },
      map: { number: 'ref', partner: 'customer', date: 'end_date', open: 'value' },
      itemsPath: 'items',
      rowKey: 'id',
    });
    const contracts = JSON.stringify({ items: [{ id: 1, ref: 'C-1', customer: 'Acme', end_date: '2026-12-31', value: 10 }] });
    const h = await harness({
      invoke: (name) => Promise.resolve(name === 'search_contracts' ? contracts : odooOutput([])),
      offeredTools: ['odoo_query', 'search_contracts'],
    });
    const learnTurn = (q: string): Promise<ChatStreamEvent[]> =>
      agentTurn({ tool: 'search_contracts', input: contractsSource(q)['input'], source: contractsSource(q) });
    h.s.turns.push(await learnTurn('Acme'), await learnTurn('Globex'));
    await collect(h.agent.chatStream(turn('Aktive Verträge von Acme')));
    await collect(h.agent.chatStream(turn('Aktive Verträge von Globex')));
    assert.ok(h.logs.some((m) => m.includes('learned plan activated') && m.includes('tool=search_contracts')));
    h.s.composer = composerOutput(contractsSource('Initech'), '{count} aktive Verträge.');
    const events = await collect(h.agent.chatStream(turn('Aktive Verträge von Initech')));
    assert.match(h.composerSystems.at(-1) ?? '', /search_contracts — learned read tool/);
    assert.deepEqual(h.invokeCalls.at(-1), { name: 'search_contracts', input: { query: 'Initech', status: 'active', limit: 50 } });
    assert.equal(h.baseInputs.length, 2);
    assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text')), ['1 aktive Verträge.']);
  });

  it('a learned tool the base agent does not offer is never offered, planned or run', async () => {
    const contractsSource = (q: string): Record<string, unknown> => ({
      tool: 'search_contracts',
      input: { query: q, status: 'active', limit: 50 },
      map: { number: 'ref', partner: 'customer', date: 'end_date', open: 'value' },
      itemsPath: 'items',
      rowKey: 'id',
    });
    const h = await harness();
    const learnTurn = (q: string): Promise<ChatStreamEvent[]> =>
      agentTurn({ tool: 'search_contracts', input: contractsSource(q)['input'], source: contractsSource(q) });
    h.s.turns.push(await learnTurn('Acme'), await learnTurn('Globex'));
    await collect(h.agent.chatStream(turn('Aktive Verträge von Acme')));
    await collect(h.agent.chatStream(turn('Aktive Verträge von Globex')));
    assert.ok(h.logs.some((m) => m.includes('learned plan activated') && m.includes('tool=search_contracts')));
    h.s.composer = composerOutput(contractsSource('Initech'), '{count} aktive Verträge.');
    await collect(h.agent.chatStream(turn('Aktive Verträge von Initech')));
    assert.doesNotMatch(h.composerSystems.at(-1) ?? '', /search_contracts/, 'not offered to the composer');
    assert.ok(!h.invokeCalls.some((c) => c.name === 'search_contracts'), 'never invoked');
    assert.equal(h.baseInputs.length, 3, 'the agent answers');
  });

  it('an unlearned tool outside the allow-list stays refused', async () => {
    const h = await harness();
    h.s.composer = composerOutput({ ...FEB_FETCH, tool: 'search_contracts' }, '{count} x.');
    await collect(h.agent.chatStream(turn('Verträge')));
    assert.equal(h.baseInputs.length, 1);
    assert.equal(h.invokeCalls.length, 0);
  });

  it('in-place follow-up hit: one planner call re-fills the EXISTING table, no agent turn', async () => {
    const h = await harness();
    const id = await learnInvoicePlan(h);
    const live = structuredClone(INVOICE_TREE) as typeof INVOICE_TREE;
    (live.children[0] as Record<string, unknown>)['loading'] = 'none';
    (live.children[0] as Record<string, unknown>)['rows'] = [{ rowKey: '11', cells: { number: 'RE/2026/0001', partner: 'Müller GmbH', date: '2026-01-10', open: 100 } }];
    h.s.planner = JSON.stringify({ containerId: 'invoices', fetch: FEB_FETCH, summary: '{count} offene Rechnungen im Februar.' });
    const events = await collect(h.agent.chatStream(turn('und im Februar?', { canvasState: { basedOnRevision: '3', currentTree: live } })));
    assert.equal(h.baseInputs.length, 2, 'no agent turn');
    assert.equal(h.plannerUsers.length, 1);
    assert.match(h.plannerUsers[0] ?? '', /FOLLOW-UP: und im Februar\?/);
    assert.match(h.plannerUsers[0] ?? '', /offene rechnungen von \{\{text_1\}\}/);
    assert.doesNotMatch(h.plannerUsers[0] ?? '', /RE\/2026\/0001/, 'no row data reaches the planner');
    const patch = events.find((e) => e.type === 'surface_patch');
    assert.equal(field(patch, 'basedOnRevision'), '3');
    const ops = field(patch, 'patches') as Array<{ op: string; path: string; value: unknown }>;
    const rowsOp = ops.find((o) => o.path.endsWith('/rows'));
    assert.equal(rowsOp?.op, 'replace', 'rows replaced, not appended');
    assert.equal((rowsOp?.value as unknown[]).length, 2);
    assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text')), ['2 offene Rechnungen im Februar.']);
    assert.equal(events.at(-1)?.type, 'done');
    assert.ok(h.logs.some((m) => m.startsWith(`[ui-orchestrator] learned-plan hit plan=${id} path=in-place rows=2`)));
  });

  it('in-place: planner says none → the in-place agent path runs unchanged', async () => {
    const h = await harness();
    await learnInvoicePlan(h);
    h.s.planner = '{"none":true}';
    const events = await collect(h.agent.chatStream(turn('und im Februar?', { canvasState: { basedOnRevision: '3', currentTree: INVOICE_TREE } })));
    assert.equal(h.baseInputs.length, 3);
    assert.match(h.baseInputs[2]?.userMessage ?? '', /\[canvas-context\]/);
    assert.ok(h.logs.includes('[ui-orchestrator] learned-plan miss reason=planner-none path=in-place'));
    assert.equal(events.filter((e) => e.type.startsWith('surface_')).length, 0);
  });

  it('in-place without an active plan: no planner call', async () => {
    const h = await harness();
    await collect(h.agent.chatStream(turn('und im Februar?', { canvasState: { basedOnRevision: '3', currentTree: INVOICE_TREE } })));
    assert.equal(h.plannerUsers.length, 0);
    assert.ok(h.logs.includes('[ui-orchestrator] learned-plan miss reason=no-match path=in-place'));
  });

  it('demotion: 2 consecutive fast-path failures deactivate the plan; it is no longer offered', async () => {
    let failing = false;
    const h = await harness({ invoke: () => Promise.resolve(failing ? 'Error: odoo_upstream_500' : odooOutput(INVOICES)) });
    const id = await learnInvoicePlan(h);
    h.s.composer = composerOutput(FEB_FETCH, '{count} offene Rechnungen.');
    failing = true;
    await collect(h.agent.chatStream(turn('Offene Rechnungen von Weber KG im Februar 2026')));
    assert.ok(h.logs.includes(`[ui-orchestrator] learned-plan miss reason=tool-error path=new-canvas offered=1 plan=${id}`));
    await collect(h.agent.chatStream(turn('Offene Rechnungen von Weber KG im Februar 2026')));
    assert.ok(h.logs.some((m) => m.startsWith(`[fast-path] learned plan deactivated plan=${id}`)));
    await collect(h.agent.chatStream(turn('Offene Rechnungen von Weber KG im Februar 2026')));
    assert.doesNotMatch(h.composerSystems.at(-1) ?? '', /VALIDATED EXAMPLES/);
  });
});
