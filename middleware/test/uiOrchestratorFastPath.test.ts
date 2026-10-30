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
import { withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';

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
  /** replaces the default fake (composer text + derived router/planner) */
  llm?: CompositionLlm;
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
    llm: opts.llm ?? withRouterPlanner(llmReturning(opts.composer ?? composerOutput()).llm),
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

describe('composeSkeleton — a pure UI composer (the router + planner plan)', () => {
  it('has no FAST PATH plan section and drops a fetch/summary the model emits anyway', async () => {
    const { llm, systems } = llmReturning(composerOutput());
    const r = await composeSkeleton({ llm, model: 'm', userText: 'x' });
    assert.equal(r.source, 'model');
    assert.equal(r.dataRequirements[0]?.fetch, undefined);
    assert.equal('summary' in r, false);
    assert.equal('locale' in r, false);
    assert.doesNotMatch(systems[0] ?? '', /FAST PATH|"fetch"|VALIDATED EXAMPLES/);
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

  it('an empty result hands the turn to the agent — a wrong filter is likelier than a true zero', async () => {
    const h = await harness({ invoke: () => Promise.resolve(odooOutput([EMPLOYEES[1]])) });
    const events = await collect(h.agent.chatStream(turn()));
    assert.equal(h.baseInputs.length, 1, 'the agent took the turn');
    assert.ok(
      !events.some((e) => e.type === 'text_delta' && String(field(e, 'text')).startsWith('0 Mitarbeitende')),
      'no templated zero sentence',
    );
    assert.ok(h.logs.some((m) => m.includes('fast-path miss reason=empty-result')));
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

  it('miss: the router routes to the agent (no plan call)', () =>
    assertMiss('agent:complex', { composer: composerOutput({ fetch: null }) }));

  it('no summary template: the valid plan still answers, with the default count sentence', async () => {
    const h = await harness({ composer: composerOutput({ summary: null }) });
    const events = await collect(h.agent.chatStream(turn()));
    assert.equal(h.baseInputs.length, 0, 'no agent turn');
    assert.ok(
      h.logs.some((m) => /^\[fast-path\] planner channel=canvas tool=odoo_query ok ms=\d+ summary=default$/.test(m)),
      h.logs.join(' | '),
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text')),
      ['2 Einträge gefunden.'],
    );
  });

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

  it('miss: the single data container is no table in the tree (not-a-table)', () =>
    assertMiss('not-a-table', {
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

describe('canvasChatAgent — router ∥ speculative planner ∥ composer, then binding', () => {
  /** A fake whose every call stays pending until released; records the
   *  call kind (route_turn / plan_query / composer) in start order. */
  const gatedLlm = (): { llm: CompositionLlm; started: string[]; release: () => void } => {
    const started: string[] = [];
    const pending: Array<() => void> = [];
    const inner: CompositionLlm = {
      complete: (req) => {
        started.push(req.toolChoice?.name ?? 'composer');
        return new Promise((resolve) => pending.push(() => resolve({ text: composerOutput() })));
      },
    };
    return { llm: withRouterPlanner(inner), started, release: () => pending.splice(0).forEach((r) => r()) };
  };
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
  };

  it('router, planner and composer are ALL started before any resolves; hit', async () => {
    const g = gatedLlm();
    const h = await harness({ llm: g.llm });
    const done = collect(h.agent.chatStream(turn()));
    await until(() => g.started.length >= 3);
    assert.deepEqual([...g.started].sort(), ['composer', 'plan_query', 'route_turn'], 'all in flight, nothing resolved');
    g.release();
    const events = await done;
    assert.equal(g.started.length, 3, 'no further model call');
    assert.equal(h.baseInputs.length, 0, 'no agent turn');
    assert.ok(events.some((e) => e.type === 'surface_patch'));
    assert.ok(h.logs.some((m) => /^\[fast-path\] router channel=canvas decision=deterministic tool=odoo_query conf=0\.90 ms=\d+$/.test(m)));
  });

  it('an agent route discards the speculative plan; the agent fills the skeleton', async () => {
    const h = await harness({ composer: composerOutput({ fetch: null }) });
    await collect(h.agent.chatStream(turn()));
    assert.ok(h.logs.includes('[fast-path] planner discarded (route=agent:complex)'));
    assert.equal(h.invokeCalls.length, 0, 'no query ran');
    assert.equal(h.baseInputs.length, 1);
  });

  it('kill switch, privacy force-guard and an agent without the tool: no router/planner call at all', async () => {
    const cases: Array<[Parameters<typeof harness>[0], () => void]> = [
      [{ config: { fast_path_tools: '' } }, () => {}],
      [{ offeredTools: ['memory'] }, () => {}],
      [{}, () => { process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true'; }],
    ];
    for (const [opts, setup] of cases) {
      setup();
      const kinds: string[] = [];
      const llm = withRouterPlanner({
        complete: (req: { toolChoice?: { name: string } }) => {
          kinds.push(req.toolChoice?.name ?? 'composer');
          return Promise.resolve({ text: composerOutput() });
        },
      } as CompositionLlm);
      const h = await harness({ ...opts, llm });
      await collect(h.agent.chatStream(turn()));
      assert.ok(!kinds.includes('route_turn') && !kinds.includes('plan_query'), JSON.stringify(opts));
      assert.equal(h.baseInputs.length, 1, 'the agent answers');
      delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    }
  });

  it('a skeleton with two data containers misses (multi-container); the plan never runs', async () => {
    const two = JSON.parse(composerOutput()) as { dataRequirements: Array<Record<string, unknown>> };
    two.dataRequirements.push({ ...two.dataRequirements[0], containerId: 'second' });
    const h = await harness({ composer: JSON.stringify(two) });
    await collect(h.agent.chatStream(turn()));
    assert.ok(h.logs.includes('[fast-path] miss channel=canvas reason=multi-container'));
    assert.equal(h.invokeCalls.length, 0);
    assert.equal(h.baseInputs.length, 1);
  });

  it('binding: the plan fills the ONE table and its columns + labels REPLACE the composer\'s', async () => {
    const PLAN = {
      ...BIRTHDAY_FETCH,
      map: { person: 'name', born: 'birthday' },
      labels: { person: 'Mitarbeiterin', born: 'Geboren am' },
      summary: SUMMARY,
      locale: 'de-DE',
    };
    const llm: CompositionLlm = {
      complete: (req) =>
        Promise.resolve(
          req.toolChoice?.name === 'route_turn'
            ? { text: '', toolCalls: [{ name: 'route_turn', input: { decision: 'deterministic', tool: 'odoo_query', confidence: 0.9 } }] }
            : req.toolChoice?.name === 'plan_query'
              ? { text: '', toolCalls: [{ name: 'plan_query', input: PLAN }] }
              : { text: composerOutput({ fetch: null }) },
        ),
    };
    const h = await harness({ llm });
    const events = await collect(h.agent.chatStream(turn()));
    assert.equal(h.baseInputs.length, 0, 'hit');
    const columns = events
      .filter((e) => e.type === 'surface_patch')
      .flatMap((e) => field(e, 'patches') as Array<{ op: string; path: string; value: unknown }>)
      .find((p) => p.path.endsWith('/columns'));
    assert.deepEqual(columns?.value, [
      { fieldKey: 'person', label: 'Mitarbeiterin' },
      { fieldKey: 'born', label: 'Geboren am' },
    ]);
    assert.deepEqual(
      patchedRows(events).map((r) => [r.rowKey, r.cells['person'], r.cells['born']]),
      [
        ['1', 'Anna Becker', '1990-01-15'],
        ['3', 'Clara Dietz', '1979-01-31'],
      ],
    );
  });
});
