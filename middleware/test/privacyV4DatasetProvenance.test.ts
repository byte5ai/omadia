/**
 * Privacy Shield v4 — dataset provenance (`datasetProvenance`).
 *
 * A canvas publish by datasetId needs to know WHICH tool call produced the
 * dataset (tool + input as dispatched) and which verbs were applied on the
 * way, so the canvas orchestrator can derive an LLM-free refresh recipe for
 * agent-filled tables. Provenance is turn-scoped like the datasets: it never
 * outlives `finalizeTurn`, and only a dataset interned WITH its tool input
 * has one.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const EMPLOYEES = {
  model: 'hr.employee',
  count: 3,
  truncated: false,
  records: [
    { id: 1, name: 'Marvin Vomberg', birthday: '1990-11-03', department: 'Sales' },
    { id: 2, name: 'Anna Rüsche', birthday: '1985-04-12', department: 'IT' },
    { id: 3, name: 'Thomas Görres', birthday: '1979-11-20', department: 'IT' },
  ],
};
const QUERY = { model: 'hr.employee', domain: [['active', '=', true]], fields: ['name', 'birthday', 'department'], limit: 100 };

function datasetIdOf(text: string): string {
  const m = /"datasetId"\s*:\s*"(ds_[^"]+)"/.exec(text);
  assert.ok(m, `no datasetId in: ${text.slice(0, 120)}`);
  return m[1] as string;
}

describe('PrivacyGuardService.datasetProvenance', () => {
  it('returns the originating tool + input for a directly interned dataset', async () => {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't1',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(EMPLOYEES),
      toolInput: QUERY,
    });
    const p = svc.datasetProvenance?.('t1', r.datasetId);
    assert.ok(p, 'provenance exists');
    assert.equal(p.tool, 'odoo_query');
    assert.deepEqual(p.input, QUERY);
    assert.deepEqual(p.verbs, []);
    assert.equal(p.truncated, false);
  });

  it('hands out a copy — mutating the result never touches the stored input', async () => {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-copy',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(EMPLOYEES),
      toolInput: QUERY,
    });
    const first = svc.datasetProvenance?.('t-copy', r.datasetId);
    (first?.input as { model: string }).model = 'res.partner';
    assert.equal((svc.datasetProvenance?.('t-copy', r.datasetId)?.input as { model: string }).model, 'hr.employee');
  });

  it('records the verb chain (select → filter) from origin to the published dataset', async () => {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't2',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(EMPLOYEES),
      toolInput: QUERY,
    });
    const selected = await svc.runV4Tool({
      sessionId: 's',
      turnId: 't2',
      toolName: 'v4_select',
      input: { datasetId: r.datasetId, columns: ['id', 'department'] },
    });
    const filtered = await svc.runV4Tool({
      sessionId: 's',
      turnId: 't2',
      toolName: 'v4_filter',
      input: {
        datasetId: datasetIdOf(selected.resultText),
        predicate: { op: 'eq', field: 'id', value: 2 },
      },
    });
    const p = svc.datasetProvenance?.('t2', datasetIdOf(filtered.resultText));
    assert.ok(p);
    assert.equal(p.tool, 'odoo_query');
    assert.deepEqual(p.input, QUERY);
    assert.deepEqual(p.verbs, [
      { verb: 'select', args: { columns: ['id', 'department'] } },
      { verb: 'filter', args: { predicate: { op: 'eq', field: 'id', value: 2 } } },
    ]);
  });

  it('resolves a sub-agent inner tool: the dataset the parent publishes by reference', async () => {
    const svc = createPrivacyGuardService();
    // the sub-agent's inner odoo_query is interned with its own input …
    const inner = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't3',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(EMPLOYEES),
      toolInput: QUERY,
    });
    // … and handed up to the parent by reference (no re-intern)
    const up = await svc.subAgentResultV4?.({ turnId: 't3', narration: 'done', datasetIds: [inner.datasetId] });
    assert.ok(up?.resultText.includes(inner.datasetId));
    const p = svc.datasetProvenance?.('t3', inner.datasetId);
    assert.equal(p?.tool, 'odoo_query');
    assert.deepEqual(p?.input, QUERY);
  });

  it('has no provenance without a recorded tool input, for unknown ids, or after finalizeTurn', async () => {
    const svc = createPrivacyGuardService();
    const bare = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't4',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(EMPLOYEES),
    });
    assert.equal(svc.datasetProvenance?.('t4', bare.datasetId), undefined);
    assert.equal(svc.datasetProvenance?.('t4', 'ds_unknown'), undefined);
    const withInput = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't4',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(EMPLOYEES),
      toolInput: QUERY,
    });
    assert.ok(svc.datasetProvenance?.('t4', withInput.datasetId));
    await svc.finalizeTurn('t4');
    assert.equal(svc.datasetProvenance?.('t4', withInput.datasetId), undefined);
  });
});

// ---------------------------------------------------------------------------
// v414 — an envelope-shaped tool result (`{model, scope, count, truncated,
// records:[…]}`) is interned as its RECORDS; the envelope scalars are dataset
// metadata. Before the fix they were broadcast onto every row, so a canvas
// table published by datasetId — and the refresh recipe derived from it —
// carried `model, scope, count, truncated` as columns.
// ---------------------------------------------------------------------------

const ODOO_ENVELOPE = {
  model: 'hr.employee',
  scope: 'hr',
  count: 2,
  truncated: false,
  records: [
    { id: 1, name: 'Marvin Vomberg', job_title: 'Developer', work_email: 'marvin@example.com', active: true },
    { id: 2, name: 'Anna Rüsche', job_title: 'Project Manager', work_email: 'anna@example.com', active: true },
  ],
};
const RECORD_FIELDS = ['id', 'name', 'job_title', 'work_email', 'active'];

interface DigestJson {
  rowCount: number;
  fields: { path: string }[];
  metadata?: { path: string; classification: string; values?: unknown[] }[];
}

function digestOf(text: string): DigestJson {
  return JSON.parse(text.slice(text.lastIndexOf('\n\n{') + 2)) as DigestJson;
}

describe('odoo_query envelope → records-only dataset + metadata', () => {
  async function intern(turnId: string) {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'odoo_query',
      rawResult: JSON.stringify(ODOO_ENVELOPE),
      toolInput: QUERY,
    });
    return { svc, r };
  }

  it('dataset columns are the record fields only; the envelope rides along as digest metadata', async () => {
    const { svc, r } = await intern('e1');
    const resolved = svc.resolveDatasetForRender?.('e1', r.datasetId);
    assert.ok(resolved);
    assert.equal(resolved.rowCount, 2);
    assert.deepEqual(resolved.columns.map((c) => c.path), RECORD_FIELDS);
    for (const row of resolved.rows) assert.deepEqual(Object.keys(row), RECORD_FIELDS);

    const digest = digestOf(r.digestText);
    assert.equal(digest.rowCount, 2);
    assert.deepEqual(digest.fields.map((f) => f.path), RECORD_FIELDS);
    const meta = new Map((digest.metadata ?? []).map((m) => [m.path, m]));
    assert.deepEqual([...meta.keys()], ['model', 'scope', 'count', 'truncated']);
    // count / truncated stay useful to the model …
    assert.deepEqual(meta.get('count')?.values, [2]);
    assert.deepEqual(meta.get('truncated')?.values, [false]);
    // … free-text metadata is deny-by-default masked like any field
    assert.equal(meta.get('model')?.classification, 'sensitive-masked');
    // the model is told metadata is not a column
    assert.match(r.digestText, /"metadata" describes the WHOLE result/);
    // no record PII on the wire
    assert.ok(!r.digestText.includes('Marvin') && !r.digestText.includes('anna@example.com'));
  });

  it('the receipt counts every field the digest exposes (5 record + 4 metadata)', async () => {
    const { svc } = await intern('e2');
    const receipt = await svc.finalizeTurn('e2');
    assert.ok(receipt);
    assert.equal(receipt.datasetsInterned, 1);
    assert.equal(receipt.fieldsMasked + receipt.fieldsCleartext, 9);
    // name, job_title, work_email (record) + model, scope (metadata)
    assert.equal(receipt.fieldsMasked, 5);
  });

  it('provenance names the record array; a plain array result has none', async () => {
    const { svc, r } = await intern('e3');
    assert.equal(svc.datasetProvenance?.('e3', r.datasetId)?.itemsPath, 'records');
    const plain = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 'e3',
      toolName: 'odoo_query',
      rawResult: JSON.stringify(ODOO_ENVELOPE.records),
      toolInput: QUERY,
    });
    const p = svc.datasetProvenance?.('e3', plain.datasetId);
    assert.ok(p);
    assert.equal('itemsPath' in p, false);
  });

  it('a verb-derived dataset keeps the origin itemsPath but carries no metadata of its own', async () => {
    const { svc, r } = await intern('e4');
    const selected = await svc.runV4Tool({
      sessionId: 's',
      turnId: 'e4',
      toolName: 'v4_select',
      input: { datasetId: r.datasetId, columns: ['id', 'name'] },
    });
    assert.equal(digestOf(selected.resultText).metadata, undefined);
    const sid = datasetIdOf(selected.resultText);
    assert.equal(svc.datasetProvenance?.('e4', sid)?.itemsPath, 'records');
  });
});
