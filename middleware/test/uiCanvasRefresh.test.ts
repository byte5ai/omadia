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
