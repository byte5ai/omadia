/**
 * Fast-path follow-ups (after v415):
 *   1. catalog labels for res.partner money fields (live header "Credit")
 *      and for `id` everywhere ("ID", never "Id");
 *   2. learned plans carry `sort` / `take` — a ranking is learned instead of
 *      skipped (`reason=sorted-recipe`); old plans.json entries still load
 *      with their ids unchanged;
 *   3. `fast_path_variant_actions` is a declared setup field, default ON,
 *      false/off still turns it off;
 *   4. `fast_path_generic_tools` — the operator opt-out for #1607's generic
 *      plugin read tools (default on).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parse as parseYaml } from 'yaml';

import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext, PrivacyStoredTextScope } from '../packages/plugin-api/src/index.js';
import { catalogColumnLabel } from '../packages/harness-plugin-fast-path/src/fieldLabels.js';
import {
  FAST_PATH_TOOL_SPECS,
  parseBooleanSetting,
  renderSummary,
} from '../packages/harness-plugin-fast-path/src/fastPath.js';
import {
  attributePlan,
  createLearnedPlanStore,
  planId,
  planToFetch,
  PLANS_PATH,
  type PlanCandidate,
  type PlanMemory,
} from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { createTurnLearner } from '../packages/harness-plugin-fast-path/src/learningCapture.js';
import { templateShape } from '../packages/harness-plugin-fast-path/src/literalStripping.js';
import { buildPlannerSystem } from '../packages/harness-plugin-fast-path/src/planner.js';
import { createFastPathService } from '../packages/harness-plugin-fast-path/src/service.js';
import { createCanvasRuntime } from '../packages/omadia-ui-orchestrator/src/canvasRuntime.js';
import { createProvenanceStash } from '../packages/omadia-ui-orchestrator/src/datasetRecipe.js';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

// ── 1. catalog labels ─────────────────────────────────────────────────────

describe('catalog labels — res.partner money fields and id', () => {
  const label = (attr: string, lang: 'de' | 'en', model: string | undefined = 'res.partner'): string =>
    catalogColumnLabel({ fieldKey: attr, attr, model, lang });

  it('labels credit / debit / total_due / total_overdue in German and English', () => {
    assert.equal(label('credit', 'de'), 'Offener Betrag (Forderungen)');
    assert.equal(label('credit', 'en'), 'Receivable');
    assert.equal(label('debit', 'de'), 'Verbindlichkeiten');
    assert.equal(label('debit', 'en'), 'Payable');
    assert.equal(label('total_due', 'de'), 'Fällig gesamt');
    assert.equal(label('total_overdue', 'en'), 'Total overdue');
  });

  it('labels id as "ID" for a catalog model, another model and no model', () => {
    assert.equal(label('id', 'de'), 'ID');
    assert.equal(label('id', 'en', 'hr.employee'), 'ID');
    assert.equal(label('id', 'de', 'crm.lead'), 'ID');
    assert.equal(label('id', 'en', undefined), 'ID');
    assert.equal(catalogColumnLabel({ fieldKey: 'id', attr: undefined, model: undefined, lang: 'de' }), 'ID');
    // other unknown keys stay humanised
    assert.equal(label('x_custom', 'de', 'crm.lead'), 'X custom');
  });

  it('the planner catalog offers credit / debit on res.partner', () => {
    const spec = FAST_PATH_TOOL_SPECS['odoo_query'] ?? '';
    assert.match(spec, /res\.partner:[^\n]*credit \(open receivable/);
    assert.match(spec, /res\.partner:[^\n]*debit \(open payable/);
  });

  it('a total over total_due is money — mixed currencies print no total', () => {
    const rows = [{ due: 10 }, { due: 5 }];
    const out = renderSummary('{count} Partner, fällig {sum:due}', {
      rows,
      records: [
        { total_due: 10, currency_id: [1, 'EUR'] },
        { total_due: 5, currency_id: [2, 'USD'] },
      ],
      map: { due: 'total_due' },
      locale: 'de-DE',
    });
    assert.equal(out.ok, false);
  });
});

// ── 2. learned plans with sort / take ─────────────────────────────────────

function memoryFake(initial?: string): PlanMemory & { files: Map<string, string> } {
  const files = new Map<string, string>(initial !== undefined ? [[PLANS_PATH, initial]] : []);
  return {
    files,
    readFile: (p) => Promise.resolve(files.get(p) ?? ''),
    writeFile: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
  };
}

const TOP_CUSTOMERS: PlanCandidate = {
  tool: 'odoo_query',
  inputTemplate: {
    model: 'res.partner',
    domain: [['customer_rank', '>', 0]],
    fields: ['name', 'credit', 'currency_id'],
    limit: 100,
    order: 'credit desc',
  },
  map: { name: 'name', receivable: 'credit' },
  rowKey: 'id',
  itemsPath: 'records',
  sort: [{ field: 'credit', dir: 'desc' }],
  take: 5,
  example: 'die 5 kunden mit den höchsten forderungen',
};

const PLAIN: PlanCandidate = {
  tool: 'odoo_query',
  inputTemplate: { model: 'res.partner', domain: [['customer_rank', '>', 0]], fields: ['name'], limit: 100 },
  map: { name: 'name' },
  rowKey: 'id',
  itemsPath: 'records',
  example: 'alle kunden',
};

/** The id formula of the releases before sort/take (frozen here). */
function legacyPlanId(p: PlanCandidate): string {
  const sortedMap = Object.fromEntries(Object.entries(p.map).sort(([a], [b]) => a.localeCompare(b)));
  const shape = JSON.stringify([
    p.tool,
    templateShape(p.inputTemplate),
    sortedMap,
    null,
    p.itemsPath ?? null,
    p.rowKey ?? null,
  ]);
  return createHash('sha256').update(shape).digest('hex').slice(0, 12);
}

