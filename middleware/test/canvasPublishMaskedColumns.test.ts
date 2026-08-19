/**
 * PR #326 — step 1: does the defect still exist on today's `main`?
 *
 * The claim, from June: result tables on Privacy-Shield turns render **empty
 * cells** for masked columns. The diagnosed cause was not the renderer but a
 * key mismatch on the `canvas_publish_rows` + server-resolved `datasetId`
 * path:
 *
 *   - `PrivacyResolvedDataset.rows` is documented as "the full real rows,
 *     **keyed by column `path`**" (`plugin-api/privacyReceipt.ts`);
 *   - `handleCanvasPublishRows` passes those rows through untouched
 *     (`rows = resolved.rows.map((r) => ({ ...r }))`);
 *   - `composeStructuredPayloadPatch` then reads each cell as `row[fieldKey]`
 *     using the **skeleton's** own column keys.
 *
 * When the agent's skeleton names a column `invoice_number` and the dataset
 * path is Odoo's `name`, the lookup misses and the cell silently becomes `''`.
 * Columns that happen to use the real field name fill correctly, which is why
 * the bug looked partial in production rather than total.
 *
 * This test asserts the CURRENT behaviour. It passing means the defect is
 * still live and the PR's diagnosis holds on v4; it is written so that a fix
 * turns it red at the exact assertion that describes the damage.
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
        // These three are the agent's own naming …
        { fieldKey: 'invoice_number', label: 'Rechnungsnummer' },
        { fieldKey: 'customer_name', label: 'Kunde' },
        { fieldKey: 'due_date', label: 'Fällig am' },
        // … while these two happen to match the source field names.
        { fieldKey: 'invoice_date', label: 'Rechnungsdatum' },
        { fieldKey: 'amount_total', label: 'Betrag' },
      ],
      rows: [],
    },
  ],
};

/**
 * A row exactly as `resolveDatasetForRender` hands it back: keyed by the
 * dataset's column `path`s (Odoo's field names), carrying the real — masked —
 * values.
 */
const RESOLVED_ROW = {
  name: 'RE-2026-0042',
  partner_id: 'Muster GmbH',
  invoice_date_due: '2026-09-01',
  invoice_date: '2026-08-01',
  amount_total: 1190.5,
};

function tableFromPatch(patch: ReturnType<typeof composeStructuredPayloadPatch>): {
  cells: Record<string, unknown>;
} {
  assert.ok(patch, 'a patch must be composed at all');
  const addRow = patch.patches.find(
    (op) => op.op === 'add' && String(op.path).endsWith('/rows/-'),
  ) as { value: { cells: Record<string, unknown> } } | undefined;
  assert.ok(addRow, 'the patch must add a row');
  return addRow.value;
}

describe('PR #326 — masked columns on the canvas_publish_rows dataset path', () => {
  it('renders cells whose key matches the source field name', () => {
    // The half that always worked, and the reason the defect reads as a
    // rendering glitch rather than a mapping bug.
    const row = tableFromPatch(
      composeStructuredPayloadPatch({
        baseTree: INVOICE_SKELETON,
        payload: {
          prose: 'offene Debitorenrechnungen',
          dataRefId: 'ds-1',
          data: { containerId: 'invoices', rows: [RESOLVED_ROW] },
        },
        dataRequirements: [],
      }),
    );
    assert.equal(row.cells['invoice_date'], '2026-08-01');
    assert.equal(row.cells['amount_total'], 1190.5);
  });

  it('LEAVES THE MASKED COLUMNS EMPTY — the defect, still live', () => {
    // The three agent-named columns carry real values in the resolved row,
    // under the dataset's own paths. The lookup misses and the cell is
    // silently blanked rather than skipped, so the table renders as if the
    // data did not exist.
    const row = tableFromPatch(
      composeStructuredPayloadPatch({
        baseTree: INVOICE_SKELETON,
        payload: {
          prose: 'offene Debitorenrechnungen',
          dataRefId: 'ds-1',
          data: { containerId: 'invoices', rows: [RESOLVED_ROW] },
        },
        dataRequirements: [],
      }),
    );

    assert.equal(row.cells['invoice_number'], '', 'RE-2026-0042 is lost');
    assert.equal(row.cells['customer_name'], '', 'Muster GmbH is lost');
    assert.equal(row.cells['due_date'], '', '2026-09-01 is lost');

    // And the values ARE present in the payload — nothing was withheld
    // upstream, the mapping simply cannot find them.
    assert.equal(RESOLVED_ROW.name, 'RE-2026-0042');
    assert.equal(RESOLVED_ROW.partner_id, 'Muster GmbH');
  });

  it('carries no privacy marking on the column either', () => {
    // The second half of the PR's claim: even where a cell IS blank because
    // the value is shielded, nothing tells the client to show a guard badge.
    // `patchComposition`'s column type is `{ fieldKey, label }` — there is no
    // field to carry it.
    const patch = composeStructuredPayloadPatch({
      baseTree: INVOICE_SKELETON,
      payload: {
        prose: 'offene Debitorenrechnungen',
        dataRefId: 'ds-1',
        data: { containerId: 'invoices', rows: [RESOLVED_ROW] },
      },
      dataRequirements: [],
    });
    assert.ok(patch);
    assert.ok(
      !JSON.stringify(patch).includes('guard-protected'),
      'no privacy marking reaches the client today',
    );
  });
});
