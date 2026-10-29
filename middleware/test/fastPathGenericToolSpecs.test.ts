/**
 * Generic planner specs (`@omadia/fast-path` genericToolSpecs.ts): the read
 * tools of EVERY plugin become plannable from their own registry definition.
 *
 *   1. spec derivation — only `isRowTool` names, catalog wins, name order,
 *      per-tool cap, total budget, deterministic, no emails/long numbers;
 *   2. planner prompt — the generic rule rides only with a generic tool, the
 *      catalog-only prompt is unchanged, learned examples stay last;
 *   3. a plan for a generic tool must name `itemsPath`; one that does not
 *      resolve to an array is refused at execution (→ agent);
 *   4. router — the generic tool's one-line purpose;
 *   5. service — chat triage plans + runs a generic tool, never a write tool,
 *      never a tool the agent does not offer; the canvas whitelist learns it;
 *   6. orchestrator — the triage gets the Agent's own plugin read-tool
 *      definitions (no kernel tools, no write-capable tools);
 *   7. canvas — a generic tool fills a canvas table when the base agent
 *      offers its definition; without one the base agent answers.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import { activate as activateCanvas } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import {
  fetchRecipeRows,
  plannableTools,
  toolPurpose,
  type FastPathToolSpec,
} from '../packages/harness-plugin-fast-path/src/fastPath.js';
import {
  GENERIC_MARKER,
  GENERIC_SPEC_MAX_CHARS,
  GENERIC_SPECS_BUDGET,
  GENERIC_TOOLS_RULE,
  genericToolSpec,
  genericToolSpecs,
  type FastPathToolDefinition,
} from '../packages/harness-plugin-fast-path/src/genericToolSpecs.js';
import type { LearnedPlan } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { createLearnedPlanStore } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import {
  buildPlannerSystem,
  itemsPathRequired,
  parsePlan,
  PLANNER_SYSTEM,
} from '../packages/harness-plugin-fast-path/src/planner.js';
import { buildRouterSystem } from '../packages/harness-plugin-fast-path/src/router.js';
import {
  createFastPathService,
  FAST_PATH_SERVICE,
  type ChatTriageRequest,
} from '../packages/harness-plugin-fast-path/src/service.js';
import { withRouterPlanner, type ForcedCall } from './_helpers/fastPathRouterPlanner.js';
import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { FastPathTriagePort } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';

// ── fixtures: real-world shaped plugin tool definitions ──────────────────

const DYNAMICS_QUERY: FastPathToolDefinition = {
  name: 'dynamics_query',
  description:
    'Read records from Microsoft Dynamics 365 (Dataverse) via OData. READ-ONLY — never creates, updates or deletes. ' +
    'Use for questions about CRM data: accounts (companies), contacts (people), leads, opportunities (deals), activities, etc. ' +
    'Provide the plural entity set name and optional OData filters.',
  input_schema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Plural entity set name, e.g. "accounts", "contacts", "leads".' },
      select: { type: 'array', items: { type: 'string' }, description: 'Logical column names to return.' },
      filter: { type: 'string', description: 'Raw OData $filter expression, e.g. "statecode eq 0".' },
      orderby: { type: 'string', description: 'OData $orderby, e.g. "createdon desc".' },
      top: { type: 'number', description: 'Max rows to return (1–500, default 50).' },
    },
    required: ['entity'],
  },
};
const PAPIERKRAM_QUERY: FastPathToolDefinition = {
  name: 'papierkram_query',
  description:
    'Read ONE page of records from Papierkram (read-only). Use for browsing/looking up specific records. ' +
    'Pass `endpoint` (e.g. "income/invoices"), optional `id`, `filters` and `page`/`page_size`. NEVER creates, updates or deletes.',
  input_schema: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', enum: ['income/invoices', 'income/estimates', 'contact/companies', 'projects'] },
      id: { type: 'number' },
      filters: { type: 'object' },
      page: { type: 'number' },
      page_size: { type: 'number' },
    },
    required: ['endpoint'],
  },
};
const WRITE_TOOLS: FastPathToolDefinition[] = [
  { name: 'dynamics_write', description: 'Create or update records.', input_schema: { type: 'object', properties: {} } },
  { name: 'gw_gmail_send', description: 'Send a mail.', input_schema: { type: 'object', properties: {} } },
  { name: 'odoo_execute', description: 'Run an Odoo method.', input_schema: { type: 'object', properties: {} } },
  // a read verb AND a write token — the write token wins
  { name: 'get_and_update_records', description: 'x', input_schema: { type: 'object', properties: {} } },
];
const NOT_ROWS: FastPathToolDefinition[] = [
  { name: 'papierkram_describe', description: 'Schema of an endpoint.', input_schema: { type: 'object', properties: {} } },
  { name: 'render_diagram', description: 'Render a diagram.', input_schema: { type: 'object', properties: {} } },
];
const ODOO_DEF: FastPathToolDefinition = {
  name: 'odoo_query',
  description: 'Odoo search_read.',
  input_schema: { type: 'object', properties: { model: { type: 'string' } } },
};
const ALL_DEFS = [PAPIERKRAM_QUERY, ...WRITE_TOOLS, ODOO_DEF, ...NOT_ROWS, DYNAMICS_QUERY];

// ── 1. spec derivation ────────────────────────────────────────────────────

describe('generic tool specs — derivation', () => {
  it('only row tools by name, catalog tools excluded, name-ordered, marked generic', () => {
    const specs = genericToolSpecs(ALL_DEFS);
    assert.deepEqual(
      specs.map((s) => s.name),
      ['dynamics_query', 'papierkram_query'],
    );
    for (const s of specs) {
      assert.equal(s.generic, true);
      assert.ok(s.spec.startsWith(`${s.name} ${GENERIC_MARKER} — `), s.spec);
      assert.ok(s.spec.length <= GENERIC_SPEC_MAX_CHARS, `${s.name}: ${s.spec.length}`);
    }
  });

  it('renders the input schema: required vs optional, types, arrays, enums', () => {
    const spec = genericToolSpec(PAPIERKRAM_QUERY);
    assert.match(spec, /"endpoint": "income\/invoices"\|"income\/estimates"\|"contact\/companies"\|"projects"/);
    assert.match(spec, /"id"\?: number/);
    assert.match(spec, /"filters"\?: object/);
    const dyn = genericToolSpec(DYNAMICS_QUERY);
    assert.match(dyn, /"entity": string — Plural entity set name/);
    assert.match(dyn, /"select"\?: string\[\]/);
  });

  it('is deterministic: same set in any order → byte-identical specs', () => {
    const a = genericToolSpecs(ALL_DEFS);
    const b = genericToolSpecs([...ALL_DEFS].reverse());
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(genericToolSpecs(ALL_DEFS)));
  });

  it('caps one long spec: drops property hints first, then truncates', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      properties[`property_number_${String(i).padStart(2, '0')}`] = { type: 'string', description: 'A long hint. '.repeat(10) };
    }
    const def: FastPathToolDefinition = {
      name: 'list_everything',
      description: 'Lists everything. '.repeat(40),
      input_schema: { type: 'object', properties },
    };
    const spec = genericToolSpec(def);
    assert.equal(spec.length <= GENERIC_SPEC_MAX_CHARS, true, String(spec.length));
    assert.ok(!spec.includes('A long hint'), 'hints dropped before truncation');
    assert.equal(spec, genericToolSpec(def));
  });

  it('keeps the total within the budget, deterministically', () => {
    const many: FastPathToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({
      ...DYNAMICS_QUERY,
      name: `crm${String(i).padStart(2, '0')}_query`,
    }));
    const specs = genericToolSpecs(many);
    const total = specs.reduce((n, s) => n + s.spec.length, 0);
    assert.ok(total <= GENERIC_SPECS_BUDGET, String(total));
    assert.ok(specs.length > 0 && specs.length < many.length);
    assert.equal(specs[0]?.name, 'crm00_query');
    assert.deepEqual(genericToolSpecs([...many].reverse()), specs);
  });

  it('scrubs emails and long digit runs from plugin text', () => {
    const spec = genericToolSpec({
      name: 'search_contacts',
      description: 'Search contacts. Support: help@example.com, hotline 0800123456.',
      input_schema: { type: 'object', properties: {} },
    });
    assert.ok(!spec.includes('help@example.com'));
    assert.ok(!spec.includes('0800123456'));
  });

  it('excludes names on request and skips duplicate definitions', () => {
    assert.deepEqual(genericToolSpecs([DYNAMICS_QUERY], { exclude: new Set(['dynamics_query']) }), []);
    const dup = genericToolSpecs([DYNAMICS_QUERY, { ...DYNAMICS_QUERY, description: 'other' }]);
    assert.equal(dup.length, 1);
    assert.ok(dup[0]?.spec.includes('Dynamics 365'));
  });
});

// ── 2. planner prompt ─────────────────────────────────────────────────────

const LEARNED: LearnedPlan = {
  id: 'p1',
  tool: 'dynamics_query',
  inputTemplate: { entity: 'accounts', filter: '{{text_1}}' },
  map: { name: 'name' },
  examples: ['firmen in {{text_1}}'],
  successes: 2,
  failures: 0,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsed: '2026-01-01T00:00:00.000Z',
};

describe('generic tool specs — planner prompt', () => {
  const catalog = plannableTools(['odoo_query']);
  const generic = genericToolSpecs(ALL_DEFS);

  it('catalog-only prompt is unchanged (no generic rule)', () => {
    const system = buildPlannerSystem({ tools: catalog });
    assert.equal(system, `${PLANNER_SYSTEM}\nTOOLS:\n- ${catalog[0]?.spec ?? ''}`);
    assert.ok(!system.includes(GENERIC_TOOLS_RULE));
  });

  it('a generic tool brings its spec and the generic rule once; examples stay last', () => {
    const system = buildPlannerSystem({ tools: [...catalog, ...generic], examples: [LEARNED] });
    assert.ok(system.includes(`- ${generic[0]?.spec ?? ''}`));
    assert.equal(system.split(GENERIC_TOOLS_RULE).length, 2);
    assert.ok(system.indexOf(GENERIC_TOOLS_RULE) < system.indexOf('VALIDATED EXAMPLES'));
    // rules + tools are a stable prefix of every turn's prompt
    assert.ok(system.startsWith(buildPlannerSystem({ tools: [...catalog, ...generic] })));
  });
});

// ── 3. itemsPath ──────────────────────────────────────────────────────────

describe('generic tool specs — itemsPath is required and checked', () => {
  const tools: FastPathToolSpec[] = genericToolSpecs([DYNAMICS_QUERY]);
  const allowed = new Set(['dynamics_query']);
  const plan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    tool: 'dynamics_query',
    input: { entity: 'accounts', select: ['name', 'address1_city'] },
    map: { name: 'name', city: 'address1_city' },
    summary: '{count} Firmen.',
    locale: 'de-DE',
    ...over,
  });

  it('a generic plan without itemsPath is refused', () => {
    const out = parsePlan(plan(), { allowedTools: allowed, itemsPathRequired: itemsPathRequired(tools) });
    assert.deepEqual(out, { ok: false, reason: 'missing-items-path' });
  });

  it('with itemsPath it is accepted', () => {
    const out = parsePlan(plan({ itemsPath: 'value' }), {
      allowedTools: allowed,
      itemsPathRequired: itemsPathRequired(tools),
    });
    assert.equal(out.ok, true);
  });

  it('exempt when a learned example of the tool was verified without one', () => {
    assert.equal(itemsPathRequired(tools, [LEARNED]).has('dynamics_query'), false);
    assert.equal(itemsPathRequired(tools, [{ ...LEARNED, itemsPath: 'value' }]).has('dynamics_query'), true);
    // catalog and learned-only specs are never affected
    assert.equal(itemsPathRequired(plannableTools(['odoo_query'])).size, 0);
  });

  it('fetchRecipeRows refuses an itemsPath that is not an array (→ agent)', async () => {
    const out = JSON.stringify({ value: { name: 'not a list' }, records: [{ name: 'A' }] });
    const res = await fetchRecipeRows(() => Promise.resolve(out), {
      tool: 'dynamics_query',
      input: {},
      map: { name: 'name' },
      itemsPath: 'value',
    });
    assert.deepEqual(res, { ok: false, reason: 'unmappable' });
    const missing = await fetchRecipeRows(() => Promise.resolve(out), {
      tool: 'dynamics_query',
      input: {},
      map: { name: 'name' },
      itemsPath: 'data.items',
    });
    assert.deepEqual(missing, { ok: false, reason: 'unmappable' });
  });
});

// ── 4. router ─────────────────────────────────────────────────────────────

describe('generic tool specs — router', () => {
  it('lists a generic tool with the first sentence of its description', () => {
    const generic = genericToolSpecs([DYNAMICS_QUERY]);
    const system = buildRouterSystem({ tools: [...plannableTools(['odoo_query']), ...generic] });
    assert.ok(system.includes('- dynamics_query: Read records from Microsoft Dynamics 365 (Dataverse) via OData.'), system);
    assert.equal(toolPurpose(generic[0] as FastPathToolSpec).length <= 160, true);
  });
});

// ── 5. service ────────────────────────────────────────────────────────────

const ACCOUNTS = { '@odata.context': 'x', value: [{ name: 'Acme GmbH', address1_city: 'Berlin' }, { name: 'Beta AG', address1_city: 'Berlin' }] };

function harness(reply: Record<string, unknown>) {
  const forced: ForcedCall[] = [];
  const invokes: string[] = [];
  const logs: string[] = [];
  const service = createFastPathService({
    config: { get: () => undefined },
    llm: withRouterPlanner(
      { complete: () => Promise.resolve({ text: '' }) },
      { text: () => JSON.stringify(reply), forced },
    ),
    model: 'class:fast',
    invoke: (name) => {
      invokes.push(name);
      return Promise.resolve(JSON.stringify(ACCOUNTS));
    },
    privacyGuard: () => undefined,
    privacyForced: () => false,
    log: (m) => logs.push(m),
    plans: createLearnedPlanStore({ log: () => {} }),
  });
  const triage = (over: Partial<ChatTriageRequest> = {}) =>
    service.triageChatTurn({
      channel: 'web',
      userMessage: 'Welche Firmen sitzen in Berlin?',
      permittedTools: new Set(ALL_DEFS.map((d) => d.name)),
      toolDefinitions: ALL_DEFS,
      ...over,
    });
  return { service, triage, forced, invokes, logs };
}

const DYN_PLAN = {
  decision: 'deterministic',
  fetch: {
    tool: 'dynamics_query',
    input: { entity: 'accounts', select: ['name', 'address1_city'], filter: "address1_city eq 'Berlin'" },
    map: { name: 'name', city: 'address1_city' },
    itemsPath: 'value',
  },
  labels: { name: 'Firma', city: 'Ort' },
  summary: '{count} Firmen in Berlin.',
  locale: 'de-DE',
};

describe('generic tool specs — chat triage service', () => {
  it('plans and runs a generic read tool → hit', async () => {
    const h = harness(DYN_PLAN);
    const out = await h.triage();
    assert.equal(out.kind, 'answer', h.logs.join('\n'));
    if (out.kind !== 'answer') return;
    assert.equal(out.tool, 'dynamics_query');
    assert.equal(out.rows, 2);
    assert.deepEqual(h.invokes, ['dynamics_query']);
    const planner = h.forced.find((c) => c.tool === 'plan_query');
    const router = h.forced.find((c) => c.tool === 'route_turn');
    assert.ok(planner?.system.includes('dynamics_query [generic]'));
    assert.ok(planner?.system.includes('papierkram_query [generic]'));
    assert.ok(router?.system.includes('- dynamics_query: Read records from Microsoft Dynamics 365'));
  });

  it('never offers a write tool, a describe tool or a non-permitted tool', async () => {
    const h = harness(DYN_PLAN);
    await h.triage({ permittedTools: new Set(['odoo_query', 'dynamics_query', ...WRITE_TOOLS.map((d) => d.name)]) });
    for (const call of h.forced) {
      for (const name of [...WRITE_TOOLS, ...NOT_ROWS, PAPIERKRAM_QUERY].map((d) => d.name)) {
        assert.ok(!call.system.includes(`${name} ${GENERIC_MARKER}`), `${call.tool} offers ${name}`);
        assert.ok(!call.system.includes(`- ${name}:`), `${call.tool} routes ${name}`);
      }
    }
  });

  it('a generic plan without itemsPath falls back to the agent', async () => {
    const { itemsPath: _drop, ...fetch } = DYN_PLAN.fetch;
    const h = harness({ ...DYN_PLAN, fetch });
    const out = await h.triage();
    assert.equal(out.kind, 'agent');
    if (out.kind === 'agent') assert.equal(out.reason, 'planner-invalid:missing-items-path');
    assert.deepEqual(h.invokes, []);
  });

  it('a wrong itemsPath is refused at execution → agent', async () => {
    const h = harness({ ...DYN_PLAN, fetch: { ...DYN_PLAN.fetch, itemsPath: '@odata.context' } });
    const out = await h.triage();
    assert.equal(out.kind, 'agent');
    if (out.kind === 'agent') assert.equal(out.reason, 'unmappable');
  });

  it('without definitions only catalog tools are offered (unchanged behaviour)', async () => {
    const h = harness(DYN_PLAN);
    const out = await h.triage({ toolDefinitions: undefined });
    assert.equal(out.kind, 'agent');
    const planner = h.forced.find((c) => c.tool === 'plan_query');
    assert.ok(!planner?.system.includes(GENERIC_MARKER));
  });

  it('plannableTools(definitions) puts generic tools into the canvas fetch whitelist', () => {
    const h = harness(DYN_PLAN);
    assert.equal(h.service.allowedFetchTools().has('dynamics_query'), false);
    const specs = h.service.plannableTools(ALL_DEFS);
    assert.deepEqual(
      specs.map((s) => s.name),
      ['odoo_query', 'dynamics_query', 'papierkram_query'],
    );
    assert.equal(h.service.allowedFetchTools().has('dynamics_query'), true);
    assert.equal(h.service.allowedFetchTools().has('dynamics_write'), false);
    assert.deepEqual(h.service.plannableTools().map((s) => s.name), ['odoo_query']);
  });
});

// ── 6. orchestrator wiring ────────────────────────────────────────────────

interface Entry {
  name: string;
  spec: { name: string; description: string; input_schema: Record<string, unknown> };
  handler: () => Promise<string>;
  agentId?: string;
  writeCapabilities?: readonly unknown[];
}
const entry = (def: FastPathToolDefinition, over: Partial<Entry> = {}): Entry => ({
  name: def.name,
  spec: { name: def.name, description: def.description ?? '', input_schema: def.input_schema as Record<string, unknown> },
  handler: () => Promise.resolve('{}'),
  agentId: '@omadia/test-plugin',
  ...over,
});

function orchestratorDeps(fastPath: () => FastPathTriagePort, nativeEntries: readonly Entry[]): OrchestratorDeps {
  const names = new Set<string>();
  return {
    provider: { id: 'fake', complete: () => Promise.reject(new Error('no network')) } as unknown as OrchestratorDeps['provider'],
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: {
      get: (n: string) => nativeEntries.find((e) => e.name === n),
      listWithHandler: () => nativeEntries,
      has: (n: string) => names.has(n),
      register: (n: string) => {
        names.add(n);
        return () => names.delete(n);
      },
    } as unknown as NativeToolRegistry,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    fastPath,
  };
}

const AGENT_ROW: AgentRow = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'crm',
  name: 'crm',
  description: null,
  privacyProfile: 'default',
  status: 'enabled',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const RUNTIME = {
  model: 'm',
  maxTokens: 100,
  maxToolIterations: 4,
  modelRouting: { classifierModel: 'haiku', simpleModel: 'sonnet', complexModel: 'opus' },
};

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('generic tool specs — orchestrator wiring', () => {
  it("the triage gets the Agent's plugin tool definitions (no kernel, no write-capable tools)", async () => {
    const seen: ChatTriageRequest[] = [];
    const port: FastPathTriagePort = {
      channelEnabled: () => true,
      triageChatTurn: (req) => {
        seen.push(req);
        return Promise.resolve({ kind: 'agent', reason: 'test', ms: 0, route: 'simple' });
      },
    };
    const entries = [
      entry(PAPIERKRAM_QUERY),
      entry(DYNAMICS_QUERY),
      entry({ name: 'list_secrets', description: 'kernel', input_schema: { type: 'object', properties: {} } }, { agentId: undefined }),
      entry({ name: 'get_orders', description: 'w', input_schema: { type: 'object', properties: {} } }, {
        writeCapabilities: [{ kind: 'mutate' }],
      }),
    ];
    const built = buildForAgent(AGENT_ROW, orchestratorDeps(() => port, entries), RUNTIME);
    const defs = built.bundle.agent.offeredToolDefinitions?.() ?? [];
    assert.deepEqual(
      defs.map((d) => d.name),
      ['dynamics_query', 'papierkram_query'],
    );
    assert.equal(defs[0]?.description, DYNAMICS_QUERY.description);
    // the turn itself may fail downstream (no provider) — only the triage request matters
    await collect(built.bundle.agent.chatStream({ userMessage: 'Firmen in Berlin?', sessionScope: 'tab_1' })).catch(() => []);
    assert.deepEqual(
      seen[0]?.toolDefinitions?.map((d) => d.name),
      ['dynamics_query', 'papierkram_query'],
    );
    assert.ok(seen[0]?.permittedTools.has('list_secrets'), 'names stay the full offered set');
  });
});

// ── 7. canvas ─────────────────────────────────────────────────────────────

const ACCOUNTS_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'h', content: 'Firmen in Berlin', level: 2 },
    {
      type: 'table',
      id: 'accounts',
      loading: 'skeleton',
      columns: [
        { fieldKey: 'name', label: 'Firma' },
        { fieldKey: 'city', label: 'Ort' },
      ],
      rows: [],
    },
  ],
};
const CANVAS_COMPOSER = JSON.stringify({
  tree: ACCOUNTS_TREE,
  dataRequirements: [
    {
      containerId: 'accounts',
      description: 'Firmen in Berlin',
      fields: [
        { fieldKey: 'name', label: 'Firma' },
        { fieldKey: 'city', label: 'Ort' },
      ],
      fetch: DYN_PLAN.fetch,
    },
  ],
  summary: '{count} Firmen in Berlin.',
  locale: 'de-DE',
});

async function canvasTurn(withDefinitions: boolean): Promise<{ invokes: string[]; baseCalls: number; logs: string[] }> {
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const invokes: string[] = [];
  let baseCalls = 0;
  const ctx = {
    log: (m: string) => logs.push(m),
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: withRouterPlanner({ complete: () => Promise.resolve({ text: CANVAS_COMPOSER }) }),
    config: { get: () => undefined },
    tools: {
      register: () => () => {},
      invoke: (name: string): Promise<string> => {
        invokes.push(name);
        return Promise.resolve(JSON.stringify(ACCOUNTS));
      },
    },
  } as unknown as PluginContext;
  reg.set(CHAT_AGENT_SERVICE, {
    agent: {
      offeredToolNames: () => new Set(['odoo_query', 'dynamics_query']),
      ...(withDefinitions ? { offeredToolDefinitions: () => [DYNAMICS_QUERY as never] } : {}),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream() {
        baseCalls += 1;
        await Promise.resolve();
        yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
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
    }),
  );
  await activateCanvas(ctx);
  const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  await collect(agent.chatStream({ userMessage: 'Welche Firmen sitzen in Berlin?', canvasSessionId: 'cs-gen' } as ChatTurnInput));
  return { invokes, baseCalls, logs };
}

describe('generic tool specs — canvas', () => {
  it("the base agent's definition makes a generic tool fill the canvas table", async () => {
    const out = await canvasTurn(true);
    assert.deepEqual(out.invokes, ['dynamics_query'], out.logs.join('\n'));
    assert.equal(out.baseCalls, 0, out.logs.join('\n'));
  });

  it('without definitions the generic tool is not plannable → base agent', async () => {
    const out = await canvasTurn(false);
    assert.deepEqual(out.invokes, []);
    assert.equal(out.baseCalls, 1);
  });
});
