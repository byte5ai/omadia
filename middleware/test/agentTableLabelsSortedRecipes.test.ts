/**
 * Sorted / top-N refresh recipes: RefreshSource carries an optional
 * post-fetch `sort` + `take` (generic, every tool), and a replay applies
 * filter → sort → take.
 *
 * The canvas side (human column headers, deriving the recipe from the
 * Privacy Shield's `sort` / `top_n` verbs) is tested in the
 * @omadia/ui-orchestrator plugin repo.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MAX_RECIPE_TAKE,
  mapRefreshRecords,
  parseRefreshSource,
  requiresCompleteResult,
  type RefreshSource,
} from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { fetchRecipeRows } from '../packages/harness-plugin-fast-path/src/fastPath.js';

// ── 2. RefreshSource sort / take ─────────────────────────────────────────────

const BASE = { tool: 'odoo_query', input: { model: 'account.move' }, map: { name: 'name' } };

describe('parseRefreshSource — sort / take', () => {
  it('a persisted recipe without the new fields still parses unchanged', () => {
    assert.deepEqual(parseRefreshSource(BASE), BASE);
  });

  it('accepts a sort list (or one clause) and a positive integer take', () => {
    const r = parseRefreshSource({
      ...BASE,
      sort: [
        { field: 'amount_total', dir: 'desc' },
        { field: 'name', dir: 'asc' },
      ],
      take: 5,
    });
    assert.deepEqual(r?.sort, [
      { field: 'amount_total', dir: 'desc' },
      { field: 'name', dir: 'asc' },
    ]);
    assert.equal(r?.take, 5);
    assert.deepEqual(parseRefreshSource({ ...BASE, sort: { field: 'name', dir: 'asc' } })?.sort, [
      { field: 'name', dir: 'asc' },
    ]);
    // unknown clause keys are dropped, not stored
    assert.deepEqual(parseRefreshSource({ ...BASE, sort: [{ field: 'name', dir: 'asc', x: 1 }] })?.sort, [
      { field: 'name', dir: 'asc' },
    ]);
  });

  it('refuses the whole recipe for an invalid sort or take', () => {
    const bad: unknown[] = [
      { sort: [] },
      { sort: [{ field: '', dir: 'asc' }] },
      { sort: [{ field: 'name' }] },
      { sort: [{ field: 'name', dir: 'up' }] },
      { sort: [{ field: 3, dir: 'asc' }] },
      { sort: ['name'] },
      { sort: [1, 2, 3, 4].map((i) => ({ field: `f${i}`, dir: 'asc' })) },
      { take: 0 },
      { take: -1 },
      { take: 1.5 },
      { take: '5' },
      { take: Number.NaN },
      { take: MAX_RECIPE_TAKE + 1 },
    ];
    for (const extra of bad) {
      assert.equal(parseRefreshSource({ ...BASE, ...(extra as object) }), null, JSON.stringify(extra));
    }
    assert.equal(parseRefreshSource({ ...BASE, take: MAX_RECIPE_TAKE })?.take, MAX_RECIPE_TAKE);
  });
});

const RECORDS = [
  { id: 1, name: 'RE-1', amount_total: 100, state: 'posted', invoice_date: '2026-03-01' },
  { id: 2, name: 'RE-2', amount_total: 900, state: 'draft', invoice_date: false },
  { id: 3, name: 'RE-3', amount_total: 500, state: 'posted', invoice_date: '2026-01-15' },
  { id: 4, name: 'RE-4', amount_total: 900, state: 'posted', invoice_date: '2026-02-01' },
  { id: 5, name: 'RE-5', amount_total: 250, state: 'posted' },
];
const envelope = (truncated = false): string =>
  JSON.stringify({ model: 'account.move', count: RECORDS.length, truncated, records: RECORDS });
const MAP = { id: 'id', name: 'name', amount_total: 'amount_total' };
const ids = (rows: ReadonlyArray<Record<string, unknown>> | undefined): unknown[] =>
  (rows ?? []).map((r) => r['id']);

describe('mapRefreshRecords — filter → sort → take', () => {
  const source = (over: Partial<RefreshSource>): RefreshSource => ({
    tool: 'odoo_query',
    input: {},
    itemsPath: 'records',
    map: MAP,
    rowKey: 'id',
    ...over,
  });

  it('sorts descending with a stable tie (fetch order kept) and cuts to take', () => {
    const r = mapRefreshRecords(envelope(), source({ sort: [{ field: 'amount_total', dir: 'desc' }], take: 3 }));
    assert.deepEqual(ids(r?.rows), [2, 4, 3]);
    // rows and raw records stay index-aligned
    assert.deepEqual(ids(r?.records), [2, 4, 3]);
    assert.deepEqual(
      r?.rows.map((x) => x['rowKey']),
      ['2', '4', '3'],
    );
  });

  it('applies the filter before the cut, then the secondary key on ties', () => {
    const r = mapRefreshRecords(
      envelope(),
      source({
        filter: [{ field: 'state', eq: 'posted' }],
        sort: [
          { field: 'amount_total', dir: 'desc' },
          { field: 'name', dir: 'desc' },
        ],
        take: 2,
      }),
    );
    assert.deepEqual(ids(r?.rows), [4, 3]);
  });

  it('orders like the Privacy Shield verbs: missing last ascending, first descending', () => {
    const asc = mapRefreshRecords(envelope(), source({ sort: [{ field: 'invoice_date', dir: 'asc' }] }));
    // `false` compares by its string form ("false" > "2026-…"), undefined last
    assert.deepEqual(ids(asc?.rows), [3, 4, 1, 2, 5]);
    const desc = mapRefreshRecords(envelope(), source({ sort: [{ field: 'invoice_date', dir: 'desc' }] }));
    assert.deepEqual(ids(desc?.rows), [5, 2, 1, 4, 3]);
  });

  it('a take larger than the set keeps every row; no sort keeps the fetch order', () => {
    assert.deepEqual(ids(mapRefreshRecords(envelope(), source({ take: 50 }))?.rows), [1, 2, 3, 4, 5]);
    assert.deepEqual(ids(mapRefreshRecords(envelope(), source({ take: 2 }))?.rows), [1, 2]);
  });

  it('refuses a truncated tool result under sort or take (a wrong ranking)', () => {
    assert.equal(mapRefreshRecords(envelope(true), source({ sort: [{ field: 'id', dir: 'asc' }] })), null);
    assert.equal(mapRefreshRecords(envelope(true), source({ take: 2 })), null);
    assert.ok(mapRefreshRecords(envelope(true), source({})), 'a plain recipe still maps a prefix');
    assert.equal(requiresCompleteResult(source({})), false);
    assert.equal(requiresCompleteResult(source({ take: 1 })), true);
  });

  it('fetchRecipeRows reports the refused truncated result as truncated (generic, any tool)', async () => {
    const recipe = source({ tool: 'any_list_tool', sort: [{ field: 'amount_total', dir: 'asc' }], take: 1 });
    const ok = await fetchRecipeRows(() => Promise.resolve(envelope()), recipe);
    assert.ok(ok.ok);
    assert.deepEqual(ids(ok.rows), [1]);
    const cut = await fetchRecipeRows(() => Promise.resolve(envelope(true)), recipe);
    assert.deepEqual(cut, { ok: false, reason: 'truncated' });
  });
});

