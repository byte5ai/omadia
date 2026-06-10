/**
 * omadia-ui#5 — deterministic refresh building blocks.
 *
 *   - deriveDataRequirements: the tree's own tables/charts ARE the field
 *     contract (no LLM); nested containers are found, `scope` narrows;
 *   - composeStructuredPayloadPatch with `refreshContainers`: the FIRST
 *     publish per container REPLACES the stale rows (consumed set), the
 *     second publish appends onto the fresh data again.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { composeStructuredPayloadPatch } from '../packages/omadia-ui-orchestrator/src/patchComposition.js';
import { deriveDataRequirements } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import {
  applyRefreshSource,
  createRecipeStore,
  parseRefreshSource,
} from '../packages/omadia-ui-orchestrator/src/refreshRecipes.js';

const LIVE_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'h', content: 'Stornos 2026', level: 2 },
    {
      type: 'table',
      id: 'cleanup_table',
      columns: [
        { fieldKey: 'name', label: 'Rechnung' },
        { fieldKey: 'amount', label: 'Betrag' },
      ],
      rows: [
        { rowKey: 'old-1', cells: { name: 'GUTSCHRIFT alt', amount: '1' } },
        { rowKey: 'old-2', cells: { name: 'GUTSCHRIFT alt 2', amount: '2' } },
      ],
    },
    {
      type: 'chart',
      id: 'monthly_chart',
      chartType: 'bar',
      points: [{ pointKey: 'p0', label: 'Jan', value: 10 }],
    },
  ],
};

describe('deriveDataRequirements', () => {
  it('derives requirements from the tree itself (tables and charts)', () => {
    const reqs = deriveDataRequirements(LIVE_TREE);
    assert.deepEqual(
      reqs.map((r) => r.containerId),
      ['cleanup_table', 'monthly_chart'],
    );
    const table = reqs[0];
    assert.deepEqual(table?.fields, [
      { fieldKey: 'name', label: 'Rechnung' },
      { fieldKey: 'amount', label: 'Betrag' },
    ]);
  });

  it('scope narrows to a single container', () => {
    const reqs = deriveDataRequirements(LIVE_TREE, 'monthly_chart');
    assert.deepEqual(
      reqs.map((r) => r.containerId),
      ['monthly_chart'],
    );
  });

  it('returns [] for a tree without data containers', () => {
    assert.deepEqual(
      deriveDataRequirements({ type: 'container', id: 'r', children: [] }),
      [],
    );
  });
});

describe('composeStructuredPayloadPatch — refreshContainers', () => {
  const requirements = deriveDataRequirements(LIVE_TREE);

  it('first publish REPLACES the stale rows, second batch appends again', () => {
    const refreshContainers = new Set(['cleanup_table', 'monthly_chart']);
    const first = composeStructuredPayloadPatch({
      baseTree: LIVE_TREE,
      payload: {
        prose: 'fresh',
        dataRefId: 'refresh-1',
        data: {
          containerId: 'cleanup_table',
          rows: [{ rowKey: 'new-1', name: 'GUTSCHRIFT neu', amount: '3' }],
        },
      },
      dataRequirements: requirements,
      refreshContainers,
    });
    assert.ok(first);
    const replaceOp = first.patches.find((p) => p.path.endsWith('/rows'));
    assert.ok(replaceOp, 'expected a whole-rows replace op');
    assert.equal(replaceOp.op, 'replace');
    assert.equal((replaceOp.value as unknown[]).length, 1);
    // the set is consumed — cleanup_table no longer marked for replace
    assert.equal(refreshContainers.has('cleanup_table'), false);
    assert.equal(refreshContainers.has('monthly_chart'), true);

    const second = composeStructuredPayloadPatch({
      baseTree: first.nextTree,
      payload: {
        prose: 'batch 2',
        dataRefId: 'refresh-2',
        data: {
          containerId: 'cleanup_table',
          rows: [{ rowKey: 'new-2', name: 'GUTSCHRIFT neu 2', amount: '4' }],
        },
      },
      dataRequirements: requirements,
      refreshContainers,
    });
    assert.ok(second);
    assert.ok(
      second.patches.every((p) => !(p.op === 'replace' && p.path.endsWith('/rows'))),
      'second batch must append, not replace',
    );
    const tableNode = JSON.stringify(second.nextTree);
    assert.ok(tableNode.includes('new-1') && tableNode.includes('new-2'));
    assert.ok(!tableNode.includes('old-1'), 'stale rows must be gone after refresh');
  });

  it('chart refresh replaces the points array', () => {
    const refreshContainers = new Set(['monthly_chart']);
    const composed = composeStructuredPayloadPatch({
      baseTree: LIVE_TREE,
      payload: {
        prose: 'chart',
        dataRefId: 'refresh-3',
        data: {
          containerId: 'monthly_chart',
          rows: [
            { label: 'Jan', value: 12 },
            { label: 'Feb', value: 7 },
          ],
        },
      },
      dataRequirements: requirements,
      refreshContainers,
    });
    assert.ok(composed);
    const replaceOp = composed.patches.find((p) => p.path.endsWith('/points'));
    assert.ok(replaceOp, 'expected a whole-points replace op');
    assert.equal(replaceOp.op, 'replace');
    assert.equal((replaceOp.value as unknown[]).length, 2);
    assert.ok(!JSON.stringify(composed.nextTree).includes('"p0"'));
  });

  it('without refreshContainers the behaviour is unchanged (append)', () => {
    const composed = composeStructuredPayloadPatch({
      baseTree: LIVE_TREE,
      payload: {
        prose: 'x',
        dataRefId: 'append-1',
        data: {
          containerId: 'cleanup_table',
          rows: [{ rowKey: 'new-1', name: 'N', amount: '3' }],
        },
      },
      dataRequirements: requirements,
    });
    assert.ok(composed);
    assert.ok(composed.patches.some((p) => p.op === 'add' && p.path.endsWith('/rows/-')));
  });
});

describe('refresh recipes (LLM-free path)', () => {
  it('parseRefreshSource whitelists shape and drops junk', () => {
    const ok = parseRefreshSource({
      tool: 'dynamics_fetchxml',
      input: { fetchXml: '<fetch>…next-week…</fetch>' },
      map: { name: 'ud_name', amount: 'totalamount', junk: 42 },
      rowKey: 'invoiceid',
    });
    assert.ok(ok);
    assert.equal(ok.tool, 'dynamics_fetchxml');
    assert.deepEqual(ok.map, { name: 'ud_name', amount: 'totalamount' });
    assert.equal(ok.rowKey, 'invoiceid');
    assert.equal(parseRefreshSource({ tool: 'x' }), null); // no map
    assert.equal(parseRefreshSource({ map: { a: 'b' } }), null); // no tool
    assert.equal(parseRefreshSource('nope'), null);
  });

  it('applyRefreshSource maps OData-style output (first array, rowKey, null→empty)', () => {
    const source = parseRefreshSource({
      tool: 't',
      map: { name: 'ud_name', amount: 'totalamount' },
      rowKey: 'invoiceid',
    });
    assert.ok(source);
    const raw = JSON.stringify({
      '@odata.context': 'ctx',
      value: [
        { invoiceid: 'a-1', ud_name: 'GUTSCHRIFT 1', totalamount: 99.5, noise: true },
        { invoiceid: 'a-2', ud_name: null, totalamount: 12 },
      ],
    });
    assert.deepEqual(applyRefreshSource(raw, source), [
      { name: 'GUTSCHRIFT 1', amount: 99.5, rowKey: 'a-1' },
      { name: '', amount: 12, rowKey: 'a-2' },
    ]);
  });

  it('applyRefreshSource follows itemsPath and refuses wrong shapes', () => {
    const source = parseRefreshSource({ tool: 't', itemsPath: 'data.records', map: { v: 'val' } });
    assert.ok(source);
    assert.deepEqual(
      applyRefreshSource(JSON.stringify({ data: { records: [{ val: 1 }] } }), source),
      [{ v: 1 }],
    );
    // empty result set is a VALID refresh (table empties)
    assert.deepEqual(
      applyRefreshSource(JSON.stringify({ data: { records: [] } }), source),
      [],
    );
    // no mapped attribute present → wrong shape, refuse (agent fallback)
    assert.equal(
      applyRefreshSource(JSON.stringify({ data: { records: [{ other: 1 }] } }), source),
      null,
    );
    assert.equal(applyRefreshSource('not json', source), null);
    assert.equal(applyRefreshSource(JSON.stringify({ data: {} }), source), null);
  });

  it('recipe store keys by canvas session and container', () => {
    const store = createRecipeStore();
    const src = parseRefreshSource({ tool: 't', map: { a: 'b' } });
    assert.ok(src);
    store.set('sess-1', 'table-1', src);
    assert.equal(store.get('sess-1', 'table-1'), src);
    assert.equal(store.get('sess-1', 'other'), undefined);
    assert.equal(store.get('sess-2', 'table-1'), undefined);
  });
});
