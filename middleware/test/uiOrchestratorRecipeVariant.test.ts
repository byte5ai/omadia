/**
 * Suggested actions as recipe VARIANTS.
 *
 * A suggested action on a table with a recipe (fast-path or derived) may carry
 * a declarative `variant` — a constrained edit of the table's recipe (a
 * datePart/eq filter change, a value swap of an existing domain condition, a
 * limit). The client sends the click as `action: { type: 'recipe_variant',
 * payload: { actionId, containerId } }` plus its live tree; the server looks
 * the variant up, validates it against the CURRENT recipe (same tool, same
 * model, only allowed fields changed) and runs it LLM-free: fetch → replace
 * the table rows → optional heading text. Anything unknown/invalid keeps the
 * existing agent path unchanged.
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
import type { RefreshSource } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import {
  applyVariant,
  monthVariantActions,
  parseVariant,
  RECIPE_VARIANT_ACTION,
} from '../packages/omadia-ui-orchestrator/src/recipeVariant.js';

const BASE: RefreshSource = {
  tool: 'odoo_query',
  input: {
    model: 'hr.employee',
    domain: [['active', '=', true], ['department_id.name', '=', 'Sales']],
    fields: ['name', 'birthday'],
    limit: 100,
  },
  map: { name: 'name', birthday: 'birthday' },
  rowKey: 'id',
};

describe('parseVariant — declarative shape only', () => {
  it('accepts filter / domain / limit patches and a heading', () => {
    const v = parseVariant({
      patch: {
        filter: [{ field: 'birthday', datePart: 'month', eq: 11 }],
        domain: [{ field: 'department_id.name', value: 'IT' }],
        limit: 50,
      },
      heading: 'Geburtstage im November',
    });
    assert.ok(v);
    assert.equal(v.heading, 'Geburtstage im November');
  });

  it('rejects unknown patch keys, tool/model edits, empty patches, bad values', () => {
    assert.equal(parseVariant({ patch: { tool: 'odoo_write' } }), null);
    assert.equal(parseVariant({ patch: { model: 'res.partner' } }), null);
    assert.equal(parseVariant({ patch: {} }), null);
    assert.equal(parseVariant({ patch: { limit: 0 } }), null);
    assert.equal(parseVariant({ patch: { filter: [{ field: 'birthday', datePart: 'month', eq: 13 }] } }), null);
    assert.equal(parseVariant({ patch: { domain: [{ field: 'x', value: { $ne: 1 } }] } }), null);
    assert.equal(parseVariant('Geburtstage im November'), null);
  });
});

describe('applyVariant — validated against the base recipe', () => {
  const apply = (raw: unknown): ReturnType<typeof applyVariant> => {
    const v = parseVariant(raw);
    assert.ok(v, 'shape valid');
    return applyVariant(BASE, v);
  };

  it('adds a datePart filter on a mapped attribute', () => {
    const r = apply({ patch: { filter: [{ field: 'birthday', datePart: 'month', eq: 11 }] } });
    assert.ok(r.ok);
    assert.deepEqual(r.source.filter, [{ field: 'birthday', datePart: 'month', eq: 11 }]);
    assert.deepEqual(r.source.input, BASE.input, 'input untouched');
  });

  it('replaces the eq of an existing filter clause instead of stacking it', () => {
    const base = { ...BASE, filter: [{ field: 'birthday', datePart: 'month' as const, eq: 10 }] };
    const v = parseVariant({ patch: { filter: [{ field: 'birthday', datePart: 'month', eq: 11 }] } });
    assert.ok(v);
    const r = applyVariant(base, v);
    assert.ok(r.ok);
    assert.deepEqual(r.source.filter, [{ field: 'birthday', datePart: 'month', eq: 11 }]);
  });

  it('swaps the value of an EXISTING domain condition and sets a limit', () => {
    const r = apply({ patch: { domain: [{ field: 'department_id.name', value: 'IT' }], limit: 20 } });
    assert.ok(r.ok);
    const input = r.source.input as { model: string; domain: unknown[]; limit: number };
    assert.deepEqual(input.domain, [['active', '=', true], ['department_id.name', '=', 'IT']]);
    assert.equal(input.limit, 20);
    assert.equal(input.model, 'hr.employee');
    assert.equal(r.source.tool, 'odoo_query');
    // the base recipe is never mutated
    assert.deepEqual((BASE.input as { domain: unknown[] }).domain[1], ['department_id.name', '=', 'Sales']);
  });

  it('refuses edits outside the base recipe', () => {
    const reason = (raw: unknown): string => {
      const r = apply(raw);
      return r.ok ? 'ok' : r.reason;
    };
    assert.equal(reason({ patch: { domain: [{ field: 'birthday', value: false }] } }), 'domain-condition-unknown');
    assert.equal(reason({ patch: { filter: [{ field: 'salary', eq: 1 }] } }), 'filter-field-unknown');
    assert.equal(reason({ patch: { filter: [{ field: 'wage', datePart: 'month', eq: 1 }] } }), 'filter-field-unknown');
    const noDomain = { ...BASE, input: { model: 'hr.employee', fields: ['name'] } };
    const v = parseVariant({ patch: { domain: [{ field: 'active', value: false }] } });
    assert.ok(v);
    const r = applyVariant(noDomain, v);
    assert.equal(r.ok ? 'ok' : r.reason, 'domain-condition-unknown');
  });
});

describe('monthVariantActions — fast-path tables with a month filter', () => {
  it('derives previous/next month actions from a datePart month clause (year wrap)', () => {
    const base = { ...BASE, filter: [{ field: 'birthday', datePart: 'month' as const, eq: 1 }] };
    const actions = monthVariantActions(base, 'de');
    assert.deepEqual(
      actions.map((a) => [a.id, a.label, a.variant.patch.filter]),
      [
        ['variant-prev-month', 'Vormonat (Dezember)', [{ field: 'birthday', datePart: 'month', eq: 12 }]],
        ['variant-next-month', 'Folgemonat (Februar)', [{ field: 'birthday', datePart: 'month', eq: 2 }]],
      ],
    );
    assert.deepEqual(monthVariantActions(BASE, 'de'), [], 'no month filter → no variants');
  });
});

// ── integration ─────────────────────────────────────────────────────────────

const QUERY = { model: 'hr.employee', domain: [['active', '=', true]], fields: ['name', 'birthday'], limit: 100 };
const RECORDS = [
  { id: 1, name: 'Marvin Vomberg', birthday: '1990-11-03' },
  { id: 2, name: 'Anna Rüsche', birthday: '1985-04-12' },
  { id: 3, name: 'Thomas Görres', birthday: '1979-11-20' },
];
const COLUMNS = [
  { path: 'id', type: 'number' },
  { path: 'name', type: 'string' },
  { path: 'birthday', type: 'string' },
];
const NOVEMBER = {
  id: 'nov',
  label: 'Geburtstage im November',
  variant: { patch: { filter: [{ field: 'birthday', datePart: 'month', eq: 11 }] }, heading: 'Geburtstage im November' },
};
const BROKEN = { id: 'model', label: 'Partner', variant: { patch: { model: 'res.partner' } } };

const composer = JSON.stringify({
  tree: {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      { type: 'heading', id: 'title', content: 'Alle Mitarbeiter' },
      { type: 'table', id: 'employees', loading: 'skeleton', columns: [{ fieldKey: 'n', label: 'Name' }], rows: [] },
    ],
  },
  dataRequirements: [{ containerId: 'employees', description: 'Mitarbeiter', fields: [{ fieldKey: 'n', label: 'Name' }] }],
});

/** The client's tree after the dataset publish (columns keyed by path). */
const liveTree = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'title', content: 'Alle Mitarbeiter' },
    {
      type: 'table',
      id: 'employees',
      columns: COLUMNS.map((c) => ({ fieldKey: c.path, label: c.path })),
      rows: RECORDS.map((r) => ({ rowKey: String(r.id), cells: { ...r } })),
    },
  ],
};

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  invokes: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
}

