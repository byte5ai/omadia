/**
 * LLM-free row details ("Details anzeigen"): a canvas turn carrying
 * `action: { type: 'row_details' }` and the row's TargetRef is answered from
 * the table's persisted refresh recipe alone — same tool (odoo_query), same
 * Odoo model, `[["id","=",<rowKey>]]`, the catalog's detail fields — and
 * rendered as a deterministic heading + key/value table. No model call at
 * all; every miss keeps the existing path (composer + agent) unchanged.
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
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import { catalogDetailFields } from '../packages/harness-plugin-fast-path/src/fieldLabels.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import {
  buildRowDetailsTree,
  formatDetailValue,
  isRowDetailsAction,
  parseRecordId,
  rowDetailsLanguage,
  rowDetailsSource,
} from '../packages/omadia-ui-orchestrator/src/rowDetails.js';
import { validateTree } from '../packages/omadia-ui-orchestrator/src/treeValidator.js';

const INVOICES = [
  { id: 11, name: 'RE/2026/0001', partner_id: [7, 'Müller GmbH'], amount_residual: 100, currency_id: [1, 'EUR'] },
  { id: 12, name: 'RE/2026/0002', partner_id: [8, 'Weber KG'], amount_residual: 50, currency_id: [1, 'EUR'] },
];
const DETAIL = {
  id: 11,
  name: 'RE/2026/0001',
  partner_id: [7, 'Müller GmbH'],
  invoice_date: '2026-01-10',
  invoice_date_due: '2026-02-10',
  amount_total: 1190.5,
  amount_residual: 100,
  currency_id: [1, 'EUR'],
  state: 'posted',
  payment_state: 'not_paid',
  move_type: 'out_invoice',
};
const out = (records: unknown[]): string =>
  JSON.stringify({ model: 'account.move', count: records.length, truncated: false, records });

const LIST_FETCH = {
  tool: 'odoo_query',
  input: {
    model: 'account.move',
    domain: [['move_type', '=', 'out_invoice']],
    fields: ['name', 'partner_id', 'amount_residual', 'currency_id'],
    limit: 100,
  },
  map: { number: 'name', partner: 'partner_id.1', open: 'amount_residual' },
  rowKey: 'id',
  itemsPath: 'records',
};
const listComposer = JSON.stringify({
  tree: {
    type: 'container', id: 'root', layout: 'stack',
    children: [{ type: 'table', id: 'invoices', loading: 'skeleton', columns: [{ fieldKey: 'number', label: 'Nr' }, { fieldKey: 'partner', label: 'Kunde' }, { fieldKey: 'open', label: 'Offen' }], rows: [] }],
  },
  dataRequirements: [{ containerId: 'invoices', description: 'Rechnungen', fields: [{ fieldKey: 'number', label: 'Nr' }, { fieldKey: 'partner', label: 'Kunde' }, { fieldKey: 'open', label: 'Offen' }], fetch: LIST_FETCH }],
  summary: '{count} Rechnungen.',
});

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  llmCalls: { n: number };
  invokes: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
  logged: Array<Record<string, unknown>>;
  s: { offered: Set<string>; detail: unknown[] | Error };
}

async function harness(): Promise<Harness> {
  const logged: Array<Record<string, unknown>> = [];
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const llmCalls = { n: 0 };
  const invokes: Array<{ name: string; input: unknown }> = [];
  const baseInputs: ChatTurnInput[] = [];
  const s: Harness['s'] = { offered: new Set(['odoo_query']), detail: [DETAIL] };
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
      complete: () => {
        llmCalls.n += 1;
        return Promise.resolve({ text: listComposer });
      },
    },
    config: { get: <T>(): T | undefined => undefined },
    tools: {
      register: () => () => {},
      invoke: (name: string, input: unknown): Promise<string> => {
        invokes.push({ name, input });
        const domain = (input as { domain?: unknown[] }).domain ?? [];
        if (!JSON.stringify(domain).includes('"id"')) return Promise.resolve(out(INVOICES));
        return s.detail instanceof Error ? Promise.reject(s.detail) : Promise.resolve(out(s.detail));
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
  reg.set(CHAT_AGENT_SERVICE, {
    sessionLogger: {
      log: (e: Record<string, unknown>) => {
        logged.push(e);
        return Promise.resolve({ turnExternalId: `turn:${String(e['scope'])}:t` });
      },
    },
    agent: {
      offeredToolNames: () => s.offered,
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        await Promise.resolve();
        yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
      },
    },
  } as unknown as ChatAgentBundle);
  await activate(ctx);
  const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  return { agent, logs, llmCalls, invokes, baseInputs, logged, s };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const evs: ChatStreamEvent[] = [];
  for await (const e of it) evs.push(e);
  return evs;
}

/** The list turn that fills `invoices` through the fast path (recipe captured). */
async function seedList(h: Harness, sid: string): Promise<void> {
  await collect(h.agent.chatStream({ userMessage: 'Offene Rechnungen', canvasSessionId: sid }));
  assert.equal(h.baseInputs.length, 0, 'the list itself was a fast-path hit');
}

