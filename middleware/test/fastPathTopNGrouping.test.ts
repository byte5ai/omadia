/**
 * Live finding (v417): "Welche 5 Kunden haben den höchsten offenen Betrag?"
 * was routed deterministic and answered with 38 invoices — the router took a
 * total PER CUSTOMER for one query's rows, and the planner had no way to cut
 * a top N (odoo_query's limit is fixed at 100 on the fast path).
 *   - the router prompt sends per-group totals/rankings to the agent and
 *     keeps a top N of ROWS deterministic;
 *   - the planner can express a top N: `take` (+ `sort` for tools without a
 *     server-side order), validated and carried into the fetch.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildPlannerSystem,
  parsePlan,
  plannerTool,
} from '../packages/harness-plugin-fast-path/src/planner.js';
import { mapRefreshRecords } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { ROUTER_SYSTEM } from '../packages/harness-plugin-fast-path/src/router.js';

const ODOO = new Set(['odoo_query']);

const plan = (extra: Record<string, unknown>): Record<string, unknown> => ({
  tool: 'odoo_query',
  input: { model: 'account.move', fields: ['name', 'amount_residual'], limit: 100, order: 'amount_residual desc' },
  map: { number: 'name', open_amount: 'amount_residual' },
  itemsPath: 'records',
  rowKey: 'id',
  summary: 'Die {count} größten offenen Rechnungen.',
  locale: 'de-DE',
  ...extra,
});

describe('router — per-group rankings go to the agent, a top N of rows stays deterministic', () => {
  it('names per-group totals as agent_complex', () => {
    assert.match(ROUTER_SYSTEM, /PER GROUP/);
    assert.match(ROUTER_SYSTEM, /Kunden mit dem höchsten offenen Betrag/);
  });

  it('keeps the top N of rows deterministic', () => {
    assert.match(ROUTER_SYSTEM, /top N ROWS by one of their own columns/);
  });
});

describe('planner — top N via take (+ sort)', () => {
  it('the prompt and the forced tool schema offer take and sort', () => {
    const system = buildPlannerSystem({ tools: [{ name: 'odoo_query', spec: 'odoo_query — spec' }] });
    assert.match(system, /"take": N/);
    assert.match(system, /Never put N into the tool's limit/);
    const props = (plannerTool(['odoo_query']).inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok(props['take']);
    assert.ok(props['sort']);
  });

  it('take and sort are carried into the validated fetch', () => {
    const res = parsePlan(plan({ take: 5, sort: [{ field: 'amount_residual', dir: 'desc' }] }), { allowedTools: ODOO });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.plan.fetch.take, 5);
    assert.deepEqual(res.plan.fetch.sort, [{ field: 'amount_residual', dir: 'desc' }]);
  });

  it('an invalid take invalidates the plan (agent answers)', () => {
    for (const take of [0, -1, 2.5, 'fünf']) {
      const res = parsePlan(plan({ take }), { allowedTools: ODOO });
      assert.equal(res.ok, false, `take=${String(take)}`);
    }
  });

  it('a plan without take/sort is unchanged', () => {
    const res = parsePlan(plan({}), { allowedTools: ODOO });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.plan.fetch.take, undefined);
    assert.equal(res.plan.fetch.sort, undefined);
  });

  it('the executed fetch keeps only the first N rows', () => {
    const res = parsePlan(plan({ take: 2 }), { allowedTools: ODOO });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const raw = JSON.stringify({
      records: [
        { id: 1, name: 'A', amount_residual: 30 },
        { id: 2, name: 'B', amount_residual: 20 },
        { id: 3, name: 'C', amount_residual: 10 },
      ],
      truncated: false,
    });
    const mapped = mapRefreshRecords(raw, res.plan.fetch);
    assert.deepEqual(
      mapped?.rows.map((r) => r['number']),
      ['A', 'B'],
    );
  });
});
