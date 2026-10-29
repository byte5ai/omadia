/**
 * Canvas fast path, second slice — what lets "aktuelle offene Posten" hit:
 *
 *   - the odoo_query composer spec carries a curated field catalog and
 *     German/English business-term mappings (no HR red-line field);
 *   - the summary template supports `{sum:<fieldKey>}` next to `{count}`,
 *     formatted in the composer-declared locale, and refuses (miss
 *     `summary-unresolvable`) rather than print a wrong figure;
 *   - `{today}` / `{today±Nd}` tokens in a recipe input resolve at execution,
 *     so a stored recipe re-resolves on every refresh;
 *   - the composer call asks for the lowest-latency reasoning setting.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import {
  COMPOSER_REASONING,
  composeSkeleton,
  type CompositionLlm,
} from '../packages/omadia-ui-orchestrator/src/composition.js';
import { plannableTools, renderSummary } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { buildPlannerPrompt, parsePlan, PLANNER_SYSTEM } from '../packages/harness-plugin-fast-path/src/planner.js';
import { ROUTER_SYSTEM } from '../packages/harness-plugin-fast-path/src/router.js';
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { resolveRecipeInput, resolveTimeZone } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const COLUMNS = [
  { fieldKey: 'number', label: 'Rechnung' },
  { fieldKey: 'partner', label: 'Kunde' },
  { fieldKey: 'due', label: 'Fällig' },
  { fieldKey: 'amount', label: 'Offen' },
];

const OPEN_ITEMS_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'h', content: 'Offene Posten', level: 2 },
    { type: 'table', id: 'open_items', loading: 'skeleton', columns: COLUMNS, rows: [] },
  ],
};

const OPEN_ITEMS_FETCH = {
  tool: 'odoo_query',
  input: {
    model: 'account.move',
    domain: [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
    ],
    fields: ['name', 'partner_id', 'invoice_date_due', 'amount_residual', 'currency_id'],
    limit: 100,
    order: 'invoice_date_due asc',
  },
  map: { number: 'name', partner: 'partner_id.1', due: 'invoice_date_due', amount: 'amount_residual' },
  rowKey: 'id',
};

const EUR = [1, 'EUR'];
const USD = [2, 'USD'];

const INVOICES = [
  { id: 11, name: 'INV/2026/0011', partner_id: [7, 'Acme GmbH'], invoice_date_due: '2026-09-30', amount_residual: 1200.5, currency_id: EUR },
  { id: 12, name: 'INV/2026/0012', partner_id: [8, 'Beta AG'], invoice_date_due: '2026-10-15', amount_residual: 50000, currency_id: EUR },
  { id: 13, name: 'INV/2026/0013', partner_id: [7, 'Acme GmbH'], invoice_date_due: '2026-11-01', amount_residual: 29.5, currency_id: EUR },
];

const invoiceOutput = (records: unknown[]): string =>
  JSON.stringify({ model: 'account.move', scope: 'accounting', count: records.length, truncated: false, records });

const SUM_SUMMARY = '{count} offene Posten über insgesamt {sum:amount} €.';

const openItemsComposer = (opts?: { summary?: string; locale?: string | null; fetch?: unknown }): string =>
  JSON.stringify({
    tree: OPEN_ITEMS_TREE,
    dataRequirements: [
      {
        containerId: 'open_items',
        description: 'Offene Kundenrechnungen',
        fields: COLUMNS,
        fetch: opts?.fetch ?? OPEN_ITEMS_FETCH,
      },
    ],
    summary: opts?.summary ?? SUM_SUMMARY,
    ...(opts?.locale === null ? {} : { locale: opts?.locale ?? 'de-DE' }),
  });

const llmReturning = (text: string): { llm: CompositionLlm; reqs: Array<Record<string, unknown>> } => {
  const reqs: Array<Record<string, unknown>> = [];
  return {
    reqs,
    llm: {
      complete: (req) => {
        reqs.push(req as unknown as Record<string, unknown>);
        return Promise.resolve({ text });
      },
    },
  };
};

/** Calendar date in Europe/Berlin — the token resolver's default zone. */
const berlinDate = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