describe('learned plans — sort / take', () => {
  it('a plan without sort/take keeps the id older releases stored', () => {
    assert.equal(planId(PLAIN), legacyPlanId(PLAIN));
  });

  it('take is the user N (not structure); sort and ranked-or-not are', () => {
    assert.equal(planId(TOP_CUSTOMERS), planId({ ...TOP_CUSTOMERS, take: 10 }));
    assert.notEqual(planId(TOP_CUSTOMERS), planId({ ...TOP_CUSTOMERS, sort: [{ field: 'credit', dir: 'asc' }] }));
    const { sort: _s, take: _t, ...unranked } = TOP_CUSTOMERS;
    assert.notEqual(planId(TOP_CUSTOMERS), planId(unranked));
    const { take: _t2, ...sortedOnly } = TOP_CUSTOMERS;
    assert.notEqual(planId(TOP_CUSTOMERS), planId(sortedOnly));
  });

  it('round-trips sort/take through the persisted store; planToFetch emits them', async () => {
    const memory = memoryFake();
    const store = createLearnedPlanStore({ memory, log: () => undefined });
    await store.load();
    await store.recordSuccess(TOP_CUSTOMERS);
    const { plan, activated } = await store.recordSuccess({ ...TOP_CUSTOMERS, take: 3 });
    assert.equal(activated, true);
    assert.equal(plan.take, 3, 'the latest success carries the N');

    const doc = JSON.parse(memory.files.get(PLANS_PATH) ?? '{}') as { plans: Array<Record<string, unknown>> };
    assert.deepEqual(doc.plans[0]?.['sort'], [{ field: 'credit', dir: 'desc' }]);
    assert.equal(doc.plans[0]?.['take'], 3);

    const reloaded = createLearnedPlanStore({ memory: memoryFake(memory.files.get(PLANS_PATH)), log: () => undefined });
    await reloaded.load();
    const back = reloaded.get(plan.id);
    assert.ok(back?.active);
    assert.deepEqual(back?.sort, [{ field: 'credit', dir: 'desc' }]);
    assert.equal(back?.take, 3);
    const fetch = planToFetch(back!);
    assert.deepEqual(fetch.sort, [{ field: 'credit', dir: 'desc' }]);
    assert.equal(fetch.take, 3);
    // a fetch adapted to another N is attributed to the same plan
    assert.equal(attributePlan(reloaded, { ...fetch, take: 7 })?.id, plan.id);
  });

  it('loads an old-format entry (no sort/take) unchanged', async () => {
    const id = legacyPlanId(PLAIN);
    const old = JSON.stringify({
      schemaVersion: 1,
      plans: [
        {
          id,
          tool: PLAIN.tool,
          inputTemplate: PLAIN.inputTemplate,
          map: PLAIN.map,
          rowKey: PLAIN.rowKey,
          itemsPath: PLAIN.itemsPath,
          examples: ['alle kunden'],
          successes: 2,
          failures: 0,
          active: true,
          createdAt: '2026-10-01T00:00:00.000Z',
          lastUsed: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    const store = createLearnedPlanStore({ memory: memoryFake(old), log: () => undefined });
    await store.load();
    const plan = store.get(id);
    assert.ok(plan?.active);
    assert.equal(plan?.sort, undefined);
    assert.equal(plan?.take, undefined);
    const fetch = planToFetch(plan!);
    assert.equal('sort' in fetch, false);
    assert.equal('take' in fetch, false);
    // the next agent success of the same plan books on the stored entry
    const { plan: next } = await store.recordSuccess(PLAIN);
    assert.equal(next.id, id);
    assert.equal(next.successes, 3);
  });

  it('a stored entry with an invalid take is dropped, not replayed uncut', async () => {
    const doc = JSON.stringify({
      schemaVersion: 1,
      plans: [{ id: 'x', tool: 'odoo_query', inputTemplate: {}, map: { name: 'name' }, take: 0, examples: [] }],
    });
    const store = createLearnedPlanStore({ memory: memoryFake(doc), log: () => undefined });
    await store.load();
    assert.equal(store.get('x'), undefined);
  });

  it('the planner sees the learned N in the example (a slot to adapt)', async () => {
    const store = createLearnedPlanStore({ log: () => undefined });
    await store.recordSuccess(TOP_CUSTOMERS);
    const { plan } = await store.recordSuccess(TOP_CUSTOMERS);
    const system = buildPlannerSystem({
      tools: [{ name: 'odoo_query', spec: 'odoo_query — spec' }],
      examples: [plan],
    });
    assert.match(system, /"sort":\[\{"field":"credit","dir":"desc"\}\],"take":5/);
  });
});

/** A stored-text scope that masks nothing but proves C1 runs (canary). */
const openScope = (): PrivacyStoredTextScope =>
  ({
    maskStoredText: (t: string) =>
      Promise.resolve({
        outcome: 'masked',
        maskedText: t,
        spans: t.includes('Anna Schmidt') ? [{ type: 'person' }] : [],
      }),
    restoreStoredText: (t: string) => t,
  }) as unknown as PrivacyStoredTextScope;

async function drain(stream: AsyncIterable<ChatStreamEvent>): Promise<void> {
  for await (const _ev of stream) {
    // consume
  }
}

describe('learning capture — a ranking is learned with sort / take', () => {
  it('records the candidate with sort and take, input literal-stripped', async () => {
    const candidates: PlanCandidate[] = [];
    const store = createLearnedPlanStore({ log: () => undefined });
    const record = store.recordSuccess.bind(store);
    store.recordSuccess = (c) => {
      candidates.push(c);
      return record(c);
    };
    const logs: string[] = [];
    const input = {
      model: 'res.partner',
      domain: [['city', '=', 'Köln']],
      fields: ['name', 'credit'],
      limit: 100,
      order: 'credit desc',
    };
    const learner = createTurnLearner({
      question: 'Die 5 Kunden in Köln mit den höchsten Forderungen',
      requirements: [{ containerId: 'top', fields: [{ fieldKey: 'name' }, { fieldKey: 'receivable' }] }],
      isProducerTool: (n) => n === 'canvas_publish_rows',
      store,
      openStoredTextScope: openScope,
      log: (m) => logs.push(m),
    });
    learner.onPublishedPayload({
      containerId: 'top',
      source: {
        tool: 'odoo_query',
        input,
        map: { name: 'name', receivable: 'credit' },
        itemsPath: 'records',
        rowKey: 'id',
        sort: [{ field: 'credit', dir: 'desc' }],
        take: 5,
      },
    });
    async function* events(): AsyncGenerator<ChatStreamEvent> {
      yield { type: 'tool_use', id: 't1', name: 'odoo_query', input } as ChatStreamEvent;
      yield { type: 'tool_result', id: 't1', output: '{"records":[]}' } as ChatStreamEvent;
      yield { type: 'done', answer: 'ok' } as unknown as ChatStreamEvent;
    }
    await drain(learner.tap(events()));
    assert.ok(!logs.some((l) => l.includes('reason=sorted-recipe')), logs.join('\n'));
    const c = candidates.at(-1);
    assert.ok(c, logs.join('\n'));
    assert.deepEqual(c.sort, [{ field: 'credit', dir: 'desc' }]);
    assert.equal(c.take, 5);
    assert.deepEqual((c.inputTemplate as { domain: unknown }).domain, [['city', '=', '{{text_1}}']]);
    assert.equal((c.inputTemplate as { order: unknown }).order, 'credit desc');
    assert.ok(c.example?.includes('{{text_1}}'), c.example ?? 'no example stored');
    assert.ok(c.example?.includes('5'), 'the N stays in the example');
  });
});

// ── 3. fast_path_variant_actions ──────────────────────────────────────────

function runtimeWith(value: unknown): boolean {
  const ctx = {
    log: () => undefined,
    services: { get: () => undefined },
    config: { get: <T>(key: string): T | undefined => (key === 'fast_path_variant_actions' ? (value as T) : undefined) },
  } as unknown as PluginContext;
  const none = { has: () => false };
  return createCanvasRuntime(ctx, {
    model: 'class:fast',
    toolsAccessor: undefined,
    canvasOutputTools: none,
    deterministicActionTools: none,
    publishProvenance: createProvenanceStash(),
  }).derivedVariantsEnabled;
}

describe('fast_path_variant_actions — declared, default on', () => {
  it('is on when unset; false/off/"0" turn it off; true/on keep it on', () => {
    assert.equal(runtimeWith(undefined), true);
    assert.equal(runtimeWith(''), true);
    for (const off of [false, 'false', 'off', '0', 'OFF']) assert.equal(runtimeWith(off), false, String(off));
    for (const on of [true, 'true', 'on', '1']) assert.equal(runtimeWith(on), true, String(on));
  });

  it('the ui-orchestrator manifest declares it as a boolean, default true, en+de', async () => {
    const entry = await loadManifestFromPath(
      fileURLToPath(new URL('../packages/omadia-ui-orchestrator/manifest.yaml', import.meta.url)),
    );
    const field = entry?.plugin.setup_fields.find((f) => f.key === 'fast_path_variant_actions');
    assert.equal(field?.type, 'boolean');
    assert.equal(field?.default, true);
    const raw = parseYaml(
      readFileSync(new URL('../packages/omadia-ui-orchestrator/manifest.yaml', import.meta.url), 'utf8'),
    ) as { setup: { fields: Array<{ key: string; label: Record<string, string>; help: Record<string, string> }> } };
    const yamlField = raw.setup.fields.find((f) => f.key === 'fast_path_variant_actions');
    assert.ok(yamlField?.label['en'] && yamlField.label['de']);
    assert.ok(yamlField?.help['en'] && yamlField.help['de']);
  });
});

describe('parseBooleanSetting', () => {
  it('booleans pass, known strings map, everything else falls back', () => {
    assert.equal(parseBooleanSetting(false, true), false);
    assert.equal(parseBooleanSetting(true, false), true);
    assert.equal(parseBooleanSetting(' Yes ', false), true);
    assert.equal(parseBooleanSetting('no', true), false);
    assert.equal(parseBooleanSetting('maybe', true), true);
    assert.equal(parseBooleanSetting(undefined, false), false);
    assert.equal(parseBooleanSetting(1, true), true);
  });
});

// ── 4. fast_path_generic_tools ────────────────────────────────────────────

const DEFS = [
  {
    name: 'dynamics_query',
    description: 'Read records from Microsoft Dynamics 365.',
    input_schema: { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] },
  },
  { name: 'odoo_query', description: 'Odoo read.', input_schema: { type: 'object' } },
];

function serviceWith(generic: unknown): ReturnType<typeof createFastPathService> {
  return createFastPathService({
    config: {
      get: <T>(key: string): T | undefined => (key === 'fast_path_generic_tools' ? (generic as T) : undefined),
    },
    model: 'class:fast',
    privacyGuard: () => undefined,
    privacyForced: () => false,
    log: () => undefined,
    plans: createLearnedPlanStore({ log: () => undefined }),
  });
}

describe('fast_path_generic_tools — operator opt-out for generic plugin read tools', () => {
  it('default on: a generic spec is built and the tool becomes fetchable', () => {
    const svc = serviceWith(undefined);
    assert.equal(svc.genericToolsEnabled, true);
    assert.deepEqual(svc.plannableTools(DEFS).map((t) => t.name), ['odoo_query', 'dynamics_query']);
    assert.equal(svc.allowedFetchTools().has('dynamics_query'), true);
  });

  it('off: only catalog (+ learned) tools — no generic spec, not fetchable', async () => {
    for (const off of [false, 'false', 'off']) {
      const svc = serviceWith(off);
      assert.equal(svc.genericToolsEnabled, false);
      assert.deepEqual(svc.plannableTools(DEFS).map((t) => t.name), ['odoo_query'], String(off));
      assert.equal(svc.allowedFetchTools().has('dynamics_query'), false);
    }
    // a learned plan of a non-catalog tool still counts
    const svc = serviceWith(false);
    const learned: PlanCandidate = {
      tool: 'dynamics_query',
      inputTemplate: { entity: 'accounts' },
      map: { name: 'name' },
      itemsPath: 'value',
      example: 'accounts',
    };
    await svc.plans.recordSuccess(learned);
    await svc.plans.recordSuccess(learned);
    assert.equal(svc.allowedFetchTools().has('dynamics_query'), true);
  });

  it('the chat triage offers no generic tool when off', async () => {
    const systems: string[] = [];
    const svc = createFastPathService({
      config: { get: <T>(key: string): T | undefined => (key === 'fast_path_generic_tools' ? (false as T) : undefined) },
      model: 'class:fast',
      llm: {
        complete: (req) => {
          systems.push(req.system ?? '');
          return Promise.resolve({ text: '' });
        },
      },
      invoke: () => Promise.resolve('{}'),
      privacyGuard: () => undefined,
      privacyForced: () => false,
      log: () => undefined,
      plans: createLearnedPlanStore({ log: () => undefined }),
    });
    const out = await svc.triageChatTurn({
      channel: 'web',
      userMessage: 'Alle Accounts aus Dynamics',
      permittedTools: new Set(['dynamics_query']),
      toolDefinitions: DEFS,
    });
    assert.equal(out.kind, 'agent');
    if (out.kind === 'agent') assert.equal(out.reason, 'no-tools');
    assert.equal(systems.length, 0, 'no model call without a plannable tool');
  });

  it('the fast-path manifest declares it as a boolean, default true, en+de', async () => {
    const entry = await loadManifestFromPath(
      fileURLToPath(new URL('../packages/harness-plugin-fast-path/manifest.yaml', import.meta.url)),
    );
    const field = entry?.plugin.setup_fields.find((f) => f.key === 'fast_path_generic_tools');
    assert.equal(field?.type, 'boolean');
    assert.equal(field?.default, true);
  });
});
