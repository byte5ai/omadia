/**
 * Agent-filled canvas tables (datasetId publishes):
 *   1. human column headers — a column the agent gave no label gets the
 *      catalog label of the dataset's Odoo model in the canvas language
 *      (German default), else the humanised path — never the raw key;
 *   2. sorted / top-N datasets get a refresh recipe — RefreshSource carries an
 *      optional post-fetch `sort` + `take` (generic, every tool), the Privacy
 *      Shield's `sort` / `top_n` verbs map onto it and a replay reproduces the
 *      published rows in the published order.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyDatasetProvenance } from '../packages/plugin-api/src/index.js';
import {
  MAX_RECIPE_TAKE,
  mapRefreshRecords,
  parseRefreshSource,
  requiresCompleteResult,
  type RefreshSource,
} from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { fetchRecipeRows } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { deriveDatasetRecipe } from '../packages/omadia-ui-orchestrator/src/datasetRecipe.js';
import { withDefaultColumnLabels } from '../packages/omadia-ui-orchestrator/src/datasetColumnLabels.js';
import { composeStructuredPayloadPatch } from '../packages/omadia-ui-orchestrator/src/patchComposition.js';
import { handleCanvasPublishRows } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

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

// ── 2. deriveDatasetRecipe: sort / top_n verbs ──────────────────────────────

const QUERY = { model: 'account.move', domain: [], fields: ['name', 'amount_total', 'state'], limit: 100 };
const prov = (verbs: PrivacyDatasetProvenance['verbs']): PrivacyDatasetProvenance => ({
  tool: 'odoo_query',
  input: QUERY,
  verbs,
  truncated: false,
});
const PATHS = ['id', 'name', 'amount_total'];

describe('deriveDatasetRecipe — sort / top_n', () => {
  it('sort → recipe sort (verb default asc); top_n → sort + take (verb default desc)', () => {
    const s = deriveDatasetRecipe(prov([{ verb: 'sort', args: { by: 'name' } }]), PATHS);
    assert.ok(s.ok);
    assert.deepEqual(s.source.sort, [{ field: 'name', dir: 'asc' }]);
    assert.equal(s.source.take, undefined);
    const t = deriveDatasetRecipe(prov([{ verb: 'top_n', args: { n: 5, by: 'amount_total' } }]), PATHS);
    assert.ok(t.ok);
    assert.deepEqual(t.source.sort, [{ field: 'amount_total', dir: 'desc' }]);
    assert.equal(t.source.take, 5);
  });

  it('a later sort becomes the primary key; the same field is not repeated', () => {
    const r = deriveDatasetRecipe(
      prov([
        { verb: 'sort', args: { by: 'name', direction: 'desc' } },
        { verb: 'filter', args: { predicate: { op: 'eq', field: 'state', value: 'posted' } } },
        { verb: 'sort', args: { by: 'amount_total', direction: 'asc' } },
        { verb: 'select', args: { columns: PATHS } },
        { verb: 'top_n', args: { n: 3, by: 'amount_total', direction: 'desc' } },
      ]),
      PATHS,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.source.filter, [{ field: 'state', eq: 'posted' }]);
    assert.deepEqual(r.source.sort, [
      { field: 'amount_total', dir: 'desc' },
      { field: 'name', dir: 'desc' },
    ]);
    assert.equal(r.source.take, 3);
  });

  it('skips what filter → sort → take cannot express', () => {
    const reason = (verbs: PrivacyDatasetProvenance['verbs']): string => {
      const r = deriveDatasetRecipe(prov(verbs), PATHS);
      return r.ok ? 'ok' : r.reason;
    };
    const top = { verb: 'top_n', args: { n: 3, by: 'amount_total' } };
    assert.equal(
      reason([top, { verb: 'filter', args: { predicate: { op: 'eq', field: 'state', value: 'posted' } } }]),
      'verb-filter-after-top_n',
    );
    assert.equal(reason([top, { verb: 'sort', args: { by: 'name' } }]), 'verb-sort-after-top_n');
    assert.equal(reason([top, top]), 'verb-top_n-after-top_n');
    assert.equal(reason([top, { verb: 'select', args: { columns: PATHS } }]), 'ok');
    assert.equal(reason([{ verb: 'top_n', args: { n: 0, by: 'id' } }]), 'top_n-unsupported');
    assert.equal(reason([{ verb: 'top_n', args: { n: 2.5, by: 'id' } }]), 'top_n-unsupported');
    assert.equal(reason([{ verb: 'top_n', args: { n: MAX_RECIPE_TAKE + 1, by: 'id' } }]), 'invalid-recipe');
    assert.equal(reason([{ verb: 'sort', args: { by: '' } }]), 'sort-unsupported');
    assert.equal(reason([{ verb: 'sort', args: { by: 'id', direction: 'up' } }]), 'sort-unsupported');
    assert.equal(
      reason(['a', 'b', 'c', 'd'].map((by) => ({ verb: 'sort', args: { by } }))),
      'sort-unsupported',
    );
    assert.equal(reason([{ verb: 'aggregate', args: {} }]), 'verb-aggregate');
    assert.equal(reason([{ verb: 'join', args: {} }]), 'verb-join');
  });

  it('end-to-end: the real Privacy Shield verbs and the derived replay give the same rows', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 'sorted';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'odoo_query',
      rawResult: envelope(),
      toolInput: QUERY,
    });
    const run = async (toolName: string, input: Record<string, unknown>): Promise<string> => {
      const out = await svc.runV4Tool({ sessionId: 's', turnId, toolName, input });
      const text = out.resultText;
      return (JSON.parse(text.slice(text.indexOf('{'))) as { datasetId: string }).datasetId;
    };
    const sorted = await run('v4_sort', { datasetId: interned.datasetId, by: 'id', direction: 'desc' });
    const top = await run('v4_top_n', { datasetId: sorted, n: 3, by: 'amount_total' });
    const resolved = svc.resolveDatasetForRender?.(turnId, top);
    assert.ok(resolved);
    const paths = resolved.columns.map((c) => c.path);
    const derived = deriveDatasetRecipe(svc.datasetProvenance?.(turnId, top), paths);
    assert.ok(derived.ok, derived.ok ? '' : derived.reason);
    assert.deepEqual(derived.source.sort, [
      { field: 'amount_total', dir: 'desc' },
      { field: 'id', dir: 'desc' },
    ]);
    const replayed = mapRefreshRecords(envelope(), derived.source);
    assert.deepEqual(ids(replayed?.rows), ids(resolved.rows));
    assert.deepEqual(ids(resolved.rows), [4, 2, 3]);
  });
});

// ── 1. human column headers ─────────────────────────────────────────────────

const EMP_COLUMNS = [
  { path: 'id', type: 'number' },
  { path: 'name', type: 'string', classification: 'sensitive-masked' as const },
  { path: 'job_title', type: 'string' },
  { path: 'work_email', type: 'string', classification: 'sensitive-masked' as const },
  { path: 'active', type: 'boolean' },
  { path: 'x_custom_field', type: 'string' },
];
const EMP_RESOLVED = { rowCount: 0, columns: EMP_COLUMNS, rows: [] };
const EMP_PROV: PrivacyDatasetProvenance = {
  tool: 'odoo_query',
  input: { model: 'hr.employee', domain: [], fields: ['name'] },
  verbs: [],
  truncated: false,
};
const labelsOf = (cols: ReadonlyArray<{ defaultLabel?: string }>): Array<string | undefined> =>
  cols.map((c) => c.defaultLabel);

describe('withDefaultColumnLabels', () => {
  it('catalog labels of the provenance model, German by default; humanised otherwise', () => {
    const r = withDefaultColumnLabels(EMP_RESOLVED, EMP_PROV);
    assert.deepEqual(labelsOf(r.columns), ['ID', 'Name', 'Position', 'E-Mail', 'Aktiv', 'X custom field']);
    // the column itself is untouched otherwise, the input not mutated
    assert.equal(r.columns[1]?.classification, 'sensitive-masked');
    assert.equal((EMP_COLUMNS[2] as { defaultLabel?: string }).defaultLabel, undefined);
  });

  it('English on request; no provenance / no model → humanised path', () => {
    assert.deepEqual(labelsOf(withDefaultColumnLabels(EMP_RESOLVED, EMP_PROV, 'en').columns).slice(2, 5), [
      'Job title',
      'Email',
      'Active',
    ]);
    assert.deepEqual(labelsOf(withDefaultColumnLabels(EMP_RESOLVED, undefined).columns).slice(2, 4), [
      'Job title',
      'Work email',
    ]);
    const noModel = { ...EMP_PROV, input: { query: 'x' } };
    assert.equal(withDefaultColumnLabels(EMP_RESOLVED, noModel).columns[2]?.defaultLabel, 'Job title');
  });
});

const SKELETON = (columns: Array<{ fieldKey: string; label: string }>): Record<string, unknown> => ({
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [{ type: 'table', id: 'employees', loading: 'skeleton', columns, rows: [] }],
});

async function publishedColumns(
  skeletonColumns: Array<{ fieldKey: string; label: string }>,
): Promise<Array<{ fieldKey: string; label: string }>> {
  const out = await handleCanvasPublishRows({ containerId: 'employees', datasetId: 'ds_emp' }, (id) =>
    id === 'ds_emp' ? withDefaultColumnLabels(EMP_RESOLVED, EMP_PROV) : undefined,
  );
  const payload = (JSON.parse(out) as { _pendingStructuredPayload: { prose: string; dataRefId: string; data: unknown } })
    ._pendingStructuredPayload;
  const composed = composeStructuredPayloadPatch({ baseTree: SKELETON(skeletonColumns), payload, dataRequirements: [] });
  assert.ok(composed);
  const replace = composed.patches.find((op) => op.op === 'replace' && String(op.path).endsWith('/columns')) as
    | { value: Array<{ fieldKey: string; label: string }> }
    | undefined;
  assert.ok(replace);
  return replace.value;
}

describe('agent dataset publish → table headers', () => {
  it('column counts disagree → the default labels, not the raw paths', async () => {
    const cols = await publishedColumns([
      { fieldKey: 'employee', label: 'Mitarbeiter' },
      { fieldKey: 'role', label: 'Rolle' },
    ]);
    assert.deepEqual(
      cols.map((c) => c.fieldKey),
      EMP_COLUMNS.map((c) => c.path),
      'columns stay keyed by path',
    );
    assert.deepEqual(
      cols.map((c) => c.label),
      ['ID', 'Name', 'Position', 'E-Mail', 'Aktiv', 'X custom field'],
    );
  });

  it("the agent's own labels still win; one that only echoes the path does not", async () => {
    const cols = await publishedColumns([
      { fieldKey: 'id', label: 'Nr.' },
      { fieldKey: 'employee', label: 'Mitarbeiter' },
      { fieldKey: 'job_title', label: 'job_title' },
      { fieldKey: 'mail', label: 'Mail' },
      { fieldKey: 'active', label: ' ' },
      { fieldKey: 'x', label: 'Feld X' },
    ]);
    assert.deepEqual(
      cols.map((c) => c.label),
      ['Nr.', 'Mitarbeiter', 'Position', 'Mail', 'Aktiv', 'Feld X'],
    );
  });

  it('a publish without default labels keeps the raw-path fallback (older payloads)', () => {
    const composed = composeStructuredPayloadPatch({
      baseTree: SKELETON([{ fieldKey: 'employee', label: 'Mitarbeiter' }]),
      payload: {
        prose: 'x',
        dataRefId: 'd',
        data: { containerId: 'employees', rows: [], datasetColumns: EMP_COLUMNS.slice(0, 2) },
      },
      dataRequirements: [],
    });
    const replace = composed?.patches.find((op) => String(op.path).endsWith('/columns')) as
      | { value: Array<{ label: string }> }
      | undefined;
    assert.deepEqual(
      replace?.value.map((c) => c.label),
      ['id', 'name'],
    );
  });
});
