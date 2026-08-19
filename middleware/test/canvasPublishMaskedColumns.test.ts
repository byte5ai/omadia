/**
 * PR #326 — masked columns on the `canvas_publish_rows` dataset path.
 *
 * ## The defect, verified on today's `main` before anything was changed
 *
 *   - `PrivacyResolvedDataset.rows` is documented as "the full real rows,
 *     **keyed by column `path`**";
 *   - `handleCanvasPublishRows` passes them through untouched;
 *   - `composeStructuredPayloadPatch` read each cell as `row[fieldKey]` using
 *     the **skeleton's** column keys, which are the agent's naming.
 *
 * Where the agent names a column `invoice_number` and the source path is
 * Odoo's `name`, the lookup missed and the cell was silently blanked. Columns
 * that happened to use the real field name filled correctly — which is why the
 * bug presented as a partial rendering glitch rather than a mapping fault.
 *
 * ## What the fix may and may not guess
 *
 * There is **no semantic link** between an agent field key and a source path
 * anywhere in the system — `DataRequirement.fields` carries agent keys only.
 * Position is the only available correspondence, and it is a guess. So:
 *
 *   - **values** resolve by `path`, never positionally. A value in the wrong
 *     column is worse than a blank one;
 *   - **labels** are the only place the guess is taken, and only when the two
 *     column lists are the same length. Otherwise the raw path is shown, which
 *     is ugly and correct rather than pretty and wrong.
 *
 * That order dependency is pinned below, so nobody can "tidy" it away without
 * a test going red.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { composeStructuredPayloadPatch } from '../packages/omadia-ui-orchestrator/src/patchComposition.js';

/** An agent-authored skeleton: human column keys, not the source's paths. */
const INVOICE_SKELETON = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    {
      type: 'table',
      id: 'invoices',
      loading: 'skeleton',
      columns: [
        { fieldKey: 'invoice_number', label: 'Rechnungsnummer' },
        { fieldKey: 'customer_name', label: 'Kunde' },
        { fieldKey: 'due_date', label: 'Fällig am' },
        { fieldKey: 'invoice_date', label: 'Rechnungsdatum' },
        { fieldKey: 'amount_total', label: 'Betrag' },
      ],
      rows: [],
    },
  ],
};

/** A row exactly as `resolveDatasetForRender` hands it back: keyed by path. */
const RESOLVED_ROW = {
  name: 'RE-2026-0042',
  partner_id: 'Muster GmbH',
  invoice_date_due: '2026-09-01',
  invoice_date: '2026-08-01',
  amount_total: 1190.5,
};

/** …and the schema that now travels with it. */
const DATASET_COLUMNS = [
  { path: 'name', type: 'string', classification: 'sensitive-masked' },
  { path: 'partner_id', type: 'string', classification: 'sensitive-masked' },
  { path: 'invoice_date_due', type: 'date', classification: 'safe-cleartext' },
  { path: 'invoice_date', type: 'date', classification: 'safe-cleartext' },
  { path: 'amount_total', type: 'number', classification: 'safe-cleartext' },
];

type Composed = ReturnType<typeof composeStructuredPayloadPatch>;

function compose(data: Record<string, unknown>): Composed {
  return composeStructuredPayloadPatch({
    baseTree: INVOICE_SKELETON,
    payload: { prose: 'offene Debitorenrechnungen', dataRefId: 'ds-1', data },
    dataRequirements: [],
  });
}

function rowCells(patch: Composed): Record<string, unknown> {
  assert.ok(patch, 'a patch must be composed at all');
  const add = patch.patches.find(
    (op) => op.op === 'add' && String(op.path).endsWith('/rows/-'),
  ) as { value: { cells: Record<string, unknown> } } | undefined;
  assert.ok(add, 'the patch must add a row');
  return add.value.cells;
}

function columns(patch: Composed): Array<{ fieldKey: string; label: string; privacy?: string }> {
  assert.ok(patch);
  const replace = patch.patches.find(
    (op) => op.op === 'replace' && String(op.path).endsWith('/columns'),
  ) as { value: Array<{ fieldKey: string; label: string; privacy?: string }> } | undefined;
  assert.ok(replace, 'the dataset path must publish its own column list');
  return replace.value;
}

