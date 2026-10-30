/**
 * #1556 — the operator's `non_personal_fields`: a listed field of a listed
 * tool reaches the model as a `label` in clear (a department, a job position),
 * so an answer can name it. Opt-in, empty by default; deny-by-default for
 * everything else.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  formatScopedEntry,
  nonPersonalFieldRule,
  parseNonPersonalFields,
} from '@omadia/plugin-privacy-guard/dist/nonPersonalFields.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { createDatasetStore, scopeOf } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import type { DatasetRow } from '@omadia/plugin-privacy-guard/dist/v4/types.js';
import { createVerbEngine } from '@omadia/plugin-privacy-guard/dist/v4/verbs/index.js';

const RND = 'Research & Development';
const EMPLOYEES: DatasetRow[] = [
  { name: 'Paul Williams', department_id: [4, RND], active: true },
  { name: 'Beth Evans', department_id: [4, RND], active: true },
  { name: 'Anna Rüsche', department_id: [2, 'Sales'], active: true },
  { name: 'Thomas Görres', department_id: [3, 'Management'], active: false },
];

function harness(config: string) {
  const { entries } = parseNonPersonalFields(config);
  const rule = nonPersonalFieldRule(entries);
  const classify = createShapeClassifier(rule === undefined ? {} : { nonPersonal: rule });
  const store = createDatasetStore({ classify, buildDigest, turnId: 't-1556' });
  const engine = createVerbEngine({ store, classify });
  return { store, engine };
}

function field(store: ReturnType<typeof harness>['store'], datasetId: string, path: string) {
  return store.get(datasetId)!.schema.fields.find((f) => f.path === path)!;
}

describe('#1556 — parsing non_personal_fields', () => {
  it('reads tool:field, *:field and bare fields; refuses link keys and junk', () => {
    const parsed = parseNonPersonalFields('odoo_execute:department_id\n*:job_id; company_id, __k_Name\nbad entry');
    assert.deepEqual(parsed.entries, [
      { kind: 'legacy', tool: 'odoo_execute', path: 'department_id' },
      { kind: 'legacy', tool: '*', path: 'job_id' },
      { kind: 'legacy', tool: '*', path: 'company_id' },
    ]);
    assert.deepEqual(parsed.rejected, ['__k_Name', 'bad entry']);
    assert.equal(nonPersonalFieldRule([]), undefined, 'empty means no rule at all');
  });
});

describe('#1556 — classification', () => {
  it('without a rule a many2one label stays masked (deny-by-default)', () => {
    const { store } = harness('');
    const { datasetId } = store.internToolResult('odoo_execute', EMPLOYEES);
    assert.equal(field(store, datasetId, 'department_id').classification, 'sensitive-masked');
  });

  it('a listed field of the listed tool clears as a label; names stay masked', () => {
    const { store } = harness('odoo_execute:department_id');
    const { datasetId, digest } = store.internToolResult('odoo_execute', EMPLOYEES);
    const dept = field(store, datasetId, 'department_id');
    assert.equal(dept.type, 'label');
    assert.equal(dept.classification, 'safe-cleartext');
    assert.equal(field(store, datasetId, 'name').classification, 'sensitive-masked');
    const text = JSON.stringify(digest);
    assert.ok(text.includes(RND), 'the model can read the department');
    assert.ok(!text.includes('Paul Williams'), 'a name reached the digest');
  });

  it('another tool, or a value the identity detector flags, keeps the field masked', () => {
    const { store } = harness('odoo_execute:department_id');
    const other = store.internToolResult('hr_export', EMPLOYEES);
    assert.equal(field(store, other.datasetId, 'department_id').classification, 'sensitive-masked');

    const classify = createShapeClassifier({
      nonPersonal: nonPersonalFieldRule(parseNonPersonalFields('*:department_id').entries)!,
      detector: (v) => v.includes('@'),
    });
    const flagged = classify([{ department_id: [9, 'jonas.weber@example.com'] }], 'rows', {
      sources: [{ tool: 'odoo_execute', scope: '-' }],
    });
    assert.equal(flagged.fields[0]!.classification, 'sensitive-masked');
  });

  it('a value that is neither text nor a pair keeps the field masked', () => {
    const { store } = harness('*:department_id');
    const { datasetId } = store.internToolResult('odoo_execute', [
      { department_id: { id: 4, name: RND } },
    ]);
    assert.equal(field(store, datasetId, 'department_id').classification, 'sensitive-masked');
  });
});

describe('#1556 — verbs on a label', () => {
  it('filter, sort and group work on the label text and keep the label clear', () => {
    const { store, engine } = harness('odoo_execute:department_id');
    const { datasetId } = store.internToolResult('odoo_execute', EMPLOYEES);
    const filtered = engine.filter(datasetId, { op: 'eq', field: 'department_id', value: RND });
    assert.equal(store.get(filtered.datasetId)!.rows.length, 2);
    assert.equal(field(store, filtered.datasetId, 'department_id').type, 'label');
    const sorted = engine.sort(datasetId, 'department_id', 'asc');
    assert.deepEqual(
      store.get(sorted.datasetId)!.rows.map((r) => (r.department_id as [number, string])[1]),
      ['Management', RND, RND, 'Sales'],
    );
    const grouped = engine.group(datasetId, ['department_id']);
    assert.equal(store.get(grouped.datasetId)!.rows.length, 3);
  });

  it('a union with a tool the rule does not list masks the field again', () => {
    const { store, engine } = harness('odoo_execute:department_id');
    const a = store.internToolResult('odoo_execute', EMPLOYEES);
    const b = store.internToolResult('hr_export', EMPLOYEES);
    const u = engine.union(a.datasetId, b.datasetId);
    assert.equal(field(store, u.datasetId, 'department_id').classification, 'sensitive-masked');
  });
});

describe('#1556 — service and receipt', () => {
  it('reads the setting, shows the label to the model and records it on the receipt', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key: string) =>
        key === 'non_personal_fields' ? 'odoo_execute:department_id' : undefined,
    });
    const r = await svc.internToolResultV4({
      turnId: 't-svc-1556',
      sessionId: 's',
      toolName: 'odoo_execute',
      rawResult: JSON.stringify(EMPLOYEES),
    } as Parameters<typeof svc.internToolResultV4>[0]);
    assert.ok(r.digestText.includes(RND));
    assert.ok(!r.digestText.includes('Beth Evans'));
    const receipt = await svc.finalizeTurn('t-svc-1556');
    assert.deepEqual(receipt?.operatorClearedFields, [
      { toolName: 'odoo_execute', field: 'department_id', scope: '-' },
    ]);
  });

  it('without the setting nothing changes', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => undefined });
    const r = await svc.internToolResultV4({
      turnId: 't-svc-off',
      sessionId: 's',
      toolName: 'odoo_execute',
      rawResult: JSON.stringify(EMPLOYEES),
    } as Parameters<typeof svc.internToolResultV4>[0]);
    assert.ok(!r.digestText.includes(RND));
    const receipt = await svc.finalizeTurn('t-svc-off');
    assert.equal(receipt?.operatorClearedFields, undefined);
  });
});

describe('#1556 — a rename cannot launder a masked column into a label', () => {
  it('union renameRight onto a listed path keeps the field masked', () => {
    const { store, engine } = harness('odoo_execute:department_id');
    const a = store.internToolResult('odoo_execute', EMPLOYEES);
    const b = store.internToolResult('odoo_execute', [{ name: 'Lena Bauer', active: true }]);
    const u = engine.union(a.datasetId, b.datasetId, { renameRight: { name: 'department_id' } });
    assert.equal(field(store, u.datasetId, 'department_id').classification, 'sensitive-masked');
  });
});

describe('#1556 — security review follow-ups', () => {
  const ruleFor = (config: string) => nonPersonalFieldRule(parseNonPersonalFields(config).entries)!;

  it('a detector hit is no label: not reported as cleared, not cleared by a later filter', () => {
    const classify = createShapeClassifier({
      nonPersonal: ruleFor('*:department_id'),
      detector: (v) => v.includes('@'),
    });
    const store = createDatasetStore({ classify, buildDigest, turnId: 't-det' });
    const engine = createVerbEngine({ store, classify });
    const { datasetId } = store.internToolResult('odoo_execute', [
      { id: 1, department_id: [2, 'x@y.de'] },
      { id: 2, department_id: [4, RND] },
    ]);
    const dept = field(store, datasetId, 'department_id');
    assert.notEqual(dept.type, 'label');
    assert.equal(dept.classification, 'sensitive-masked');
    const filtered = engine.filter(datasetId, { op: 'eq', field: 'id', value: 2 });
    assert.equal(field(store, filtered.datasetId, 'department_id').classification, 'sensitive-masked');
  });

  it("Odoo's false for an unset many2one does not block the rule", () => {
    const { store } = harness('odoo_execute:department_id');
    const { datasetId } = store.internToolResult('odoo_execute', [
      ...EMPLOYEES,
      { name: 'Neu', department_id: false, active: true },
    ]);
    assert.equal(field(store, datasetId, 'department_id').classification, 'safe-cleartext');
  });

  it('a masked pair field does not sort rows by the person behind it', () => {
    const { store, engine } = harness('odoo_execute:department_id');
    const { datasetId } = store.internToolResult('odoo_execute', [
      { partner_id: [1, 'Zora Zimmer'], n: 1 },
      { partner_id: [2, 'Anna Adler'], n: 2 },
    ]);
    const sorted = engine.sort(datasetId, 'partner_id', 'asc');
    assert.deepEqual(store.get(sorted.datasetId)!.rows.map((r) => r.n), [1, 2], 'ordered by name');
  });

  it('a * rule does not cover a sub-agent narration; link keys anywhere in a path are refused', () => {
    const rule = ruleFor('*:department_id');
    const src = (tool: string, scope = '-') => [{ tool, scope }];
    assert.equal(rule(src('sub-agent'), 'department_id'), false);
    assert.equal(rule(src('odoo_execute'), 'department_id'), true);
    assert.equal(ruleFor('sub-agent:department_id')(src('sub-agent'), 'department_id'), true);
    assert.deepEqual(parseNonPersonalFields('rows.__k_Name').rejected, ['rows.__k_Name']);
  });
});

describe('#1556 — the digest lists a bounded set of labels', () => {
  it('caps a large label field at 50 texts, drops Odoo false, marks the rest', () => {
    const { store } = harness('odoo_execute:product_id');
    const rows: DatasetRow[] = Array.from({ length: 300 }, (_, i) => ({
      product_id: i % 7 === 0 ? false : [i, `Produkt ${String(i)}`],
    }));
    const { digest } = store.internToolResult('odoo_execute', rows);
    const fd = digest.fields.find((f) => f.path === 'product_id') as {
      summary?: { distinctValues?: unknown[] };
    };
    const listed = fd.summary?.distinctValues ?? [];
    assert.equal(listed.length, 51);
    assert.ok(!listed.includes('false'));
    assert.match(String(listed[50]), /^… \d+ more$/);
  });
});

describe('contract v2 — scoped entries', () => {
  const EMPLOYEE_INPUT = { model: 'hr.employee', method: 'search_read' };
  const DS = '0f8e2c1a-7b3d-4e5f-9a1b-2c3d4e5f6a7b';
  const OTHER_DS = '11111111-2222-4333-8444-555555555555';
  const UPLOAD: DatasetRow[] = [
    { 'Abteilung Name': RND, Name: 'Paul Williams' },
    { 'Abteilung Name': 'Sales', Name: 'Beth Evans' },
    { 'Abteilung Name': RND, Name: 'Anna Rüsche' },
    { 'Abteilung Name': 'Management', Name: 'Thomas Görres' },
  ];
  const rowsOf = (datasetId: string) => ({ query: 'query_rows', dataset_id: datasetId });

  it('scopeOf: tool input model, envelope model, dataset id, else -', () => {
    assert.equal(scopeOf('odoo_execute', { model: 'HR.Employee' }), 'hr.employee');
    assert.equal(scopeOf('odoo_query', {}, { model: 'res.partner' }), 'res.partner');
    assert.equal(scopeOf('odoo_execute', { model: 'hr employee; x' }), '-');
    assert.equal(scopeOf('mcp_tool', { query: 'x' }), '-');
    assert.equal(scopeOf('mcp_tool', undefined), '-');
    assert.equal(scopeOf('query_dataset', rowsOf(DS.toUpperCase())), DS);
    assert.equal(scopeOf('query_dataset', rowsOf('ds_not-a-uuid')), '-');
    assert.equal(scopeOf('query_dataset', { query: 'get_schema', dataset_id: DS }), '-');
  });

  it('a model-scoped entry clears the field only for rows of that model', () => {
    const { store } = harness('odoo_execute:hr.employee/department_id');
    const employee = store.internToolResult('odoo_execute', EMPLOYEES, EMPLOYEE_INPUT);
    assert.equal(field(store, employee.datasetId, 'department_id').classification, 'safe-cleartext');
    assert.deepEqual(store.get(employee.datasetId)!.provenance.sources, [
      { tool: 'odoo_execute', scope: 'hr.employee' },
    ]);
    for (const model of ['res.partner', 'hr.contract']) {
      const other = store.internToolResult('odoo_execute', EMPLOYEES, { model });
      assert.equal(field(store, other.datasetId, 'department_id').classification, 'sensitive-masked', model);
    }
    const noModel = store.internToolResult('odoo_execute', EMPLOYEES);
    assert.equal(field(store, noModel.datasetId, 'department_id').classification, 'sensitive-masked');
    const otherTool = store.internToolResult('hr_export', EMPLOYEES, EMPLOYEE_INPUT);
    assert.equal(field(store, otherTool.datasetId, 'department_id').classification, 'sensitive-masked');
  });

  it('the envelope model scopes a result whose input names none', () => {
    const { store } = harness('odoo_query:hr.employee/department_id');
    const env = { model: 'hr.employee', count: 4, records: EMPLOYEES };
    const { datasetId } = store.internToolResult('odoo_query', env, {});
    assert.equal(field(store, datasetId, 'department_id').classification, 'safe-cleartext');
  });

  it('a dataset entry clears only that dataset\'s column via query_dataset', () => {
    const { store } = harness(`dataset:${DS}/Abteilung Name`);
    const mine = store.internToolResult('query_dataset', UPLOAD, rowsOf(DS));
    assert.equal(field(store, mine.datasetId, 'Abteilung Name').classification, 'safe-cleartext');
    assert.equal(field(store, mine.datasetId, 'Name').classification, 'sensitive-masked');
    const upper = store.internToolResult('query_dataset', UPLOAD, rowsOf(DS.toUpperCase()));
    assert.equal(field(store, upper.datasetId, 'Abteilung Name').classification, 'safe-cleartext');
    const other = store.internToolResult('query_dataset', UPLOAD, rowsOf(OTHER_DS));
    assert.equal(field(store, other.datasetId, 'Abteilung Name').classification, 'sensitive-masked');
    const elsewhere = store.internToolResult('mcp_sheet', UPLOAD, rowsOf(DS));
    assert.equal(field(store, elsewhere.datasetId, 'Abteilung Name').classification, 'sensitive-masked');
  });

  it('tool:-/field covers a model-less source only', () => {
    const { store } = harness('hr_export:-/department_id');
    const plain = store.internToolResult('hr_export', EMPLOYEES);
    assert.equal(field(store, plain.datasetId, 'department_id').classification, 'safe-cleartext');
    const scoped = store.internToolResult('hr_export', EMPLOYEES, EMPLOYEE_INPUT);
    assert.equal(field(store, scoped.datasetId, 'department_id').classification, 'sensitive-masked');
  });

  it('legacy tool:field and *:field still clear every model', () => {
    for (const config of ['odoo_execute:department_id', '*:department_id', 'department_id']) {
      const { store } = harness(config);
      for (const input of [EMPLOYEE_INPUT, { model: 'res.partner' }, undefined]) {
        const { datasetId } = store.internToolResult('odoo_execute', EMPLOYEES, input);
        assert.equal(field(store, datasetId, 'department_id').classification, 'safe-cleartext', config);
      }
    }
  });

  it('a join or union of two scopes clears only when both are covered', () => {
    const one = harness('odoo_execute:hr.employee/department_id');
    const a = one.store.internToolResult('odoo_execute', EMPLOYEES, EMPLOYEE_INPUT);
    const b = one.store.internToolResult('odoo_execute', EMPLOYEES, { model: 'hr.contract' });
    const u = one.engine.union(a.datasetId, b.datasetId);
    assert.equal(field(one.store, u.datasetId, 'department_id').classification, 'sensitive-masked');
    assert.equal(one.store.get(u.datasetId)!.provenance.sources?.length, 2);

    const both = harness('odoo_execute:hr.employee/department_id\nodoo_execute:hr.contract/department_id');
    const c = both.store.internToolResult('odoo_execute', EMPLOYEES, EMPLOYEE_INPUT);
    const d = both.store.internToolResult('odoo_execute', EMPLOYEES, { model: 'hr.contract' });
    const u2 = both.engine.union(c.datasetId, d.datasetId);
    assert.equal(field(both.store, u2.datasetId, 'department_id').classification, 'safe-cleartext');
    const filtered = both.engine.filter(u2.datasetId, { op: 'eq', field: 'department_id', value: RND });
    assert.deepEqual(both.store.get(filtered.datasetId)!.provenance.sources, [
      { tool: 'odoo_execute', scope: 'hr.employee' },
      { tool: 'odoo_execute', scope: 'hr.contract' },
    ]);

    const keyed = EMPLOYEES.map((r, i) => ({ ...r, id: i + 1 }));
    // The right side carries no department_id, so only the scope rule decides.
    const contracts = EMPLOYEES.map((_, i) => ({ employee: i + 1, hours: 40 - i }));
    const e = one.store.internToolResult('odoo_execute', keyed, EMPLOYEE_INPUT);
    assert.equal(field(one.store, e.datasetId, 'department_id').classification, 'safe-cleartext');
    const f = one.store.internToolResult('odoo_execute', contracts, { model: 'hr.contract' });
    const j = one.engine.join(e.datasetId, f.datasetId, { left: 'id', right: 'employee' });
    assert.equal(field(one.store, j.datasetId, 'department_id').classification, 'sensitive-masked');
    const g = both.store.internToolResult('odoo_execute', keyed, EMPLOYEE_INPUT);
    const h = both.store.internToolResult('odoo_execute', contracts, { model: 'hr.contract' });
    const j2 = both.engine.join(g.datasetId, h.datasetId, { left: 'id', right: 'employee' });
    assert.equal(field(both.store, j2.datasetId, 'department_id').classification, 'safe-cleartext');
  });

  it('formatScopedEntry round-trips and refuses injection', () => {
    assert.equal(
      formatScopedEntry({ tool: 'odoo_execute', scope: 'hr.employee' }, 'department_id'),
      'odoo_execute:hr.employee/department_id',
    );
    assert.equal(formatScopedEntry({ tool: 'query_dataset', scope: DS }, 'Abteilung Name'), `dataset:${DS}/Abteilung Name`);
    assert.equal(formatScopedEntry({ tool: 'mcp_tool', scope: '-' }, 'category'), 'mcp_tool:-/category');
    assert.equal(formatScopedEntry({ tool: 'x', scope: '-' }, 'x\n*:y'), undefined);
    assert.equal(formatScopedEntry({ tool: 'x', scope: '-' }, 'a/b'), undefined);
    assert.equal(formatScopedEntry({ tool: 'x', scope: '-' }, 'x;y'), undefined);
    assert.equal(formatScopedEntry({ tool: 'x', scope: '-' }, '__k_Name'), undefined);
    assert.equal(formatScopedEntry({ tool: '*', scope: 'm' }, 'f'), undefined);
    assert.deepEqual(parseNonPersonalFields('*:m/f'), { entries: [], rejected: ['*:m/f'] });
  });

  it('parses scoped entries, CSV headers with inner spaces included', () => {
    const parsed = parseNonPersonalFields(
      `odoo_execute:hr.employee/department_id\ndataset:${DS}/Abteilung Name; mcp_tool:-/category`,
    );
    assert.deepEqual(parsed.entries, [
      { kind: 'scoped', source: 'odoo_execute', scope: 'hr.employee', path: 'department_id' },
      { kind: 'scoped', source: 'dataset', scope: DS, path: 'Abteilung Name' },
      { kind: 'scoped', source: 'mcp_tool', scope: '-', path: 'category' },
    ]);
    assert.deepEqual(parsed.rejected, []);
  });

  it('the receipt names the scope of a cleared field', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key: string) =>
        key === 'non_personal_fields' ? 'odoo_execute:hr.employee/department_id' : undefined,
    });
    await svc.internToolResultV4({
      turnId: 't-scope',
      sessionId: 's',
      toolName: 'odoo_execute',
      rawResult: JSON.stringify(EMPLOYEES),
      toolInput: EMPLOYEE_INPUT,
    } as Parameters<typeof svc.internToolResultV4>[0]);
    const receipt = await svc.finalizeTurn('t-scope');
    assert.deepEqual(receipt?.operatorClearedFields, [
      { toolName: 'odoo_execute', field: 'department_id', scope: 'hr.employee' },
    ]);
  });
});
