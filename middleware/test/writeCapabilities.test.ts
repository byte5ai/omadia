import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  LocalSubAgentToolResult,
  WriteCapability,
} from '../packages/plugin-api/src/index.js';
import { deriveMutabilityCapabilities } from '../packages/plugin-api/src/writeCapabilities.js';

/**
 * PR-8 — the write-tool capability contract + the deterministic Tier-2
 * mutability derivation, plus the additive `structured?` envelope. Derivation
 * is pure: update→editable fields, create→canAddItems, delete→canRemoveItems,
 * reorder→canReorder; unmatched dataClass / no capability ⇒ read-only.
 */

const JIRA: readonly WriteCapability[] = [
  {
    dataClass: 'jira.ticket',
    operation: 'update',
    targetSchema: {
      idField: 'ticket_id',
      fields: [
        { name: 'status', type: 'enum', values: ['open', 'done'], editable: true },
        { name: 'key', type: 'string', editable: false }, // read-only PK
      ],
    },
  },
  { dataClass: 'jira.ticket', operation: 'create', targetSchema: { requiredFields: ['title', 'assignee'] } },
  { dataClass: 'jira.ticket', operation: 'delete', targetSchema: { idField: 'ticket_id' } },
  { dataClass: 'jira.ticket', operation: 'reorder', targetSchema: { orderField: 'sequence' } },
];

describe('deriveMutabilityCapabilities', () => {
  it('derives the full container + field mutability for the matching dataClass', () => {
    const d = deriveMutabilityCapabilities(JIRA, 'jira.ticket');
    assert.equal(d.canAddItems, true);
    assert.equal(d.canRemoveItems, true);
    assert.equal(d.canReorder, true);
    assert.deepEqual(d.requiredFields, ['title', 'assignee']);
    assert.deepEqual(Object.keys(d.editableFields), ['status']); // only editable:true
    assert.equal(d.editableFields['status']?.type, 'enum');
    assert.equal('key' in d.editableFields, false); // read-only field excluded
  });

  it('is strict-read-only for an unmatched dataClass', () => {
    const d = deriveMutabilityCapabilities(JIRA, 'erp.budget');
    assert.deepEqual(d, {
      canAddItems: false,
      canRemoveItems: false,
      canReorder: false,
      requiredFields: [],
      editableFields: {},
    });
  });

  it('is strict-read-only for an empty capability list', () => {
    const d = deriveMutabilityCapabilities([], 'jira.ticket');
    assert.equal(d.canAddItems, false);
    assert.equal(d.canRemoveItems, false);
    assert.equal(d.canReorder, false);
    assert.deepEqual(d.requiredFields, []);
    assert.deepEqual(d.editableFields, {});
  });

  it('clones derived field objects (no aliasing of shared manifest state)', () => {
    const d = deriveMutabilityCapabilities(JIRA, 'jira.ticket');
    const original = JIRA[0]?.targetSchema?.fields?.[0];
    assert.notEqual(d.editableFields['status'], original); // distinct object
    assert.deepEqual(d.editableFields['status'], original); // same contents
  });

  it('only derives from the matching dataClass in a mixed list', () => {
    const mixed: WriteCapability[] = [
      ...JIRA,
      { dataClass: 'erp.budget', operation: 'update', targetSchema: { fields: [{ name: 'hours', editable: true }] } },
    ];
    const jira = deriveMutabilityCapabilities(mixed, 'jira.ticket');
    assert.equal('hours' in jira.editableFields, false);
    const erp = deriveMutabilityCapabilities(mixed, 'erp.budget');
    assert.deepEqual(Object.keys(erp.editableFields), ['hours']);
    assert.equal(erp.canAddItems, false); // erp has no create capability
  });
});

describe('additive plugin-api fields', () => {
  it('LocalSubAgentToolResult accepts an optional structured envelope', () => {
    const r: LocalSubAgentToolResult = {
      output: 'plain text for classic channels',
      structured: { kind: 'structuredPayload', data: { rows: [] }, prose: 'p' },
    };
    assert.equal(r.structured?.kind, 'structuredPayload');
    // legacy bare result still type-checks
    const legacy: LocalSubAgentToolResult = { output: 'x' };
    assert.equal(legacy.structured, undefined);
  });
});