/** What the client sends for "Details anzeigen" (after the dispatcher merged
 *  the top-level TargetRef into `action.target`). */
const detailsTurn = (sid: string, rowKey: string, extra: Partial<ChatTurnInput> = {}): ChatTurnInput => {
  const target = { kind: 'item', containerId: 'invoices', itemKey: rowKey };
  return {
    userMessage: 'Zeige die Details zu diesem Datensatz (Nr: RE/2026/0001; rowKey 11).',
    canvasSessionId: sid,
    sessionScope: 'tab_1',
    userId: 'u1',
    action: { type: 'row_details', target },
    target,
    ...extra,
  } as ChatTurnInput;
};

type Snapshot = { type: 'surface_snapshot'; tree: Record<string, unknown>; surfaceSeq: number };
const rowsOf = (tree: Record<string, unknown>): Array<{ rowKey: string; cells: Record<string, unknown> }> => {
  const children = tree['children'] as Array<Record<string, unknown>>;
  const table = children.find((c) => c['type'] === 'table');
  return (table?.['rows'] ?? []) as Array<{ rowKey: string; cells: Record<string, unknown> }>;
};
const cell = (tree: Record<string, unknown>, rowKey: string): unknown =>
  rowsOf(tree).find((r) => r.rowKey === rowKey)?.cells;

afterEach(() => {
  delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
});

describe('row details — deterministic hit (no model call)', () => {
  it('runs ONE id query from the recipe and renders heading + key/value table', async () => {
    const h = await harness();
    await seedList(h, 'cs-1');
    const llmBefore = h.llmCalls.n;
    const events = await collect(h.agent.chatStream(detailsTurn('cs-1', '11')));

    assert.equal(h.llmCalls.n, llmBefore, 'no LLM call at all');
    assert.equal(h.baseInputs.length, 0, 'no agent turn');
    const call = h.invokes.at(-1);
    assert.equal(call?.name, 'odoo_query');
    assert.deepEqual(call?.input, {
      model: 'account.move',
      domain: [['id', '=', 11]],
      fields: [...(catalogDetailFields('account.move') ?? [])],
      limit: 100,
    });

    const snap = events.find((e) => e.type === 'surface_snapshot') as Snapshot | undefined;
    assert.ok(snap, 'a new view');
    assert.equal(snap.surfaceSeq, 0);
    assert.ok(validateTree(snap.tree).ok, 'canvas-core whitelist accepts the tree');
    const heading = (snap.tree['children'] as Array<Record<string, unknown>>)[0];
    assert.deepEqual({ type: heading?.['type'], content: heading?.['content'] }, { type: 'heading', content: 'RE/2026/0001' });
    assert.deepEqual(cell(snap.tree, 'partner_id'), { field: 'Partner', value: 'Müller GmbH' });
    assert.deepEqual(cell(snap.tree, 'invoice_date_due'), { field: 'Fällig am', value: '2026-02-10' });
    assert.deepEqual(cell(snap.tree, 'amount_total'), { field: 'Gesamtbetrag', value: '1.190,50 EUR' });

    const text = events.find((e) => e.type === 'text_delta') as { text?: string } | undefined;
    assert.equal(text?.text, 'Details zu RE/2026/0001.');
    const done = events.at(-1) as { type: string; answer?: string; turnId?: string; toolCalls?: number };
    assert.equal(done.type, 'done');
    assert.equal(done.answer, 'Details zu RE/2026/0001.');
    assert.equal(done.turnId, 'turn:tab_1:t');
    assert.equal(done.toolCalls, 1);
    // no row value travels in a tool event (only surface + text + done go out)
    assert.ok(events.every((e) => e.type === 'surface_snapshot' || e.type === 'text_delta' || e.type === 'done'));

    const rec = h.logged.at(-1);
    assert.equal(rec?.['assistantAnswer'], 'Details zu RE/2026/0001.');
    assert.equal(rec?.['scope'], 'tab_1');
    assert.ok(h.logs.some((m) => /^\[fast-path\] hit channel=canvas kind=row-details tool=odoo_query ms=\d+$/.test(m)));
  });

  it('English labels for payload.locale en-US; empty user text gets a synthetic transcript line', async () => {
    const h = await harness();
    await seedList(h, 'cs-en');
    const turn = detailsTurn('cs-en', '11', { userMessage: '' });
    (turn.action as { payload?: unknown }).payload = { locale: 'en-US' };
    const events = await collect(h.agent.chatStream(turn));
    const snap = events.find((e) => e.type === 'surface_snapshot') as Snapshot;
    assert.deepEqual(cell(snap.tree, 'invoice_date_due'), { field: 'Due date', value: '2026-02-10' });
    assert.deepEqual(cell(snap.tree, 'amount_total'), { field: 'Total amount', value: '1,190.50 EUR' });
    assert.equal((events.at(-1) as { answer?: string }).answer, 'Details for RE/2026/0001.');
    assert.match(String(h.logged.at(-1)?.['userMessage']), /^Show details \(account\.move 11\)$/);
  });
});

