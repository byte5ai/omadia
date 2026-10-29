/**
 * Derived refresh recipes for AGENT-filled canvas tables.
 *
 * A table the agent fills with `canvas_publish_rows({ datasetId })` used to
 * carry no recipe — "Details anzeigen" missed with `no-recipe`, refresh fell
 * back to the agent and learning skipped with `no-map`. The Privacy Shield's
 * dataset provenance names the tool call behind the dataset; when it is ONE
 * learnable read tool and the verb chain is expressible as a RefreshSource
 * (none, select → map, eq-filter → filter), the orchestrator derives the
 * recipe, persists it like a fast-path one and feeds the same candidate into
 * learning. Anything else is skipped with a logged reason.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { turnContext } from '@omadia/orchestrator';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyDatasetProvenance,
} from '../packages/plugin-api/src/index.js';
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import {
  createLearnedPlanStore,
  type PlanCandidate,
} from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { PERSON_CANARY } from '../packages/harness-plugin-fast-path/src/exampleMasking.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { deriveDatasetRecipe } from '../packages/omadia-ui-orchestrator/src/datasetRecipe.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const QUERY = {
  model: 'hr.employee',
  domain: [['active', '=', true]],
  fields: ['name', 'birthday'],
  limit: 100,
};
const RECORDS = [
  { id: 1, name: 'Marvin Vomberg', birthday: '1990-11-03' },
  { id: 2, name: 'Anna Rüsche', birthday: '1985-04-12' },
];
const COLUMNS = [
  { path: 'id', type: 'number' },
  { path: 'name', type: 'string' },
  { path: 'birthday', type: 'string' },
];
const prov = (over: Partial<PrivacyDatasetProvenance> = {}): PrivacyDatasetProvenance => ({
  tool: 'odoo_query',
  input: QUERY,
  verbs: [],
  truncated: false,
  ...over,
});

describe('deriveDatasetRecipe — pure', () => {
  const paths = ['id', 'name', 'birthday'];

  it('no verbs → identity map over the published column paths, rowKey id', () => {
    const r = deriveDatasetRecipe(prov(), paths);
    assert.deepEqual(r, {
      ok: true,
      source: {
        tool: 'odoo_query',
        input: QUERY,
        map: { id: 'id', name: 'name', birthday: 'birthday' },
        rowKey: 'id',
      },
    });
  });

  it('select narrows to the published columns; no id column → no rowKey', () => {
    const r = deriveDatasetRecipe(prov({ verbs: [{ verb: 'select', args: { columns: ['name'] } }] }), ['name']);
    assert.ok(r.ok);
    assert.deepEqual(r.source.map, { name: 'name' });
    assert.equal(r.source.rowKey, undefined);
  });

  it('eq / and-of-eq filters become RefreshSource.filter clauses', () => {
    const r = deriveDatasetRecipe(
      prov({
        verbs: [
          {
            verb: 'filter',
            args: {
              predicate: {
                op: 'and',
                clauses: [
                  { op: 'eq', field: 'name', value: 'Anna' },
                  { op: 'eq', field: 'id', value: 2 },
                ],
              },
            },
          },
        ],
      }),
      paths,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.source.filter, [
      { field: 'name', eq: 'Anna' },
      { field: 'id', eq: 2 },
    ]);
  });

  it('skips what a RefreshSource cannot express', () => {
    const reason = (p: PrivacyDatasetProvenance, cols = paths): string => {
      const r = deriveDatasetRecipe(p, cols);
      return r.ok ? 'ok' : r.reason;
    };
    assert.equal(reason(prov({ tool: 'odoo_write' })), 'tool-not-learnable');
    assert.equal(reason(prov({ tool: 'odoo_describe_model' })), 'tool-not-learnable');
    assert.equal(reason(prov({ verbs: [{ verb: 'sort', args: { by: 'name' } }] })), 'verb-sort');
    assert.equal(reason(prov({ verbs: [{ verb: 'join', args: {} }] })), 'verb-join');
    assert.equal(
      reason(prov({ verbs: [{ verb: 'filter', args: { predicate: { op: 'gt', field: 'id', value: 1 } } }] })),
      'filter-unsupported',
    );
    assert.equal(
      reason(prov({ verbs: [{ verb: 'filter', args: { predicate: { op: 'or', clauses: [] } } }] })),
      'filter-unsupported',
    );
    assert.equal(reason(prov(), []), 'no-columns');
    assert.equal(reason(prov({ input: 'not-an-object' })), 'input-not-object');
  });
});

// ── integration: agent publish → derived recipe → refresh / details / learning ──

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  invokes: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
  candidates: PlanCandidate[];
  s: { provenance: PrivacyDatasetProvenance | undefined };
}

const composer = JSON.stringify({
  tree: {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      {
        type: 'table',
        id: 'employees',
        loading: 'skeleton',
        columns: [
          { fieldKey: 'employee', label: 'Mitarbeiter' },
          { fieldKey: 'born', label: 'Geburtstag' },
        ],
        rows: [],
      },
    ],
  },
  dataRequirements: [
    {
      containerId: 'employees',
      description: 'Mitarbeiter',
      fields: [
        { fieldKey: 'employee', label: 'Mitarbeiter' },
        { fieldKey: 'born', label: 'Geburtstag' },
      ],
    },
  ],
});

async function harness(): Promise<Harness> {
  const reg = new Map<string, unknown>();
  const handlers = new Map<string, (input: unknown) => Promise<string>>();
  const logs: string[] = [];
  const invokes: Harness['invokes'] = [];
  const baseInputs: ChatTurnInput[] = [];
  const candidates: PlanCandidate[] = [];
  const s: Harness['s'] = { provenance: prov() };
  const ctx = {
    log: (m: string) => logs.push(m),
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: { complete: () => Promise.resolve({ text: composer }) },
    config: { get: <T>(): T | undefined => undefined },
    tools: {
      register: (spec: { name: string }, handler: (input: unknown) => Promise<string>) => {
        handlers.set(spec.name, handler);
        return () => handlers.delete(spec.name);
      },
      invoke: (name: string, input: unknown): Promise<string> => {
        invokes.push({ name, input });
        return Promise.resolve(JSON.stringify({ model: 'hr.employee', count: 2, truncated: false, records: RECORDS }));
      },
    },
  } as unknown as PluginContext;
  const plans = createLearnedPlanStore({ log: () => undefined });
  const recordSuccess = plans.recordSuccess.bind(plans);
  plans.recordSuccess = (c) => {
    candidates.push(c);
    return recordSuccess(c);
  };
  reg.set(
    FAST_PATH_SERVICE,
    createFastPathService({
      config: ctx.config,
      model: 'class:fast',
      privacyGuard: () => undefined,
      privacyForced: () => false,
      log: (m) => logs.push(m),
      plans,
    }),
  );
  // a Privacy Shield stub: the dataset ds_emp (interned this turn) + its provenance
  reg.set(PRIVACY_REDACT_SERVICE_NAME, {
    resolveDatasetForRender: (turnId: string, id: string) =>
      turnId === 'T1' && id === 'ds_emp' ? { rowCount: RECORDS.length, columns: COLUMNS, rows: RECORDS } : undefined,
    datasetProvenance: (turnId: string, id: string) =>
      turnId === 'T1' && id === 'ds_emp' ? s.provenance : undefined,
    openStoredTextScope: () => ({
      // a person-aware masker: the canary has persons, the question none
      maskStoredText: (t: string) =>
        Promise.resolve({
          outcome: 'masked',
          maskedText: t,
          spans: t === PERSON_CANARY ? [{ type: 'person' }] : [],
        }),
      restoreStoredText: (t: string) => t,
    }),
  });
  reg.set(CHAT_AGENT_SERVICE, {
    sessionLogger: { log: () => Promise.resolve({ turnExternalId: 'turn:x' }) },
    agent: {
      offeredToolNames: () => new Set(['odoo_query']),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        yield { type: 'tool_use', id: 'c1', name: 'odoo_query', input: QUERY } as ChatStreamEvent;
        yield { type: 'tool_result', id: 'c1', output: '[privacy-shield-v4] {"datasetId":"ds_emp"}', durationMs: 1 } as ChatStreamEvent;
        const publish = { containerId: 'employees', datasetId: 'ds_emp' };
        yield { type: 'tool_use', id: 'p1', name: 'canvas_publish_rows', input: publish } as ChatStreamEvent;
        const handler = handlers.get('canvas_publish_rows');
        assert.ok(handler, 'publish tool registered');
        const output = await turnContext.run({ turnId: 'T1', turnDate: '2026-10-29' }, () => handler(publish));
        yield { type: 'tool_result', id: 'p1', output, durationMs: 1 } as ChatStreamEvent;
        yield { type: 'done', answer: 'Hier sind die Mitarbeiter.', toolCalls: 2, iterations: 1 } as ChatStreamEvent;
      },
    },
  } as unknown as ChatAgentBundle);
  await activate(ctx);
  const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  return { agent, logs, invokes, baseInputs, candidates, s };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const evs: ChatStreamEvent[] = [];
  for await (const e of it) evs.push(e);
  return evs;
}

/** The tree the client holds after the dataset publish: columns = dataset paths. */
const publishedTree = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    {
      type: 'table',
      id: 'employees',
      columns: COLUMNS.map((c) => ({ fieldKey: c.path, label: c.path })),
      rows: RECORDS.map((r) => ({ rowKey: String(r.id), cells: { id: r.id, name: r.name, birthday: r.birthday } })),
    },
  ],
};

