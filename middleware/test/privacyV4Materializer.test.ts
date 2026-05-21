/**
 * Privacy Shield v4 — US6 Materializer tests.
 *
 * The Materializer renders the final answer server-side from the real dataset
 * — real values, including masked-classified columns, for the authenticated
 * user. Includes the end-to-end data path: intern → verb chain → materialize.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { createVerbEngine } from '@omadia/plugin-privacy-guard/dist/v4/verbs/index.js';
import {
  MaterializerError,
  materialize,
} from '@omadia/plugin-privacy-guard/dist/v4/materializer.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', days: 24 },
  { employee: 'Anna Rüsche', days: 30 },
  { employee: 'Thomas Görres', days: 18 },
];

function harness() {
  const classify = createShapeClassifier();
  const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
  const engine = createVerbEngine({ store, classify });
  return { store, engine };
}

describe('Materializer — formats', () => {
  it('renders a Markdown table with real values', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text, rowCount } = materialize(store, {
      datasetId,
      columns: ['employee', 'days'],
      format: 'table',
    });
    assert.equal(rowCount, 3);
    assert.ok(text.includes('| employee | days |'));
    assert.ok(text.includes('Marvin Vomberg'));
    assert.ok(text.includes('Anna Rüsche'));
  });

  it('renders a list', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text } = materialize(store, {
      datasetId,
      columns: ['employee', 'days'],
      format: 'list',
    });
    assert.ok(text.includes('- employee: Marvin Vomberg, days: 24'));
  });

  it('renders a scalar', () => {
    const { store, engine } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const counted = engine.count(datasetId);
    const { text } = materialize(store, {
      datasetId: counted.datasetId,
      columns: ['count'],
      format: 'scalar',
    });
    assert.equal(text, '3');
  });

  it('prepends PII-free prose when provided', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text } = materialize(store, {
      datasetId,
      columns: ['employee'],
      format: 'list',
      prose: 'Hier ist das Urlaubsranking:',
    });
    assert.ok(text.startsWith('Hier ist das Urlaubsranking:\n\n'));
  });

  it('renders "(no rows)" for an empty dataset', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', []);
    const { text, rowCount } = materialize(store, {
      datasetId,
      columns: ['employee'],
      format: 'table',
    });
    assert.equal(rowCount, 0);
    assert.ok(text.includes('(no rows)'));
  });
});

describe('Materializer — end-to-end data path', () => {
  it('intern → sort → top_n → materialize yields a correct ranked answer', () => {
    const { store, engine } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const sorted = engine.sort(datasetId, 'days', 'desc');
    const top = engine.topN(sorted.datasetId, 2, 'days', 'desc');
    const { text } = materialize(store, {
      datasetId: top.datasetId,
      columns: ['employee', 'days'],
      format: 'table',
    });
    // Real, complete names in correct rank order — Anna (30) before Marvin (24).
    assert.ok(text.indexOf('Anna Rüsche') < text.indexOf('Marvin Vomberg'));
    assert.ok(!text.includes('Thomas Görres'), 'top_n=2 dropped the 3rd row');
  });
});

describe('Materializer — guard rails', () => {
  it('rejects an unknown datasetId', () => {
    const { store } = harness();
    assert.throws(
      () =>
        materialize(store, {
          datasetId: 'ds_missing',
          columns: ['employee'],
          format: 'table',
        }),
      MaterializerError,
    );
  });

  it('rejects an unknown column', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    assert.throws(
      () =>
        materialize(store, {
          datasetId,
          columns: ['salary'],
          format: 'table',
        }),
      MaterializerError,
    );
  });
});