describe('PR #326 — a shielded dataset renders its values', () => {
  const patch = compose({
    containerId: 'invoices',
    rows: [RESOLVED_ROW],
    datasetColumns: DATASET_COLUMNS,
  });

  it('renders the columns the agent named differently from the source', () => {
    // The defect: these three were blank because `row['invoice_number']` and
    // friends do not exist — the row is keyed `name` / `partner_id` / …
    const cells = rowCells(patch);
    assert.equal(cells['name'], 'RE-2026-0042');
    assert.equal(cells['partner_id'], 'Muster GmbH');
    assert.equal(cells['invoice_date_due'], '2026-09-01');
  });

  it('still renders the columns that always worked', () => {
    const cells = rowCells(patch);
    assert.equal(cells['invoice_date'], '2026-08-01');
    assert.equal(cells['amount_total'], 1190.5);
  });

  it('marks the shielded columns as guard-protected', () => {
    const cols = columns(patch);
    const byKey = new Map(cols.map((c) => [c.fieldKey, c]));
    assert.equal(byKey.get('name')?.privacy, 'guard-protected');
    assert.equal(byKey.get('partner_id')?.privacy, 'guard-protected');
    // …and does NOT mark the cleartext ones, which would train the user to
    // ignore the badge.
    assert.equal(byKey.get('amount_total')?.privacy, undefined);
  });

  it('keeps the agent’s human labels', () => {
    const cols = columns(patch);
    assert.deepEqual(
      cols.map((c) => c.label),
      ['Rechnungsnummer', 'Kunde', 'Fällig am', 'Rechnungsdatum', 'Betrag'],
    );
  });
});

describe('PR #326 — what the fix refuses to guess', () => {
  it('falls back to the raw path when the column counts disagree', () => {
    // Labels are matched positionally. With a different number of columns the
    // correspondence is not merely uncertain, it is meaningless — so no label
    // is claimed at all. An ugly header beats "Kunde" over invoice numbers.
    const cols = columns(
      compose({
        containerId: 'invoices',
        rows: [RESOLVED_ROW],
        datasetColumns: DATASET_COLUMNS.slice(0, 3),
      }),
    );
    assert.deepEqual(
      cols.map((c) => c.label),
      ['name', 'partner_id', 'invoice_date_due'],
    );
  });

  it('is order-dependent for labels, by design — pinned so it cannot drift', () => {
    // Reordering the DATASET columns re-pairs the agent's labels. This test
    // exists to make that dependency explicit: it is the residual risk the
    // original PR flagged and could not remove, because no field-key↔path
    // mapping exists to remove it with.
    const swapped = [DATASET_COLUMNS[1]!, DATASET_COLUMNS[0]!, ...DATASET_COLUMNS.slice(2)];
    const cols = columns(
      compose({ containerId: 'invoices', rows: [RESOLVED_ROW], datasetColumns: swapped }),
    );
    assert.equal(cols[0]?.fieldKey, 'partner_id');
    assert.equal(cols[0]?.label, 'Rechnungsnummer', 'the label followed the POSITION, not the key');
    // The values, however, are keyed by path and stay correct — which is the
    // property that actually matters.
    assert.equal(rowCells(compose({
      containerId: 'invoices',
      rows: [RESOLVED_ROW],
      datasetColumns: swapped,
    }))['partner_id'], 'Muster GmbH');
  });

  it('leaves a plain rows publish completely untouched', () => {
    // No dataset schema ⇒ the pre-existing skeleton mapping, unchanged. This
    // is every non-shielded publish in the product.
    const patch = compose({
      containerId: 'invoices',
      rows: [{ invoice_number: 'RE-1', customer_name: 'ACME' }],
    });
    assert.ok(patch);
    assert.equal(
      patch.patches.some((op) => String(op.path).endsWith('/columns')),
      false,
      'no column rewrite without a dataset schema',
    );
    assert.equal(rowCells(patch)['invoice_number'], 'RE-1');
  });

  it('ignores a malformed schema rather than half-deriving one', () => {
    const patch = compose({
      containerId: 'invoices',
      rows: [RESOLVED_ROW],
      datasetColumns: [{ path: 'name', type: 'string' }, { type: 'string' }],
    });
    assert.ok(patch);
    assert.equal(
      patch.patches.some((op) => String(op.path).endsWith('/columns')),
      false,
      'a broken schema must not produce a partial column list',
    );
  });
});
