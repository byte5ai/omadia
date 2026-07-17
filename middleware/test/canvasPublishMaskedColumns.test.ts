import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseToolEmittedStructuredPayload } from '../packages/harness-orchestrator/src/canvasSentinels.js';
import { composeStructuredPayloadPatch } from '../packages/omadia-ui-orchestrator/src/patchComposition.js';
import { handleCanvasPublishRows } from '../packages/omadia-ui-orchestrator/src/plugin.js';

describe('canvas_publish_rows datasetId publishes with masked columns', () => {
  it('replaces skeleton field keys with dataset paths, preserves labels by position, and carries privacy badges', async () => {
    const out = await handleCanvasPublishRows(
      {
        containerId: 'invoices',
        datasetId: 'ds_invoices',
      },
      (datasetId) =>
        datasetId === 'ds_invoices'
          ? {
              rowCount: 1,
              columns: [
                { path: 'name', type: 'string', classification: 'safe-cleartext' as const },
                {
                  path: 'partner_id',
                  type: 'string',
                  classification: 'sensitive-masked' as const,
                },
                {
                  path: 'invoice_date_due',
                  type: 'date',
                  classification: 'safe-cleartext' as const,
                },
                { path: 'a.b.c', type: 'string', classification: 'safe-cleartext' as const },
              ],
              rows: [
                {
                  name: 'INV-001',
                  partner_id: 'Marvin Vomberg',
                  invoice_date_due: '2026-06-17',
                  'a.b.c': 'Extra column',
                },
              ],
            }
          : undefined,
    );
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload, 'dataset publish emits a structured payload sentinel');
    assert.deepEqual((payload.data as { columns?: unknown }).columns, [
      { fieldKey: 'name', label: 'Name' },
      { fieldKey: 'partner_id', label: 'Partner Id', privacy: 'guard-protected' },
      { fieldKey: 'invoice_date_due', label: 'Invoice Date Due' },
      { fieldKey: 'a.b.c', label: 'A B C' },
    ]);

    const baseTree = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        {
          type: 'table',
          id: 'invoices',
          loading: 'skeleton',
          columns: [
            { fieldKey: 'invoice_number', label: 'Invoice Number' },
            { fieldKey: 'customer_name', label: 'Customer' },
            { fieldKey: 'due_date', label: 'Due Date' },
          ],
          rows: [],
        },
      ],
    };

    const composed = composeStructuredPayloadPatch({
      baseTree,
      payload,
      dataRequirements: [{ containerId: 'invoices', description: 'Invoices', fields: [] }],
    });
    assert.ok(composed, 'dataset payload composes onto the skeleton table');
    assert.equal(composed.patches[0]?.op, 'replace');
    assert.equal(composed.patches[0]?.path, '/children/0/columns');
    assert.deepEqual(composed.patches[0]?.value, [
      { fieldKey: 'name', label: 'Invoice Number' },
      { fieldKey: 'partner_id', label: 'Customer', privacy: 'guard-protected' },
      { fieldKey: 'invoice_date_due', label: 'Due Date' },
      { fieldKey: 'a.b.c', label: 'A B C' },
    ]);
    assert.deepEqual(composed.patches[1], {
      op: 'replace',
      path: '/children/0/loading',
      value: 'none',
    });
    const rowPatch = composed.patches[2] as {
      op: string;
      path: string;
      value: { rowKey: string; cells: Record<string, unknown> };
    };
    assert.equal(rowPatch.op, 'add');
    assert.equal(rowPatch.path, '/children/0/rows/-');
    assert.match(rowPatch.value.rowKey, /^[0-9a-f-]+-0$/i);
    assert.deepEqual(rowPatch.value.cells, {
      name: 'INV-001',
      partner_id: 'Marvin Vomberg',
      invoice_date_due: '2026-06-17',
      'a.b.c': 'Extra column',
    });

    const table = (composed.nextTree as {
      children: Array<{
        loading?: string;
        columns: Array<{ fieldKey: string; label: string; privacy?: 'guard-protected' }>;
        rows: Array<{ cells: Record<string, unknown> }>;
      }>;
    }).children[0];
    assert.equal(table?.loading, 'none');
    assert.deepEqual(table?.columns, [
      { fieldKey: 'name', label: 'Invoice Number' },
      { fieldKey: 'partner_id', label: 'Customer', privacy: 'guard-protected' },
      { fieldKey: 'invoice_date_due', label: 'Due Date' },
      { fieldKey: 'a.b.c', label: 'A B C' },
    ]);
    assert.equal(table?.rows[0]?.cells['partner_id'], 'Marvin Vomberg');
  });
});
