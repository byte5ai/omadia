/**
 * Privacy Shield v4 — US5 verb tool-surface tests.
 *
 * Covers the LLM-facing tool dispatch: the verb tool specs, robust parsing of
 * untrusted LLM input, routing to the engine, and the render-directive parser.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import {
  VerbError,
  createVerbEngine,
} from '@omadia/plugin-privacy-guard/dist/v4/verbs/index.js';
import {
  RENDER_TOOL_SPEC,
  VERB_TOOL_SPECS,
  dispatchVerbCall,
  isVerbToolName,
  parseRenderDirective,
} from '@omadia/plugin-privacy-guard/dist/v4/toolDefs.js';

const ROWS = Array.from({ length: 12 }, (_, i) => ({
  employee_id: String(1000 + (i % 3)),
  days: (i % 3) + 1,
}));

function harness() {
  const classify = createShapeClassifier();
  const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
  const engine = createVerbEngine({ store, classify });
  const { datasetId: src } = store.internToolResult('hr.leave', ROWS);
  return { store, engine, src };
}

describe('v4 tool specs', () => {
  it('exposes 8 verb tools, all v4_-prefixed', () => {
    assert.equal(VERB_TOOL_SPECS.length, 8);
    for (const spec of VERB_TOOL_SPECS) {
      assert.ok(spec.name.startsWith('v4_'));
      assert.ok(spec.description.length > 0);
      assert.equal(spec.inputSchema.type, 'object');
      assert.ok(isVerbToolName(spec.name));
    }
    assert.equal(isVerbToolName(RENDER_TOOL_SPEC.name), false);
    assert.equal(isVerbToolName('some_other_tool'), false);
  });
});

describe('dispatchVerbCall — routing', () => {
  it('routes v4_count', () => {
    const { store, engine, src } = harness();
    const r = dispatchVerbCall(engine, 'v4_count', { datasetId: src });
    assert.equal(store.get(r.datasetId)?.rows[0]?.count, 12);
  });

  it('routes v4_sort with a direction', () => {
    const { store, engine, src } = harness();
    const r = dispatchVerbCall(engine, 'v4_sort', {
      datasetId: src,
      by: 'days',
      direction: 'desc',
    });
    assert.equal(store.get(r.datasetId)?.rows[0]?.days, 3);
  });

  it('routes v4_top_n', () => {
    const { store, engine, src } = harness();
    const r = dispatchVerbCall(engine, 'v4_top_n', {
      datasetId: src,
      n: 4,
      by: 'days',
      direction: 'desc',
    });
    assert.equal(store.get(r.datasetId)?.rows.length, 4);
  });

  it('routes v4_aggregate with groupBy', () => {
    const { store, engine, src } = harness();
    const r = dispatchVerbCall(engine, 'v4_aggregate', {
      datasetId: src,
      groupBy: ['employee_id'],
      ops: [{ alias: 'total', fn: 'sum', field: 'days' }],
    });
    assert.equal(store.get(r.datasetId)?.rows.length, 3);
  });

  it('routes v4_filter with a predicate', () => {
    const { store, engine, src } = harness();
    const r = dispatchVerbCall(engine, 'v4_filter', {
      datasetId: src,
      predicate: { op: 'gte', field: 'days', value: 3 },
    });
    assert.equal(store.get(r.datasetId)?.rows.length, 4);
  });
});

describe('dispatchVerbCall — rejects malformed input', () => {
  it('rejects a missing datasetId', () => {
    const { engine } = harness();
    assert.throws(
      () => dispatchVerbCall(engine, 'v4_count', {}),
      VerbError,
    );
  });

  it('rejects an invalid sort direction', () => {
    const { engine, src } = harness();
    assert.throws(
      () =>
        dispatchVerbCall(engine, 'v4_sort', {
          datasetId: src,
          by: 'days',
          direction: 'sideways',
        }),
      VerbError,
    );
  });

  it('rejects an unknown verb tool', () => {
    const { engine } = harness();
    assert.throws(
      () => dispatchVerbCall(engine, 'v4_bogus', {}),
      VerbError,
    );
  });
});

describe('parseRenderDirective', () => {
  it('parses a valid directive', () => {
    const d = parseRenderDirective({
      datasetId: 'ds_1',
      columns: ['employee', 'days'],
      format: 'table',
      prose: 'Ranking:',
    });
    assert.equal(d.datasetId, 'ds_1');
    // Bare-string columns normalize to RenderColumns — label defaults to field.
    assert.deepEqual(d.columns, [
      { field: 'employee', label: 'employee' },
      { field: 'days', label: 'days' },
    ]);
    assert.equal(d.format, 'table');
    assert.equal(d.prose, 'Ranking:');
  });

  it('parses {field,label} columns and rankColumn', () => {
    const d = parseRenderDirective({
      datasetId: 'ds_1',
      columns: [
        { field: 'employee_id', label: 'Mitarbeiter' },
        { field: 'total' },
      ],
      format: 'table',
      rankColumn: 'Rang',
    });
    // An explicit label is kept; an omitted label falls back to the field.
    assert.deepEqual(d.columns, [
      { field: 'employee_id', label: 'Mitarbeiter' },
      { field: 'total', label: 'total' },
    ]);
    assert.equal(d.rankColumn, 'Rang');
  });

  it('rejects an invalid format', () => {
    assert.throws(
      () =>
        parseRenderDirective({
          datasetId: 'ds_1',
          columns: ['a'],
          format: 'xml',
        }),
      VerbError,
    );
  });

  it('rejects a missing datasetId', () => {
    assert.throws(
      () => parseRenderDirective({ columns: ['a'], format: 'table' }),
      VerbError,
    );
  });
});
