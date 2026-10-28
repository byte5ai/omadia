/**
 * Canvas-turn latency — the deterministic fast path and its building blocks.
 *
 *   - refresh-recipe filters (`RefreshSource.filter`): a date-part / equality
 *     post-filter applied in `applyRefreshSource`, whitelisted by
 *     `parseRefreshSource`, refused on a truncated (incomplete) result;
 *   - composer `fetch` plans: only for allow-listed tools, the allowed
 *     tools' specs reach the composer prompt, `summary` needs `{count}`;
 *   - canvasTurnStream fast path: a fully planned turn runs the query
 *     itself, fills the skeleton table, templates the prose and saves the
 *     recipe — the base agent never runs; every miss falls back to the
 *     base agent unchanged and logs its reason.
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
  composeSkeleton,
  type CompositionLlm,
} from '../packages/omadia-ui-orchestrator/src/composition.js';
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import {
  applyRefreshSource,
  parseRefreshSource,
  type RefreshSource,
} from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const EMPLOYEES = [
  { id: 1, name: 'Anna Becker', birthday: '1990-01-15', department_id: [3, 'Sales'] },
  { id: 2, name: 'Ben Cordes', birthday: '1985-03-02', department_id: [4, 'IT'] },
  { id: 3, name: 'Clara Dietz', birthday: '1979-01-31', department_id: [4, 'IT'] },
  { id: 4, name: 'Dirk Engel', birthday: false, department_id: false },
];

/** odoo_query's real output envelope (odooReadTools.ts `boundJson`). */
const odooOutput = (records: unknown[], truncated = false): string =>
  JSON.stringify({ model: 'hr.employee', scope: 'hr', count: records.length, truncated, records });

const BIRTHDAY_FETCH = {
  tool: 'odoo_query',
  input: {
    model: 'hr.employee',
    domain: [['active', '=', true]],
    fields: ['name', 'birthday', 'department_id'],
    limit: 100,
  },
  map: { name: 'name', birthday: 'birthday', department: 'department_id.1' },
  rowKey: 'id',
  filter: { field: 'birthday', datePart: 'month', eq: 1 },
};

const BIRTHDAY_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'h', content: 'Geburtstage im Januar', level: 2 },
    {
      type: 'table',
      id: 'birthdays',
      loading: 'skeleton',
      columns: [
        { fieldKey: 'name', label: 'Name' },
        { fieldKey: 'birthday', label: 'Geburtstag' },
        { fieldKey: 'department', label: 'Abteilung' },
      ],
      rows: [],
    },
  ],
};

const SUMMARY = '{count} Mitarbeitende haben im Januar Geburtstag.';

const composerOutput = (opts?: { fetch?: unknown; summary?: string | null }): string =>
  JSON.stringify({
    tree: BIRTHDAY_TREE,
    dataRequirements: [
      {
        containerId: 'birthdays',
        description: 'Aktive Mitarbeitende mit Geburtstag im Januar',
        fields: [
          { fieldKey: 'name', label: 'Name' },
          { fieldKey: 'birthday', label: 'Geburtstag' },
          { fieldKey: 'department', label: 'Abteilung' },
        ],
        ...(opts?.fetch === null ? {} : { fetch: opts?.fetch ?? BIRTHDAY_FETCH }),
      },
    ],
    ...(opts?.summary === null ? {} : { summary: opts?.summary ?? SUMMARY }),
  });

const llmReturning = (text: string): { llm: CompositionLlm; systems: string[] } => {
  const systems: string[] = [];
  return {
    systems,
    llm: {
      complete: (req) => {
        systems.push(req.system ?? '');
        return Promise.resolve({ text });
      },
    },
  };
};

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  invokeCalls: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
}

const BASE_EVENTS: ChatStreamEvent[] = [
  { type: 'text_delta', text: 'agent answer' },
  { type: 'done', answer: 'agent answer', toolCalls: 0, iterations: 1 },
];

