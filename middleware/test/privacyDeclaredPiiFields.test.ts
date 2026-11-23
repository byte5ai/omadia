/**
 * Spec 2042 §5.10 — a tool's declared PII fields (`ctx.tools.register(…,
 * { piiFields })`) at the Privacy Shield's data-plane boundary. Until now the
 * annotation had no reader. A declared column is masked whatever the
 * classifier or an operator's non-personal entry says; the declaration never
 * clears a field. Paths that name no row column are ignored.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  nonPersonalFieldRule,
  parseNonPersonalFields,
} from '@omadia/plugin-privacy-guard/dist/nonPersonalFields.js';
import { declaredPiiColumns, withDeclaredPii } from '@omadia/plugin-privacy-guard/dist/v4/declaredPii.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import type { DatasetRow } from '@omadia/plugin-privacy-guard/dist/v4/types.js';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';

const ROWS: DatasetRow[] = [
  { name: 'Paul Williams', department_id: [4, 'Research'], active: true },
  { name: 'Beth Evans', department_id: [2, 'Sales'], active: true },
  { name: 'Anna Rüsche', department_id: [2, 'Sales'], active: false },
];

function storeWith(config: string) {
  const rule = nonPersonalFieldRule(parseNonPersonalFields(config).entries);
  const classify = createShapeClassifier(rule === undefined ? {} : { nonPersonal: rule });
  return createDatasetStore({ classify, buildDigest, turnId: 't-pii' });
}

describe('declared PII fields', () => {
  it('map the paths that name a row column, and ignore the rest', () => {
    const columns = declaredPiiColumns(
      [
        { path: '[].name', idPath: '[].id' },
        { path: '[].department_id[1]', idPath: '[].department_id[0]' },
        { path: 'records[].email', idPath: 'records[].id' },
        { path: 'manager.name', idPath: 'manager.id' },
        { path: '[].children[].name', idPath: '[].children[].id' },
        { path: '[].tags[0].label', idPath: '[].id' },
      ],
      'records',
    );
    assert.deepEqual([...columns].sort(), ['department_id', 'email', 'manager.name', 'name']);
    assert.equal(declaredPiiColumns(undefined).size, 0);
  });

  it('a declared column stays masked even where the operator cleared it', () => {
    const store = storeWith('hr_list:department_id');
    const cleared = store.internToolResult('hr_list', ROWS);
    const dept = store.get(cleared.datasetId)!.schema.fields.find((f) => f.path === 'department_id')!;
    assert.equal(dept.classification, 'safe-cleartext', 'precondition: the operator entry clears it');

    const declared = store.internToolResult('hr_list', ROWS, undefined, [
      { path: '[].department_id[1]', idPath: '[].department_id[0]' },
    ]);
    const masked = store.get(declared.datasetId)!.schema.fields.find((f) => f.path === 'department_id')!;
    assert.equal(masked.classification, 'sensitive-masked');
    assert.ok(!JSON.stringify(declared.digest).includes('Research'), 'a declared PII value reached the digest');
  });

  it('never clears a field, and leaves an undeclared schema untouched', () => {
    const store = storeWith('');
    const { datasetId } = store.internToolResult('hr_list', ROWS, undefined, [{ path: '[].active', idPath: '[].id' }]);
    const schema = store.get(datasetId)!.schema;
    assert.equal(schema.fields.find((f) => f.path === 'name')?.classification, 'sensitive-masked');
    assert.equal(schema.fields.find((f) => f.path === 'active')?.classification, 'sensitive-masked');
    assert.equal(withDeclaredPii(schema, new Set()), schema);
  });

  it('ride the native tool registration, for register and registerHandler', () => {
    const registry = new NativeToolRegistry();
    const piiFields = [{ path: '[].name', idPath: '[].id' }] as const;
    registry.register('hr_list', {
      spec: { name: 'hr_list', description: 'List employees.', input_schema: { type: 'object', properties: {} } },
      handler: async () => '[]',
      piiFields,
    });
    registry.registerHandler('hr_memo', { handler: async () => '{}', piiFields });
    assert.deepEqual(registry.get('hr_list')?.piiFields, piiFields);
    assert.deepEqual(registry.get('hr_memo')?.piiFields, piiFields);
  });
});