async function harness(): Promise<Harness> {
  const reg = new Map<string, unknown>();
  const handlers = new Map<string, (input: unknown) => Promise<string>>();
  const logs: string[] = [];
  const invokes: Harness['invokes'] = [];
  const baseInputs: ChatTurnInput[] = [];
  const provenance: PrivacyDatasetProvenance = { tool: 'odoo_query', input: QUERY, verbs: [], truncated: false };
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
        return Promise.resolve(JSON.stringify({ model: 'hr.employee', count: 3, truncated: false, records: RECORDS }));
      },
    },
  } as unknown as PluginContext;
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
  reg.set(PRIVACY_REDACT_SERVICE_NAME, {
    resolveDatasetForRender: (turnId: string, id: string) =>
      turnId === 'T1' && id === 'ds_emp' ? { rowCount: RECORDS.length, columns: COLUMNS, rows: RECORDS } : undefined,
    datasetProvenance: (turnId: string, id: string) => (turnId === 'T1' && id === 'ds_emp' ? provenance : undefined),
  });
  reg.set(CHAT_AGENT_SERVICE, {
    sessionLogger: { log: () => Promise.resolve({ turnExternalId: 'turn:x' }) },
    agent: {
      offeredToolNames: () => new Set(['odoo_query']),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        if (input.action !== undefined) {
          yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
          return;
        }
        yield { type: 'tool_use', id: 'c1', name: 'odoo_query', input: QUERY } as ChatStreamEvent;
        yield { type: 'tool_result', id: 'c1', output: '{"datasetId":"ds_emp"}', durationMs: 1 } as ChatStreamEvent;
        const publish = { containerId: 'employees', datasetId: 'ds_emp', actions: [NOVEMBER, BROKEN] };
        yield { type: 'tool_use', id: 'p1', name: 'canvas_publish_rows', input: publish } as ChatStreamEvent;
        const handler = handlers.get('canvas_publish_rows');
        assert.ok(handler);
        const output = await turnContext.run({ turnId: 'T1', turnDate: '2026-10-29' }, () => handler(publish));
        yield { type: 'tool_result', id: 'p1', output, durationMs: 1 } as ChatStreamEvent;
        yield { type: 'done', answer: 'Mitarbeiter.', toolCalls: 2, iterations: 1 } as ChatStreamEvent;
      },
    },
  } as unknown as ChatAgentBundle);
  await activate(ctx);
  return { agent: (reg.get('canvasChatAgent') as ChatAgentBundle).agent, logs, invokes, baseInputs };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const evs: ChatStreamEvent[] = [];
  for await (const e of it) evs.push(e);
  return evs;
}

