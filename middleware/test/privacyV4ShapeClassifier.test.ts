/**
 * Privacy Shield v4 — US2 Shape Classifier tests.
 *
 * Verifies the deny-by-default allowlist S1–S5, that unrecognized shapes are
 * masked, and that the detector booster is strictly one-way.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createShapeClassifier,
  type DetectorBooster,
} from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import type {
  DatasetRow,
  DatasetSchema,
  FieldClassification,
} from '@omadia/plugin-privacy-guard/dist/v4/types.js';

function field(schema: DatasetSchema, path: string): FieldClassification {
  const f = schema.fields.find((x) => x.path === path);
  assert.ok(f, `field "${path}" missing from schema`);
  return f;
}

function classifyRows(rows: DatasetRow[], detector?: DetectorBooster) {
  const classifier = createShapeClassifier(
    detector ? { detector } : {},
  );
  return classifier(rows, 'rows');
}

// --- safe-cleartext allowlist (S1–S5) --------------------------------------

describe('ShapeClassifier — safe-cleartext allowlist', () => {
  it('S1 — numeric fields are safe-cleartext', () => {
    const s = classifyRows([{ days: 24 }, { days: 30 }, { days: 18 }]);
    assert.equal(field(s, 'days').type, 'number');
    assert.equal(field(s, 'days').classification, 'safe-cleartext');
  });

  it('S2 — boolean fields are safe-cleartext', () => {
    const s = classifyRows([{ approved: true }, { approved: false }]);
    assert.equal(field(s, 'approved').type, 'boolean');
    assert.equal(field(s, 'approved').classification, 'safe-cleartext');
  });

  it('S3 — ISO-8601 date fields are safe-cleartext', () => {
    const s = classifyRows([
      { start: '2026-01-05' },
      { start: '2026-03-20T08:30:00Z' },
    ]);
    assert.equal(field(s, 'start').type, 'date');
    assert.equal(field(s, 'start').classification, 'safe-cleartext');
  });

  it('S4 — low-cardinality single-token enums are safe-cleartext', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      status: i % 2 === 0 ? 'approved' : 'pending',
    }));
    const s = classifyRows(rows);
    assert.equal(field(s, 'status').type, 'enum');
    assert.equal(field(s, 'status').classification, 'safe-cleartext');
  });

  it('S5 — UUID / numeric-id / alphanumeric-code fields are safe id handles', () => {
    const s = classifyRows([
      {
        uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        empno: '4471',
        sku: 'INV-2024-0093',
      },
      {
        uuid: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        empno: '5582',
        sku: 'INV-2024-0094',
      },
    ]);
    assert.equal(field(s, 'uuid').type, 'id');
    assert.equal(field(s, 'uuid').classification, 'safe-cleartext');
    assert.equal(field(s, 'empno').type, 'id');
    assert.equal(field(s, 'empno').classification, 'safe-cleartext');
    assert.equal(field(s, 'sku').type, 'id');
    assert.equal(field(s, 'sku').classification, 'safe-cleartext');
  });
});

// --- deny-by-default masking -----------------------------------------------

describe('ShapeClassifier — deny-by-default masking', () => {
  it('masks unique-per-row multi-word human names', () => {
    const s = classifyRows([
      { employee: 'Marvin Vomberg' },
      { employee: 'Anna Rüsche' },
      { employee: 'Thomas Görres' },
    ]);
    assert.equal(field(s, 'employee').type, 'string');
    assert.equal(field(s, 'employee').classification, 'sensitive-masked');
    assert.equal(field(s, 'employee').stats.uniquePerRow, true);
  });

  it('masks free text', () => {
    const s = classifyRows([
      { note: 'requested leave for a family event' },
      { note: 'sick leave, doctor note attached' },
    ]);
    assert.equal(field(s, 'note').classification, 'sensitive-masked');
  });

  it('masks a nested object/array field as unknown', () => {
    const s = classifyRows([
      { history: [{ y: 2024 }] },
      { history: [{ y: 2025 }] },
    ]);
    assert.equal(field(s, 'history').type, 'unknown');
    assert.equal(field(s, 'history').classification, 'sensitive-masked');
  });

  it('masks a mixed-type field as unknown', () => {
    const s = classifyRows([{ x: 5 }, { x: 'five' }, { x: true }]);
    assert.equal(field(s, 'x').type, 'unknown');
    assert.equal(field(s, 'x').classification, 'sensitive-masked');
  });

  it('masks an all-null / empty column as unknown', () => {
    const s = classifyRows([{ blank: null }, { blank: null }]);
    assert.equal(field(s, 'blank').type, 'unknown');
    assert.equal(field(s, 'blank').classification, 'sensitive-masked');
  });

  it('masks a high-cardinality non-token string (not an enum, not an id)', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      city: `City number ${String(i)}`,
    }));
    const s = classifyRows(rows);
    assert.equal(field(s, 'city').classification, 'sensitive-masked');
  });
});

// --- detector booster is one-way -------------------------------------------

describe('ShapeClassifier — detector booster (one-way)', () => {
  it('a detector hit forces masking of an otherwise-safe enum', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      owner: i % 2 === 0 ? 'Marvin' : 'Anna',
    }));
    // Without a detector: a single-token low-cardinality field is an enum.
    assert.equal(classifyRows(rows).fields[0]?.classification, 'safe-cleartext');
    // With an NER-style detector that flags those names: forced masked.
    const namesDetector: DetectorBooster = (v) =>
      v === 'Marvin' || v === 'Anna';
    const s = classifyRows(rows, namesDetector);
    assert.equal(field(s, 'owner').classification, 'sensitive-masked');
    assert.equal(field(s, 'owner').stats.detectorHit, true);
  });

  it('a detector miss never promotes a masked field', () => {
    const neverHits: DetectorBooster = () => false;
    const s = classifyRows(
      [{ note: 'free text one' }, { note: 'free text two' }],
      neverHits,
    );
    assert.equal(field(s, 'note').classification, 'sensitive-masked');
    assert.equal(field(s, 'note').stats.detectorHit, false);
  });
});

// --- control-flow scalars (#1097) ------------------------------------------

/**
 * #1097 defence in depth. The dispatch seams keep control-flow results out of
 * the store entirely; if one arrives by another route it must still not be
 * masked, because a masked 1×1 dataset is renderable and `v4_render_answer`
 * then materializes the failure as if it were a result.
 */