// ── harness (same shape as uiOrchestratorFastPath.test.ts) ─────────────────

interface Harness {
  agent: ChatAgentBundle['agent'];
  logs: string[];
  invokeCalls: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
}

async function harness(opts: {
  composer: string;
  invoke: (name: string, input: unknown) => Promise<string>;
}): Promise<Harness> {
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const invokeCalls: Array<{ name: string; input: unknown }> = [];
  const baseInputs: ChatTurnInput[] = [];
  const ctx = {
    log: (m: string) => logs.push(m),
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: withRouterPlanner(llmReturning(opts.composer).llm),
    config: { get: <T>(): T | undefined => undefined },
    tools: {
      register: () => () => {},
      invoke: (name: string, input: unknown) => {
        invokeCalls.push({ name, input });
        return opts.invoke(name, input);
      },
    },
  } as unknown as PluginContext;
  reg.set(CHAT_AGENT_SERVICE, {
    agent: {
      // the base agent's own tool list — the fast path stays within it
      offeredToolNames: () => new Set(['odoo_query']),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        await Promise.resolve();
        yield { type: 'text_delta', text: 'agent answer' } as ChatStreamEvent;
        yield { type: 'done', answer: 'agent answer', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
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

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const field = (e: ChatStreamEvent | undefined, k: string): unknown =>
  (e as unknown as Record<string, unknown> | undefined)?.[k];

const turn = (over?: Partial<ChatTurnInput>): ChatTurnInput =>
  ({ userMessage: 'aktuelle offene Posten', canvasSessionId: 'cs-sum', ...over }) as ChatTurnInput;

const texts = (events: readonly ChatStreamEvent[]): unknown[] =>
  events.filter((e) => e.type === 'text_delta').map((e) => field(e, 'text'));

function patchedRows(events: readonly ChatStreamEvent[]): Array<{ rowKey: string; cells: Record<string, unknown> }> {
  const rows: Array<{ rowKey: string; cells: Record<string, unknown> }> = [];
  for (const e of events) {
    if (e.type !== 'surface_patch') continue;
    for (const p of field(e, 'patches') as Array<{ path: string; value: unknown }>) {
      if (!/\/rows(\/-)?$/.test(p.path)) continue;
      for (const r of Array.isArray(p.value) ? p.value : [p.value]) {
        rows.push(r as { rowKey: string; cells: Record<string, unknown> });
      }
    }
  }
  return rows;
}

// ── composer prompt: schema hints ──────────────────────────────────────────

describe('fast path — Odoo schema hints in the planner prompt', () => {
  it('the odoo_query spec carries the curated catalog and business-term mappings', () => {
    const [tool] = plannableTools(['odoo_query']);
    assert.ok(tool);
    const prompt = PLANNER_SYSTEM + '\n' + buildPlannerPrompt({ question: 'x', tool });
    for (const needle of [
      'account.move',
      'amount_residual',
      'invoice_date_due',
      'payment_state',
      'not_paid',
      'out_invoice',
      'in_invoice',
      'res.partner',
      'customer_rank',
      'supplier_rank',
      'currency_id',
      'one currency',
      'hr.employee',
      'birthday',
      'offene Posten',
      'Kreditoren',
      'überfällig',
      '{today}',
      '{sum:',
      '"locale"',
    ]) {
      assert.ok(prompt.includes(needle), `prompt mentions ${needle}`);
    }
    assert.match(ROUTER_SYSTEM, /or when unsure/, 'the agent-when-unsure rule stays (router)');
    // HR red-line fields (omadia-integration-odoo odooCore.ts) are never
    // suggested as fields (the prose "HR wage/bank/private fields are
    // blocked" notice is intended)
    for (const red of [
      'hourly_wage',
      'struct_id',
      'private_email',
      'private_phone',
      'private_street',
      'bank_account_id',
      'identification_id',
      'passport_id',
      'ssnid',
      'emergency_contact',
    ]) {
      assert.doesNotMatch(prompt, new RegExp(`\\b${red}\\b`), `red-line field ${red} absent`);
    }
    assert.doesNotMatch(prompt, /"wage"|\bwage,/, 'wage never listed as a field');
  });
});

// ── summary aggregates ─────────────────────────────────────────────────────

describe('fast path — summary aggregates ({count}, {sum:fieldKey})', () => {
  const rows = [{ amount: 1200.5 }, { amount: 50000 }, { amount: 29.5 }];
  const map = { amount: 'amount_residual' };
  const eur = (n: number) => Array.from({ length: n }, () => ({ currency_id: EUR }));
  const records = eur(3);

  it('formats sums in the given locale (de / en) and keeps {count}', () => {
    assert.deepEqual(renderSummary('{count} Posten, {sum:amount} €', { rows, records, map, locale: 'de-DE' }), {
      ok: true,
      text: '3 Posten, 51.230,00 €',
    });
    assert.deepEqual(renderSummary('{count} items, €{sum:amount}', { rows, records, map, locale: 'en-US' }), {
      ok: true,
      text: '3 items, €51,230.00',
    });
    assert.deepEqual(renderSummary('{count} Mitarbeitende', { rows: [], records: [], map: {} }), {
      ok: true,
      text: '0 Mitarbeitende',
    });
    assert.deepEqual(renderSummary('{sum:amount} €', { rows: [], records: [], map, locale: 'de' }), {
      ok: true,
      text: '0,00 €',
    });
  });

  it('refuses a sum it cannot compute exactly', () => {
    const refuses = (template: string, opts: Parameters<typeof renderSummary>[1]): void =>
      assert.equal(renderSummary(template, opts).ok, false, JSON.stringify(opts));
    const two = eur(2);
    refuses('{sum:amount}', { rows: [{ amount: 5 }, { amount: '' }], records: two, map, locale: 'de' }); // empty (Odoo false)
    refuses('{sum:amount}', { rows: [{ amount: 5 }, { amount: '12' }], records: two, map, locale: 'de' }); // string
    refuses('{sum:amount}', { rows: [{ amount: 5 }, {}], records: two, map, locale: 'de' }); // missing
    refuses('{sum:total}', { rows, records, map, locale: 'de' }); // not a fieldKey of the container
    refuses('{sum:amount}', { rows, records, map }); // no locale: never guess 51,230 vs 51.230
    refuses('{sum:amount}', { rows, records, map, locale: 'not a locale!' }); // invalid locale
  });

  it('a monetary sum renders only when every summed row shares ONE currency', () => {
    // single currency (many2one id compared; display name irrelevant)
    assert.deepEqual(
      renderSummary('{sum:amount} €', {
        rows,
        records: [{ currency_id: [1, 'EUR'] }, { currency_id: [1, 'Euro'] }, { currency_id: [1, 'EUR'] }],
        map,
        locale: 'de',
      }),
      { ok: true, text: '51.230,00 €' },
    );
    const refuses = (recs: Array<Record<string, unknown>>, why: string): void =>
      assert.equal(renderSummary('{sum:amount} €', { rows, records: recs, map, locale: 'de' }).ok, false, why);
    refuses([{ currency_id: EUR }, { currency_id: USD }, { currency_id: EUR }], 'mixed currencies');
    refuses([{ currency_id: EUR }, { currency_id: false }, { currency_id: EUR }], 'a row without currency');
    refuses([{}, {}, {}], 'currency_id not fetched');
    refuses(eur(2), 'records not aligned with rows');
    // every amount-like attribute counts as monetary
    for (const attr of ['amount_total', 'price_subtotal', 'balance', 'debit', 'credit']) {
      assert.equal(
        renderSummary('{sum:amount}', { rows, records: [{}, {}, {}], map: { amount: attr }, locale: 'de' }).ok,
        false,
        `${attr} is monetary`,
      );
    }
    // a non-monetary sum (days) needs no currency
    assert.deepEqual(
      renderSummary('{sum:days} Tage', {
        rows: [{ days: 2 }, { days: 1.5 }],
        records: [{}, {}],
        map: { days: 'number_of_days' },
        locale: 'de',
      }),
      { ok: true, text: '3,50 Tage' },
    );
  });

  it('the planner keeps a sum-only summary and a valid locale, drops an invalid locale', () => {
    const fetchOf = (text: string): Record<string, unknown> =>
      (JSON.parse(text) as { dataRequirements: Array<{ fetch: Record<string, unknown> }> }).dataRequirements[0]!.fetch;
    const allowedTools = new Set(['odoo_query']);
    const ok = parsePlan(
      { ...fetchOf(openItemsComposer()), summary: 'Offen: {sum:amount} €.', locale: 'de-DE' },
      { allowedTools, question: 'aktuelle offene Posten' },
    );
    assert.ok(ok.ok);
    assert.equal(ok.plan.summary, 'Offen: {sum:amount} €.');
    assert.equal(ok.plan.locale, 'de-DE');
    const bad = parsePlan(
      { ...fetchOf(openItemsComposer()), summary: SUM_SUMMARY, locale: 'not a locale!' },
      { allowedTools, question: 'aktuelle offene Posten' },
    );
    assert.ok(bad.ok);
    assert.equal(bad.plan.summary, SUM_SUMMARY);
    assert.equal(bad.plan.locale, undefined);
  });
});

// ── relative-date tokens ───────────────────────────────────────────────────

describe('fast path — relative-date tokens in recipe inputs', () => {
  it('resolves {today} and {today±Nd} (whole-string values only) in the configured zone', () => {
    const now = new Date(Date.UTC(2026, 0, 31, 23, 30)); // 23:30Z on Jan 31 = 00:30 Feb 1 in Berlin
    const input = {
      model: 'account.move',
      domain: [
        ['invoice_date_due', '<', '{today}'],
        ['invoice_date_due', '>=', '{today-30d}'],
        ['invoice_date', '<=', '{today+1d}'],
        ['name', 'ilike', 'x {today}'],
      ],
      limit: 100,
    };
    assert.deepEqual(resolveRecipeInput(input, now, 'Europe/Berlin'), {
      model: 'account.move',
      domain: [
        ['invoice_date_due', '<', '2026-02-01'],
        ['invoice_date_due', '>=', '2026-01-02'],
        ['invoice_date', '<=', '2026-02-02'],
        ['name', 'ilike', 'x {today}'],
      ],
      limit: 100,
    });
    assert.deepEqual(
      (resolveRecipeInput(input, now, 'UTC') as typeof input).domain[0],
      ['invoice_date_due', '<', '2026-01-31'],
      'the same instant in UTC is still Jan 31',
    );
    assert.equal(input.domain[0]?.[2], '{today}', 'the stored recipe keeps its token');
  });

  it('the zone is the fast_path_timezone setting — default Europe/Berlin, an invalid one falls back', () => {
    assert.equal(resolveTimeZone(undefined), 'Europe/Berlin');
    assert.equal(resolveTimeZone(''), 'Europe/Berlin');
    assert.equal(resolveTimeZone('America/New_York'), 'America/New_York');
    assert.equal(resolveTimeZone('Mars/Olympus'), 'Europe/Berlin');
  });
});

// ── canvasTurnStream ───────────────────────────────────────────────────────

describe('canvasChatAgent — fast path with aggregates and relative dates', () => {
  it('hit: "offene Posten" runs as one query and states the exact open total', async () => {
    const h = await harness({ composer: openItemsComposer(), invoke: () => Promise.resolve(invoiceOutput(INVOICES)) });
    const events = await collect(h.agent.chatStream(turn()));
    assert.equal(h.baseInputs.length, 0, 'no agent turn');
    assert.deepEqual(h.invokeCalls, [{ name: 'odoo_query', input: OPEN_ITEMS_FETCH.input }]);
    assert.deepEqual(
      patchedRows(events).map((r) => [r.rowKey, r.cells['partner'], r.cells['amount']]),
      [
        ['11', 'Acme GmbH', 1200.5],
        ['12', 'Beta AG', 50000],
        ['13', 'Acme GmbH', 29.5],
      ],
    );
    assert.deepEqual(texts(events), ['3 offene Posten über insgesamt 51.230,00 €.']);
    assert.equal(field(events.at(-1), 'answer'), '3 offene Posten über insgesamt 51.230,00 €.');
  });

  async function assertMiss(reason: string, opts: Parameters<typeof harness>[0]): Promise<void> {
    const h = await harness(opts);
    const events = await collect(h.agent.chatStream(turn()));
    assert.equal(h.baseInputs.length, 1, `${reason}: falls back to the agent`);
    assert.ok(
      h.logs.includes(`[ui-orchestrator] fast-path miss reason=${reason}`),
      `${reason}: logged (got ${h.logs.filter((m) => m.includes('fast-path')).join(' | ')})`,
    );
    assert.equal(events.filter((e) => e.type.startsWith('surface_')).length, 1, `${reason}: only the skeleton`);
    assert.deepEqual(texts(events), ['agent answer']);
  }

  it('miss: a non-numeric value under {sum:…} → summary-unresolvable, nothing leaks', () =>
    assertMiss('summary-unresolvable', {
      composer: openItemsComposer(),
      invoke: () => Promise.resolve(invoiceOutput([INVOICES[0], { ...INVOICES[1], amount_residual: false }])),
    }));

  it('miss: invoices in two currencies → summary-unresolvable, never a mixed total', () =>
    assertMiss('summary-unresolvable', {
      composer: openItemsComposer(),
      invoke: () => Promise.resolve(invoiceOutput([INVOICES[0], { ...INVOICES[1], currency_id: USD }])),
    }));

  it('miss: an amount summed without currency_id fetched → summary-unresolvable', () =>
    assertMiss('summary-unresolvable', {
      composer: openItemsComposer(),
      invoke: () =>
        Promise.resolve(invoiceOutput(INVOICES.map(({ currency_id: _c, ...rest }) => rest))),
    }));

  it('miss: {sum:…} without a locale → summary-unresolvable', () =>
    assertMiss('summary-unresolvable', {
      composer: openItemsComposer({ locale: null }),
      invoke: () => Promise.resolve(invoiceOutput(INVOICES)),
    }));

  it('a {today} token in the planned domain resolves at execution, on every replay', async () => {
    const overdue = {
      ...OPEN_ITEMS_FETCH,
      input: {
        ...OPEN_ITEMS_FETCH.input,
        domain: [...OPEN_ITEMS_FETCH.input.domain, ['invoice_date_due', '<', '{today}']],
      },
    };
    const h = await harness({
      composer: openItemsComposer({ fetch: overdue }),
      invoke: () => Promise.resolve(invoiceOutput(INVOICES.slice(0, 1))),
    });
    const first = await collect(h.agent.chatStream(turn({ userMessage: 'überfällige offene Posten' })));
    assert.equal(h.baseInputs.length, 0, 'fast-path hit');
    await collect(
      h.agent.chatStream(
        turn({
          userMessage: '',
          canvasRefresh: { basedOnRevision: '1', currentTree: field(first[0], 'tree') },
        } as Partial<ChatTurnInput>),
      ),
    );
    assert.equal(h.baseInputs.length, 0, 'refresh stayed LLM-free');
    assert.equal(h.invokeCalls.length, 2, 'fast path + refresh replay');
    for (const call of h.invokeCalls) {
      const domain = (call.input as { domain: unknown[][] }).domain;
      assert.deepEqual(domain.at(-1), ['invoice_date_due', '<', berlinDate(new Date())]);
    }
  });
});

// ── composer reasoning setting ─────────────────────────────────────────────

describe('composer call — lowest-latency reasoning', () => {
  it('asks for low effort and thinking off, logged once at activation', async () => {
    assert.deepEqual(COMPOSER_REASONING, { effort: 'low', thinking: 'off' });
    const { llm, reqs } = llmReturning(openItemsComposer());
    await composeSkeleton({ llm, model: 'claude-haiku-5-5', userText: 'x' });
    assert.equal(reqs[0]?.['effort'], 'low');
    assert.equal(reqs[0]?.['thinking'], 'off');

    const h = await harness({ composer: openItemsComposer(), invoke: () => Promise.resolve('[]') });
    assert.equal(
      h.logs.filter((m) => /composer reasoning: effort=low thinking=off/.test(m)).length,
      1,
      `logged once (got ${h.logs.join(' | ')})`,
    );
  });
});