describe('row details — misses keep the existing path', () => {
  const assertFallback = async (h: Harness, events: ChatStreamEvent[], reason: string): Promise<void> => {
    assert.equal(h.baseInputs.length, 1, 'the agent path ran');
    assert.ok(events.some((e) => e.type === 'done'));
    assert.ok(
      h.logs.includes(`[fast-path] miss channel=canvas kind=row-details reason=${reason}`),
      `logged reason ${reason}: ${h.logs.filter((l) => l.includes('row-details')).join(' | ')}`,
    );
  };

  it('row-key-invalid: a non-numeric / zero row key', async () => {
    for (const key of ['abc', '0', '-3', '1.5']) {
      const h = await harness();
      await seedList(h, 'cs-k');
      const llmBefore = h.llmCalls.n;
      const events = await collect(h.agent.chatStream(detailsTurn('cs-k', key)));
      await assertFallback(h, events, 'row-key-invalid');
      assert.ok(h.llmCalls.n > llmBefore, 'the existing composer path ran');
    }
  });

  it('no-recipe: the target table has no persisted recipe', async () => {
    const h = await harness();
    const events = await collect(h.agent.chatStream(detailsTurn('cs-none', '11')));
    await assertFallback(h, events, 'no-recipe');
    assert.ok(!h.invokes.some((c) => JSON.stringify(c.input).includes('"id"')), 'no detail query ran');
  });

  it('tool-not-permitted: the answering agent does not offer odoo_query', async () => {
    const h = await harness();
    await seedList(h, 'cs-p');
    h.s.offered = new Set(['web_search']);
    const before = h.invokes.length;
    const events = await collect(h.agent.chatStream(detailsTurn('cs-p', '11')));
    await assertFallback(h, events, 'tool-not-permitted');
    assert.equal(h.invokes.length, before, 'nothing invoked');
  });

  it('privacy-forced: org policy on and no Privacy Shield running', async () => {
    const h = await harness();
    await seedList(h, 'cs-pf');
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true';
    const before = h.invokes.length;
    const events = await collect(h.agent.chatStream(detailsTurn('cs-pf', '11')));
    await assertFallback(h, events, 'privacy-forced');
    assert.equal(h.invokes.length, before);
  });

  it('not-found: the id query returns no record', async () => {
    const h = await harness();
    await seedList(h, 'cs-nf');
    h.s.detail = [];
    const events = await collect(h.agent.chatStream(detailsTurn('cs-nf', '11')));
    await assertFallback(h, events, 'not-found');
  });

  it('invoke-error: the tool throws', async () => {
    const h = await harness();
    await seedList(h, 'cs-ie');
    h.s.detail = new Error('odoo down');
    const events = await collect(h.agent.chatStream(detailsTurn('cs-ie', '11')));
    await assertFallback(h, events, 'invoke-error');
  });

  it('the old free-text beam (no row_details action) is unchanged', async () => {
    const h = await harness();
    await seedList(h, 'cs-old');
    const llmBefore = h.llmCalls.n;
    const target = { kind: 'item', containerId: 'invoices', itemKey: '11' };
    await collect(h.agent.chatStream({ userMessage: 'Zeige die Details', canvasSessionId: 'cs-old', target } as ChatTurnInput));
    assert.ok(h.llmCalls.n > llmBefore, 'the composer still plans the beam');
    assert.ok(!h.logs.some((m) => m.includes('kind=row-details')));
  });
});