async function harness(opts: {
  composer?: string;
  config?: Record<string, string>;
  invoke?: ((name: string, input: unknown) => Promise<string>) | null;
  /** the base agent's own tool list (default: odoo_query); null = unknown */
  offeredTools?: string[] | null;
}): Promise<Harness> {
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const invokeCalls: Array<{ name: string; input: unknown }> = [];
  const baseInputs: ChatTurnInput[] = [];
  const invoke =
    opts.invoke === null
      ? undefined
      : async (name: string, input: unknown): Promise<string> => {
          invokeCalls.push({ name, input });
          if (opts.invoke) return opts.invoke(name, input);
          if (name === 'odoo_query') return odooOutput(EMPLOYEES);
          throw new Error(`tools.invoke: '${name}' is unknown or handler-less`);
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
    llm: llmReturning(opts.composer ?? composerOutput()).llm,
    config: { get: <T>(k: string): T | undefined => opts.config?.[k] as T | undefined },
    tools: { register: () => () => {}, ...(invoke ? { invoke } : {}) },
  } as unknown as PluginContext;
  reg.set(CHAT_AGENT_SERVICE, {
    agent: {
      // the base agent's own tool list — the fast path stays within it
      ...(opts.offeredTools === null
        ? {}
        : { offeredToolNames: () => new Set(opts.offeredTools ?? ['odoo_query']) }),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        await Promise.resolve();
        yield* BASE_EVENTS;
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
  await activate(ctx);
  const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  return { agent, logs, invokeCalls, baseInputs };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const field = (e: ChatStreamEvent | undefined, k: string): unknown =>
  (e as unknown as Record<string, unknown> | undefined)?.[k];

const turn = (over?: Partial<ChatTurnInput>): ChatTurnInput =>
  ({ userMessage: 'Geburtstage im Januar', canvasSessionId: 'cs-fast', ...over }) as ChatTurnInput;

/** The rows a surface_patch put into the birthdays table, by rowKey. */
function patchedRows(events: readonly ChatStreamEvent[]): Array<{ rowKey: string; cells: Record<string, unknown> }> {
  const rows: Array<{ rowKey: string; cells: Record<string, unknown> }> = [];
  for (const e of events) {
    if (e.type !== 'surface_patch') continue;
    for (const p of field(e, 'patches') as Array<{ path: string; value: unknown }>) {
      if (/\/rows(\/-)?$/.test(p.path)) {
        const v = p.value as unknown;
        for (const r of Array.isArray(v) ? v : [v]) rows.push(r as { rowKey: string; cells: Record<string, unknown> });
      }
    }
  }
  return rows;
}

// ── refresh-recipe filters ──────────────────────────────────────────────────

describe('refresh recipes — deterministic post-filter', () => {
  const source = parseRefreshSource(BIRTHDAY_FETCH) as RefreshSource;

  it('parseRefreshSource keeps a valid filter (single or list) and refuses an invalid one', () => {
    assert.ok(source, 'valid recipe');
    assert.deepEqual(source.filter, [{ field: 'birthday', datePart: 'month', eq: 1 }]);
    const listed = parseRefreshSource({
      ...BIRTHDAY_FETCH,
      filter: [
        { field: 'birthday', datePart: 'day', eq: 15 },
        { field: 'active', eq: true },
      ],
    });
    assert.equal(listed?.filter?.length, 2);
    for (const bad of [
      { field: 'birthday', datePart: 'week', eq: 1 },
      { field: 'birthday', datePart: 'month', eq: '1' },
      { field: '', eq: 1 },
      { field: 'x', eq: { nested: true } },
      'birthday=1',
    ]) {
      assert.equal(parseRefreshSource({ ...BIRTHDAY_FETCH, filter: bad }), null, JSON.stringify(bad));
    }
  });

  it('applies a month filter on the raw record and maps many2one display names by path', () => {
    const rows = applyRefreshSource(odooOutput(EMPLOYEES), source);
    assert.deepEqual(rows, [
      { name: 'Anna Becker', birthday: '1990-01-15', department: 'Sales', rowKey: '1' },
      { name: 'Clara Dietz', birthday: '1979-01-31', department: 'IT', rowKey: '3' },
    ]);
  });

  it('applies day/year parts and plain equality (string, number, boolean)', () => {
    const records = [
      { id: 'a', d: '2024-02-29 08:00:00', team: 'IT', n: 5, on: true },
      { id: 'b', d: '2023-02-28', team: 'Sales', n: 5, on: false },
    ];
    const out = (filter: unknown): unknown =>
      applyRefreshSource(
        JSON.stringify(records),
        parseRefreshSource({ tool: 't', input: {}, map: { id: 'id' }, filter }) as RefreshSource,
      )?.map((r) => r['id']);
    assert.deepEqual(out({ field: 'd', datePart: 'day', eq: 29 }), ['a']);
    assert.deepEqual(out({ field: 'd', datePart: 'year', eq: 2023 }), ['b']);
    assert.deepEqual(out({ field: 'team', eq: 'Sales' }), ['b']);
    assert.deepEqual(out({ field: 'n', eq: 5 }), ['a', 'b']);
    assert.deepEqual(out({ field: 'on', eq: true }), ['a']);
  });

  it('an empty filter result is a genuinely empty set ([]), not a mapping failure', () => {
    const none = parseRefreshSource({ ...BIRTHDAY_FETCH, filter: { field: 'birthday', datePart: 'month', eq: 12 } });
    assert.deepEqual(applyRefreshSource(odooOutput(EMPLOYEES), none as RefreshSource), []);
  });

  it('refuses a truncated result when a filter is set — the subset would be wrong', () => {
    assert.equal(applyRefreshSource(odooOutput(EMPLOYEES, true), source), null);
  });

  it('a direct key still wins over the dotted path (Dynamics formatted-value keys)', () => {
    const key = '_owner_value@OData.Community.Display.V1.FormattedValue';
    const rows = applyRefreshSource(
      JSON.stringify({ value: [{ [key]: 'Anna' }] }),
      parseRefreshSource({ tool: 't', input: {}, map: { owner: key } }) as RefreshSource,
    );
    assert.deepEqual(rows, [{ owner: 'Anna' }]);
  });
});

// ── composer fetch plans ─────────────────────────────────────────────────────

describe('composeSkeleton — fetch plans for allow-listed tools', () => {
  const FAST_TOOLS = [{ name: 'odoo_query', spec: 'odoo_query — SPEC-MARKER' }];

  it('parses fetch + summary for an allowed tool and hands the spec to the composer', async () => {
    const { llm, systems } = llmReturning(composerOutput());
    const r = await composeSkeleton({ llm, model: 'm', userText: 'x', fastPathTools: FAST_TOOLS });
    assert.equal(r.source, 'model');
    assert.equal(r.dataRequirements[0]?.fetch?.tool, 'odoo_query');
    assert.deepEqual(r.dataRequirements[0]?.fetch?.filter, [{ field: 'birthday', datePart: 'month', eq: 1 }]);
    assert.equal(r.summary, SUMMARY);
    assert.match(systems[0] ?? '', /SPEC-MARKER/);
  });

  it('drops a fetch for a tool outside the allow-list, and every fetch without tools', async () => {
    const other = await composeSkeleton({
      llm: llmReturning(composerOutput({ fetch: { ...BIRTHDAY_FETCH, tool: 'dynamics_fetchxml' } })).llm,
      model: 'm',
      userText: 'x',
      fastPathTools: FAST_TOOLS,
    });
    assert.equal(other.dataRequirements[0]?.fetch, undefined);

    const { llm, systems } = llmReturning(composerOutput());
    const none = await composeSkeleton({ llm, model: 'm', userText: 'x' });
    assert.equal(none.dataRequirements[0]?.fetch, undefined);
    assert.doesNotMatch(systems[0] ?? '', /FAST PATH/);
  });

  it('drops a summary without the {count} placeholder', async () => {
    const r = await composeSkeleton({
      llm: llmReturning(composerOutput({ summary: 'Hier sind die Geburtstage.' })).llm,
      model: 'm',
      userText: 'x',
      fastPathTools: FAST_TOOLS,
    });
    assert.equal(r.summary, undefined);
  });
});

describe('canvas_publish_rows — datasetIds are published directly', () => {
  it('the tool spec no longer asks for a v4_select/v4_sort shaping round first', async () => {
    const specs: Array<{ name: string; description: string; input_schema: unknown }> = [];
    const ctx = {
      log: () => {},
      services: { get: () => undefined, provide: () => () => {} },
      tools: {
        register: (spec: { name: string; description: string; input_schema: unknown }) => {
          specs.push(spec);
          return () => {};
        },
      },
    } as unknown as PluginContext;
    await activate(ctx);
    const publish = specs.find((s) => s.name === 'canvas_publish_rows');
    assert.ok(publish);
    assert.doesNotMatch(JSON.stringify(publish), /shape (them|it|the dataset) first with v4_select/i);
    assert.match(publish.description, /`datasetId` directly/);
  });
});

// ── canvasTurnStream fast path ───────────────────────────────────────────────

describe('canvasChatAgent — deterministic fast path', () => {
  afterEach(() => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
  });

  it('hit: runs the query itself, fills the skeleton table, templates the prose — no agent turn', async () => {
    const h = await harness({});
    const events = await collect(h.agent.chatStream(turn()));

    assert.equal(h.baseInputs.length, 0, 'base.chatStream NOT called');
    assert.deepEqual(h.invokeCalls, [{ name: 'odoo_query', input: BIRTHDAY_FETCH.input }]);

    assert.equal(events[0]?.type, 'surface_snapshot', 'skeleton first');
    assert.deepEqual(field(events[0], 'tree'), BIRTHDAY_TREE);
    const patch = events.find((e) => e.type === 'surface_patch');
    assert.equal(field(patch, 'basedOnRevision'), '0', 'rows land on the skeleton');
    assert.deepEqual(
      patchedRows(events).map((r) => [r.rowKey, r.cells['name'], r.cells['department']]),
      [
        ['1', 'Anna Becker', 'Sales'],
        ['3', 'Clara Dietz', 'IT'],
      ],
    );
    assert.ok(events.some((e) => e.type === 'surface_data_ref_created'), 'announced as refreshable');

    const text = events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text'));
    assert.deepEqual(text, ['2 Mitarbeitende haben im Januar Geburtstag.']);
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(field(events.at(-1), 'answer'), '2 Mitarbeitende haben im Januar Geburtstag.');
    assert.equal(
      events.some((e) => e.type === 'tool_result' || e.type === 'tool_use'),
      false,
      'no raw tool events on the wire',
    );
    assert.ok(h.logs.some((m) => /\[ui-orchestrator\] fast-path hit tool=odoo_query rows=2 ms=\d+/.test(m)));
  });

  it('hit with an empty result still says a correct sentence', async () => {
    const h = await harness({ invoke: () => Promise.resolve(odooOutput([EMPLOYEES[1]])) });
    const events = await collect(h.agent.chatStream(turn()));
    assert.equal(h.baseInputs.length, 0);
    assert.deepEqual(
      events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text')),
      ['0 Mitarbeitende haben im Januar Geburtstag.'],
    );
  });

  it('saves the recipe (with its filter) — the next refresh is LLM-free and filtered too', async () => {
    const h = await harness({});
    const first = await collect(h.agent.chatStream(turn()));
    const snapshot = first[0];
    // the client's live tree after the fast path: the skeleton (rows irrelevant)
    const refreshed = await collect(
      h.agent.chatStream(
        turn({
          canvasRefresh: { basedOnRevision: '1', currentTree: field(snapshot, 'tree') },
        } as Partial<ChatTurnInput>),
      ),
    );
    assert.equal(h.baseInputs.length, 0, 'refresh never reached the agent');
    assert.equal(h.invokeCalls.length, 2, 'query replayed');
    assert.deepEqual(
      patchedRows(refreshed).map((r) => r.rowKey),
      ['1', '3'],
    );
  });

  async function assertMiss(
    reason: string,
    opts: Parameters<typeof harness>[0],
    input: ChatTurnInput = turn(),
  ): Promise<void> {
    const h = await harness(opts);
    const events = await collect(h.agent.chatStream(input));
    assert.equal(h.baseInputs.length, 1, `${reason}: falls back to the agent`);
    assert.ok(
      h.logs.includes(`[ui-orchestrator] fast-path miss reason=${reason}`),
      `${reason}: logged (got ${h.logs.filter((m) => m.includes('fast-path')).join(' | ')})`,
    );
    assert.equal(events[0]?.type, 'surface_snapshot', `${reason}: skeleton first`);
    assert.equal(
      events.filter((e) => e.type.startsWith('surface_')).length,
      1,
      `${reason}: no fast-path surface leaked`,
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text')),
      ['agent answer'],
      `${reason}: only the agent's text`,
    );
    // the agent's [canvas-context] carries no fetch plan
    assert.doesNotMatch(h.baseInputs[0]?.userMessage ?? '', /"fetch"/);
  }

  it('miss: a requirement without a fetch plan', () =>
    assertMiss('no-plan', { composer: composerOutput({ fetch: null }) }));

  it('miss: no summary template', () =>
    assertMiss('no-summary', { composer: composerOutput({ summary: null }) }));

  it('miss: fast path disabled (fast_path_tools empty)', () =>
    assertMiss('disabled', { config: { fast_path_tools: '' } }));

  it('miss: no tools.invoke in this context', () => assertMiss('no-invoker', { invoke: null }));

  it('miss: tool not registered (unavailable)', () =>
    assertMiss('tool-unavailable', {
      invoke: (name) => Promise.reject(new Error(`tools.invoke: '${name}' is unknown or handler-less`)),
    }));

  it('miss: invoke throws', () =>
    assertMiss('invoke-error', { invoke: () => Promise.reject(new Error('ECONNRESET')) }));

  it('miss: tool returns an Error result', () =>
    assertMiss('tool-error', {
      invoke: () => Promise.resolve('Error: odoo_upstream_500 — Invalid field birthday'),
    }));

  it('miss: truncated result', () =>
    assertMiss('truncated', { invoke: () => Promise.resolve(odooOutput(EMPLOYEES, true)) }));

  it('miss: output not mappable', () =>
    assertMiss('unmappable', { invoke: () => Promise.resolve(JSON.stringify({ records: [{ x: 1 }] })) }));

  it('miss: no table resolves for the planned container', () =>
    assertMiss('unpublishable', {
      composer: JSON.stringify({
        ...JSON.parse(composerOutput()),
        dataRequirements: [
          { ...JSON.parse(composerOutput()).dataRequirements[0], containerId: 'nowhere' },
        ],
      }),
    }));

  it('an agent WITHOUT odoo_query: the composer is never offered it, nothing runs', async () => {
    const h = await harness({ offeredTools: ['memory'] });
    await collect(h.agent.chatStream(turn()));
    assert.equal(h.invokeCalls.length, 0);
    assert.equal(h.baseInputs.length, 1, 'the agent answers');
    assert.ok(h.logs.includes('[ui-orchestrator] fast-path miss reason=disabled'));
  });

  it('an agent that cannot name its tools gets no fast path (fail closed)', async () => {
    const h = await harness({ offeredTools: null });
    await collect(h.agent.chatStream(turn()));
    assert.equal(h.invokeCalls.length, 0);
    assert.equal(h.baseInputs.length, 1);
    assert.ok(h.logs.includes('[fast-path] miss channel=canvas reason=tool-set-unknown'));
  });

  it('miss: structured action / row-bound turn', async () => {
    await assertMiss('action-turn', {}, turn({ action: { type: 'pick', payload: {} } } as Partial<ChatTurnInput>));
  });

  it('miss: privacy force-guarded with no Privacy Shield running', async () => {
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true';
    await assertMiss('privacy-forced', {});
  });
});