/** Exactly what the client sends on a suggested-action click. */
const click = (actionId: string, withState = true): ChatTurnInput =>
  ({
    userMessage: 'Geburtstage im November (name: Anna Rüsche; rowKey 2)',
    canvasSessionId: 'cs-v',
    target: { kind: 'item', containerId: 'employees', itemKey: '2' },
    action: { type: RECIPE_VARIANT_ACTION, payload: { actionId, containerId: 'employees' } },
    ...(withState ? { canvasState: { basedOnRevision: '4', currentTree: liveTree } } : {}),
  }) as ChatTurnInput;

type Patch = { type: 'surface_patch'; patches: Array<{ op: string; path: string; value: unknown }> };

describe('recipe variant click — LLM-free', () => {
  it('runs the validated variant: fetch, replace rows, heading text, no agent turn', async () => {
    const h = await harness();
    await collect(h.agent.chatStream({ userMessage: 'Alle Mitarbeiter', canvasSessionId: 'cs-v' }));
    const before = h.baseInputs.length;
    const events = await collect(h.agent.chatStream(click('nov')));
    assert.equal(h.baseInputs.length, before, 'no agent turn');
    assert.deepEqual(h.invokes.at(-1), { name: 'odoo_query', input: QUERY });
    const patches = events.filter((e) => e.type === 'surface_patch') as unknown as Patch[];
    const rows = patches.flatMap((p) => p.patches).find((op) => op.path.endsWith('/rows'));
    assert.equal(rows?.op, 'replace');
    assert.deepEqual(
      (rows?.value as Array<{ rowKey: string }>).map((r) => r.rowKey),
      ['1', '3'],
      'only the November birthdays',
    );
    const heading = patches.flatMap((p) => p.patches).find((op) => op.path === '/children/0/content');
    assert.equal(heading?.value, 'Geburtstage im November');
    assert.equal(events.at(-1)?.type, 'done');
    assert.ok(h.logs.some((l) => l.startsWith('[fast-path] hit channel=canvas kind=action-variant tool=odoo_query rows=2')), h.logs.join('\n'));

    // the table now SHOWS the variant: the next refresh replays it, filtered
    await collect(
      h.agent.chatStream({
        userMessage: '',
        canvasSessionId: 'cs-v',
        canvasRefresh: { basedOnRevision: '6', currentTree: liveTree },
      }),
    );
    assert.equal(h.baseInputs.length, before, 'refresh stays LLM-free');
  });

  it('an invalid variant (dropped at publish) or unknown id falls back to the agent path', async () => {
    const h = await harness();
    await collect(h.agent.chatStream({ userMessage: 'Alle Mitarbeiter', canvasSessionId: 'cs-v' }));
    for (const id of ['model', 'nope']) {
      const before = h.baseInputs.length;
      await collect(h.agent.chatStream(click(id)));
      assert.equal(h.baseInputs.length, before + 1, `agent handles ${id}`);
    }
    assert.ok(h.logs.includes('[fast-path] miss channel=canvas kind=action-variant reason=unknown-variant'));
  });

  it('a click without the live tree misses (no-canvas-state)', async () => {
    const h = await harness();
    await collect(h.agent.chatStream({ userMessage: 'Alle Mitarbeiter', canvasSessionId: 'cs-v' }));
    await collect(h.agent.chatStream(click('nov', false)));
    assert.ok(h.logs.includes('[fast-path] miss channel=canvas kind=action-variant reason=no-canvas-state'));
  });
});