describe('agent dataset publish → derived recipe', () => {
  it('derives + persists the recipe, logs it, and feeds the learning candidate', async () => {
    const h = await harness();
    await collect(h.agent.chatStream({ userMessage: 'Alle Mitarbeiter mit Geburtstag', canvasSessionId: 'cs-1' }));
    assert.equal(h.baseInputs.length, 1, 'the agent filled the table');
    assert.ok(h.logs.includes('[fast-path] recipe derived container=employees tool=odoo_query'), h.logs.join('\n'));
    assert.ok(!h.logs.some((l) => l.includes('learned skip reason=no-map')), 'learning no longer skips no-map');
    // learning commits behind `done`
    await new Promise((r) => setTimeout(r, 10));
    const c = h.candidates.at(-1);
    assert.equal(c?.tool, 'odoo_query');
    assert.deepEqual(c?.map, { id: 'id', name: 'name', birthday: 'birthday' });
    assert.equal(c?.rowKey, 'id');

    // refresh now runs LLM-free from the derived recipe
    const before = h.baseInputs.length;
    await collect(
      h.agent.chatStream({
        userMessage: '',
        canvasSessionId: 'cs-1',
        canvasRefresh: { basedOnRevision: '3', currentTree: publishedTree },
      }),
    );
    assert.equal(h.baseInputs.length, before, 'no agent turn on refresh');
    assert.deepEqual(h.invokes.at(-1), { name: 'odoo_query', input: QUERY });

    // and "Details anzeigen" on a row hits the LLM-free row details
    const target = { kind: 'item', containerId: 'employees', itemKey: '2' };
    const events = await collect(
      h.agent.chatStream({
        userMessage: 'Details',
        canvasSessionId: 'cs-1',
        action: { type: 'row_details', target },
        target,
      } as ChatTurnInput),
    );
    assert.equal(h.baseInputs.length, before, 'no agent turn on details');
    assert.ok(events.some((e) => e.type === 'surface_snapshot'));
    assert.ok(h.logs.some((l) => l.startsWith('[fast-path] hit channel=canvas kind=row-details')));
    const detail = h.invokes.at(-1)?.input as { model: string; domain: unknown };
    assert.equal(detail.model, 'hr.employee');
    assert.deepEqual(detail.domain, [['id', '=', 2]]);
  });

  it('skips an unexpressible verb chain (logged) — refresh stays on the agent path', async () => {
    const h = await harness();
    h.s.provenance = prov({ verbs: [{ verb: 'sort', args: { by: 'name' } }] });
    await collect(h.agent.chatStream({ userMessage: 'Mitarbeiter sortiert', canvasSessionId: 'cs-2' }));
    assert.ok(h.logs.includes('[fast-path] recipe-skip container=employees reason=verb-sort'), h.logs.join('\n'));
    const before = h.baseInputs.length;
    await collect(
      h.agent.chatStream({
        userMessage: '',
        canvasSessionId: 'cs-2',
        canvasRefresh: { basedOnRevision: '3', currentTree: publishedTree },
      }),
    );
    assert.equal(h.baseInputs.length, before + 1, 'refresh fell back to the agent');
  });

  it('skips a dataset without provenance (no input recorded)', async () => {
    const h = await harness();
    h.s.provenance = undefined;
    await collect(h.agent.chatStream({ userMessage: 'Mitarbeiter', canvasSessionId: 'cs-3' }));
    assert.ok(h.logs.includes('[fast-path] recipe-skip container=employees reason=no-provenance'), h.logs.join('\n'));
  });
});