describe('ShapeClassifier — control-flow scalars (#1097)', () => {
  it('leaves a 1x1 `Error:` scalar in cleartext', () => {
    const s = classifyRows([
      { value: 'Error: embeddings not configured — use `search_turns` instead.' },
    ]);
    assert.equal(field(s, 'value').type, 'string');
    assert.equal(field(s, 'value').classification, 'safe-cleartext');
  });

  it('leaves a 1x1 MCP auth prompt in cleartext, block intact', () => {
    const s = classifyRows([
      {
        value:
          '🔒 The MCP server "Strava" needs authorization before it can be used. ' +
          '<mcp-auth-required serverId="s-1" server="Strava"></mcp-auth-required>',
      },
    ]);
    assert.equal(field(s, 'value').classification, 'safe-cleartext');
  });

  it('does NOT widen past one row — a second row masks again', () => {
    const s = classifyRows([
      { value: 'Error: one' },
      { value: 'Erika Mustermann' },
    ]);
    assert.equal(
      field(s, 'value').classification,
      'sensitive-masked',
      'the window is exactly one row — anything else is a dataset',
    );
  });

  it('does NOT widen past one field — a second column masks again', () => {
    const s = classifyRows([{ value: 'Error: one', employee: 'Erika Mustermann' }]);
    assert.equal(field(s, 'value').classification, 'sensitive-masked');
    assert.equal(field(s, 'employee').classification, 'sensitive-masked');
  });

  it('a detector hit still wins — the exemption never overrides the booster', () => {
    const detector: DetectorBooster = (v) => v.includes('@');
    const s = classifyRows(
      [{ value: 'Error: user erika.mustermann@example.com is unknown' }],
      detector,
    );
    assert.equal(field(s, 'value').stats.detectorHit, true);
    assert.equal(field(s, 'value').classification, 'sensitive-masked');
  });

  it('control — an ordinary 1x1 prose scalar stays masked', () => {
    const s = classifyRows([{ value: 'Erika Mustermann' }]);
    assert.equal(field(s, 'value').classification, 'sensitive-masked');
  });
});

// --- realistic shapes ------------------------------------------------------

describe('ShapeClassifier — realistic shapes', () => {
  it('classifies the hr.leave ranking shape correctly', () => {
    const s = classifyRows([
      { employee: 'Marvin Vomberg', employee_id: '4471', days: 24 },
      { employee: 'Anna Rüsche', employee_id: '5582', days: 30 },
      { employee: 'Thomas Görres', employee_id: '6693', days: 18 },
    ]);
    assert.equal(field(s, 'employee').classification, 'sensitive-masked');
    assert.equal(field(s, 'employee_id').classification, 'safe-cleartext');
    assert.equal(field(s, 'days').classification, 'safe-cleartext');
  });

  it('produces an empty field list for an empty dataset', () => {
    const s = classifyRows([]);
    assert.equal(s.fields.length, 0);
    assert.equal(s.rowCount, 0);
  });
});