describe('row details — building blocks', () => {
  it('isRowDetailsAction only for action.type row_details', () => {
    assert.equal(isRowDetailsAction({ userMessage: '', action: { type: 'row_details' } }), true);
    assert.equal(isRowDetailsAction({ userMessage: '', action: { type: 'pick' } }), false);
    assert.equal(isRowDetailsAction({ userMessage: 'Details', target: { kind: 'item' } }), false);
  });

  it('parseRecordId accepts positive safe integers only', () => {
    assert.equal(parseRecordId('11'), 11);
    assert.equal(parseRecordId('900719925474099'), 900719925474099);
    for (const bad of ['', '0', '007', '-1', '1.0', '1e3', 'abc', ' 1', '99999999999999999']) {
      assert.equal(parseRecordId(bad), undefined, bad);
    }
  });

  it('rowDetailsSource: same tool + model, id domain, catalog detail fields, limit 100', () => {
    const src = rowDetailsSource(LIST_FETCH, 11);
    assert.ok(src);
    assert.equal(src.tool, 'odoo_query');
    assert.deepEqual(src.input, {
      model: 'account.move',
      domain: [['id', '=', 11]],
      fields: [...(catalogDetailFields('account.move') ?? [])],
      limit: 100,
    });
    assert.equal(src.rowKey, 'id');
    assert.equal(src.itemsPath, 'records');
  });

  it('rowDetailsSource falls back to the recipe fields for a model outside the catalog; no model → undefined', () => {
    const other = { ...LIST_FETCH, input: { model: 'project.task', fields: ['name', 'user_id'], limit: 10 } };
    assert.deepEqual((rowDetailsSource(other, 5)?.input as { fields: unknown }).fields, ['name', 'user_id']);
    const viaMap = { ...LIST_FETCH, input: { model: 'project.task' }, map: { t: 'name', u: 'user_id.1' } };
    assert.deepEqual((rowDetailsSource(viaMap, 5)?.input as { fields: unknown }).fields, ['name', 'user_id']);
    assert.equal(rowDetailsSource({ ...LIST_FETCH, input: { domain: [] } }, 5), undefined);
  });

  it('catalog detail fields: readable, labelled fields per model', () => {
    for (const model of ['hr.employee', 'res.partner', 'account.move']) {
      const fields = catalogDetailFields(model);
      assert.ok(fields && fields.length >= 5, model);
      assert.ok(!fields.includes('id'));
    }
    assert.equal(catalogDetailFields('project.task'), undefined);
    // red-line HR fields never appear
    const hr = catalogDetailFields('hr.employee') ?? [];
    for (const red of ['wage', 'bank_account_id', 'private_email', 'private_phone', 'ssnid', 'identification_id']) {
      assert.ok(!hr.includes(red), red);
    }
  });

  it('formatDetailValue: many2one, booleans, empty, money with currency, dates as-is', () => {
    const rec = { currency_id: [1, 'EUR'] };
    assert.equal(formatDetailValue('res.partner', 'country_id', [57, 'Deutschland'], rec, 'de'), 'Deutschland');
    assert.equal(formatDetailValue('res.partner', 'is_company', true, rec, 'de'), 'Ja');
    assert.equal(formatDetailValue('res.partner', 'is_company', false, rec, 'en'), 'No');
    assert.equal(formatDetailValue('res.partner', 'email', false, rec, 'de'), '—');
    assert.equal(formatDetailValue('account.move', 'amount_residual', 51230, rec, 'de'), '51.230,00 EUR');
    assert.equal(formatDetailValue('account.move', 'amount_residual', 5, {}, 'en'), '5.00');
    assert.equal(formatDetailValue('account.move', 'invoice_date', '2026-01-10', rec, 'de'), '2026-01-10');
    assert.equal(formatDetailValue('res.partner', 'customer_rank', 3, rec, 'de'), '3');
  });

  it('buildRowDetailsTree: valid tree; heading falls back to "Details" without a name', () => {
    const t = buildRowDetailsTree({ model: 'hr.employee', record: { id: 3, name: false, job_title: 'Dev' }, fields: ['name', 'job_title'], lang: 'de' });
    assert.ok(validateTree(t.tree).ok, validateTree(t.tree).errors ?? '');
    assert.equal(t.title, undefined);
    const heading = (t.tree['children'] as Array<Record<string, unknown>>)[0];
    assert.equal(heading?.['content'], 'Details');
    assert.deepEqual(cell(t.tree, 'job_title'), { field: 'Position', value: 'Dev' });
  });

  it('rowDetailsLanguage: payload.locale wins, German by default', () => {
    assert.equal(rowDetailsLanguage({ userMessage: '', action: { type: 'row_details', payload: { locale: 'en-GB' } } }), 'en');
    assert.equal(rowDetailsLanguage({ userMessage: '', action: { type: 'row_details' } }), 'de');
  });
});