describe('deriveDatasetRecipe — envelope-shaped origin (v414)', () => {
  it('carries the provenance itemsPath; the map references record attributes only', () => {
    const r = deriveDatasetRecipe(prov({ itemsPath: 'records' }), ['id', 'name', 'birthday']);
    assert.deepEqual(r, {
      ok: true,
      source: {
        tool: 'odoo_query',
        input: QUERY,
        itemsPath: 'records',
        map: { id: 'id', name: 'name', birthday: 'birthday' },
        rowKey: 'id',
      },
    });
  });

  it('end-to-end: an interned odoo_query envelope derives a records recipe without envelope columns', async () => {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 'env',
      toolName: 'odoo_query',
      rawResult: JSON.stringify({ model: 'hr.employee', scope: 'hr', count: 2, truncated: false, records: RECORDS }),
      toolInput: QUERY,
    });
    const resolved = svc.resolveDatasetForRender?.('env', r.datasetId);
    assert.ok(resolved);
    const paths = resolved.columns.map((c) => c.path);
    assert.deepEqual(paths, ['id', 'name', 'birthday']);
    const derived = deriveDatasetRecipe(svc.datasetProvenance?.('env', r.datasetId), paths);
    assert.ok(derived.ok);
    assert.equal(derived.source.itemsPath, 'records');
    assert.deepEqual(derived.source.map, { id: 'id', name: 'name', birthday: 'birthday' });
    // the replayed tool output resolves through the recipe's itemsPath to the records
    const replayed = { model: 'hr.employee', scope: 'hr', count: 2, truncated: false, records: RECORDS };
    const items = (replayed as Record<string, unknown>)[derived.source.itemsPath ?? ''];
    assert.deepEqual(items, RECORDS);
  });
});
