/**
 * #2085 — boundaries on data paths (spec 2042 §5.13 1a, §6 criterion 35):
 * an agent may read invoices but its boundaries forbid rankings of
 * individual customers. A fast-lane or side-channel plan that ranks
 * customers is refused, as a new plan and as a cache hit, while an allowed
 * invoice lookup keeps the fast lane without a full agent loop.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  checkDataPlanPresets,
  dataPlanText,
  describeToolCall,
  ranksIndividuals,
  type DataPlanDescription,
} from '@omadia/plugin-api';
import { turnContext, TurnDataCollector } from '@omadia/orchestrator';

import { createDataPlanGuard } from '../packages/harness-orchestrator/src/dataPlanGuard.js';
import type { AnswerCache } from '../packages/harness-plugin-fast-path/src/answerCache.js';
import type { PlannedQuery } from '../packages/harness-plugin-fast-path/src/index.js';
import { describeRefreshSource } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { createFastPathService } from '../packages/harness-plugin-fast-path/src/service.js';
import { createDataActionRunner } from '../src/triggers/dataActions.js';
import { createDeliverDataHandler } from '../src/triggers/deliverDataTool.js';
import { withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';

const NO_RANKINGS = { presets: ['no-individual-rankings'] };

const TOP_CUSTOMERS = {
  tool: 'odoo_query',
  input: { model: 'res.partner', fields: ['name', 'total_invoiced'], order: 'total_invoiced desc', limit: 10 },
  map: { name: 'name', revenue: 'total_invoiced' },
};
const OPEN_INVOICES = {
  tool: 'odoo_query',
  input: { model: 'account.move', fields: ['name', 'partner_id', 'amount_residual'], domain: [['payment_state', '=', 'not_paid']], limit: 100 },
  map: { number: 'name', customer: 'partner_id.1', open: 'amount_residual' },
};

describe('#2085 data-plan boundaries — the deterministic layer', () => {
  it('a top-N of customers, or anything grouped or sorted by customer, ranks individuals', () => {
    assert.equal(ranksIndividuals(describeToolCall(TOP_CUSTOMERS.tool, TOP_CUSTOMERS.input)), true);
    assert.equal(
      ranksIndividuals(describeToolCall('odoo_read_group', { model: 'account.move', group_by: 'partner_id', order: 'amount_total desc' })),
      true,
    );
    assert.equal(ranksIndividuals(describeRefreshSource({ ...OPEN_INVOICES, sort: [{ field: 'partner_id.1', dir: 'asc' }] })), true);
  });

  it('an invoice lookup that merely shows the customer column does not', () => {
    assert.equal(ranksIndividuals(describeRefreshSource(OPEN_INVOICES)), false);
    assert.equal(
      ranksIndividuals(describeRefreshSource({ ...OPEN_INVOICES, sort: [{ field: 'invoice_date_due', dir: 'asc' }] })),
      false,
    );
  });

  it('describes the plan without any input value', () => {
    const plan = describeToolCall('odoo_query', { model: 'account.move', domain: [['partner_id.name', '=', 'Müller GmbH']], order: 'invoice_date desc' });
    const text = dataPlanText(plan);
    assert.equal(text.includes('Müller'), false);
    assert.match(text, /sorted by invoice_date desc/);
    assert.deepEqual(checkDataPlanPresets(plan, NO_RANKINGS.presets), { allowed: true });
  });
});

describe('#2085 data-plan guard — the model layer', () => {
  const plan: DataPlanDescription = describeRefreshSource(OPEN_INVOICES);
  it('asks the judge only for free-text rules, and fails closed', async () => {
    let asked = 0;
    const passing = createDataPlanGuard({ boundaries: NO_RANKINGS, judge: { judge: async () => ((asked += 1), 'pass') } });
    assert.deepEqual(await passing(plan), { allowed: true });
    assert.equal(asked, 0, 'no free-text rule, no model call');

    const custom = { custom: ['Never show amounts of a single invoice above 10,000 EUR'] };
    const blocking = createDataPlanGuard({ boundaries: custom, judge: { judge: async () => 'block' } });
    assert.equal((await blocking(plan)).allowed, false);
    const failing = createDataPlanGuard({ boundaries: custom, judge: { judge: async () => Promise.reject(new Error('down')) } });
    assert.equal((await failing(plan)).allowed, false);
    const slow = createDataPlanGuard({ boundaries: custom, judge: { judge: () => new Promise(() => undefined) }, timeoutMs: 20 });
    assert.equal((await slow(plan)).allowed, false);
    assert.equal((await createDataPlanGuard({ boundaries: custom })(plan)).allowed, false, 'no judge, no pass');
  });
});

describe('#2085 criterion 35 — the fast lane', () => {
  const plannedQuery = (fetch: typeof TOP_CUSTOMERS | typeof OPEN_INVOICES): PlannedQuery =>
    ({ fetch, labels: Object.fromEntries(Object.keys(fetch.map).map((k) => [k, k])), summary: '{count} Zeilen.' }) as unknown as PlannedQuery;

  function service(opts: { reply: string; cached?: PlannedQuery }) {
    const invokes: string[] = [];
    const evicted: string[] = [];
    const cache: AnswerCache = {
      load: async () => undefined,
      lookup: () => (opts.cached ? { hit: true, key: 'k1', plan: opts.cached, slots: 0 } : { hit: false, reason: 'empty' }),
      remember: async () => ({ stored: false, reason: 'test' }),
      recordHit: () => undefined,
      evict: (key) => evicted.push(key),
      entries: () => [],
      settled: async () => undefined,
    };
    const svc = createFastPathService({
      config: { get: () => undefined },
      llm: withRouterPlanner({ complete: () => Promise.resolve({ text: opts.reply }) }),
      model: 'class:fast',
      invoke: (name) => {
        invokes.push(name);
        return Promise.resolve(JSON.stringify({ records: [{ id: 1, name: 'RE-1', partner_id: [7, 'Müller GmbH'], amount_residual: 99 }] }));
      },
      privacyGuard: () => undefined,
      privacyForced: () => false,
      log: () => undefined,
      answerCache: cache,
    });
    const guard = createDataPlanGuard({ boundaries: NO_RANKINGS });
    const ask = () =>
      svc.triageChatTurn({
        channel: 'web',
        userMessage: 'Wer sind unsere Top-Kunden?',
        permittedTools: new Set(['odoo_query']),
        agentSlug: 'erika',
        checkPlan: guard,
      });
    return { ask, invokes, evicted };
  }

  const reply = (fetch: typeof TOP_CUSTOMERS | typeof OPEN_INVOICES): string =>
    JSON.stringify({ decision: 'deterministic', fetch, labels: Object.fromEntries(Object.keys(fetch.map).map((k) => [k, k])), summary: '{count} Zeilen.', locale: 'de-DE' });

  it('refuses a ranking plan as a new plan; nothing runs and the agent takes the turn', async () => {
    const s = service({ reply: reply(TOP_CUSTOMERS) });
    const out = await s.ask();
    assert.equal(out.kind, 'agent');
    assert.equal(out.kind === 'agent' && out.reason, 'boundary');
    assert.deepEqual(s.invokes, []);
  });

  it('refuses the same plan as a cache hit, and drops it from the cache', async () => {
    const s = service({ reply: reply(OPEN_INVOICES), cached: plannedQuery(TOP_CUSTOMERS) });
    const out = await s.ask();
    assert.equal(out.kind === 'agent' && out.reason, 'boundary');
    assert.deepEqual(s.invokes, []);
    assert.deepEqual(s.evicted, ['k1']);
  });

  it('keeps the fast lane for an allowed invoice lookup', async () => {
    const s = service({ reply: reply(OPEN_INVOICES) });
    const out = await s.ask();
    assert.equal(out.kind, 'answer');
    assert.deepEqual(s.invokes, ['odoo_query']);
  });
});

describe('#2085 criterion 35 — the side channel', () => {
  it('deliver_data refuses a ranking plan before the tool runs', async () => {
    const ran: string[] = [];
    const runner = createDataActionRunner(
      () => new Map([['odoo_query', async () => (ran.push('odoo_query'), '[]')]]),
      () => createDataPlanGuard({ boundaries: NO_RANKINGS }),
    );
    const handler = createDeliverDataHandler({ dataActions: runner });
    const collector = new TurnDataCollector();
    const status = await turnContext.run({ turnId: 't', turnDate: '2026-11-20', agentSlug: 'erika', dataSideChannel: collector }, () =>
      handler({ tool: 'odoo_query', input: TOP_CUSTOMERS.input }),
    );
    assert.match(status, /refused by the agent's boundaries/);
    assert.deepEqual(ran, []);
    assert.equal(collector.list().length, 0);
  });
});
