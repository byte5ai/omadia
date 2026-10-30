/**
 * #1556 follow-up — the Odoo relation resolver reads the SCHEMA only: every
 * call it makes is `fields_get`, never a record read.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createOdooRelationResolver } from '../src/privacy/fieldClassification/odooRelationResolver.js';

interface Call {
  model: string;
  method: string;
  positionalArgs: unknown[];
  kwargs: Record<string, unknown>;
}

function client(schema: Record<string, unknown>, calls: Call[], fail = new Set<string>()) {
  return {
    execute: async (req: Call) => {
      calls.push(req);
      if (fail.has(req.model)) throw new Error('boom');
      return schema[req.model] ?? {};
    },
  };
}

describe('odooRelationResolver', () => {
  it('calls only fields_get, once per model per resolver, and resolves relation targets', async () => {
    const calls: Call[] = [];
    const resolver = createOdooRelationResolver(
      client(
        {
          'hr.employee': {
            department_id: { type: 'many2one', relation: 'hr.department', string: 'Department', help: 'Org unit' },
            name: { type: 'char', string: 'Name' },
          },
          'hr.employee.public': {
            department_id: { type: 'many2one', relation: 'hr.department' },
          },
          'sale.order': { department_id: { type: 'many2one', relation: 'x_custom.dept' } },
        },
        calls,
      ),
    );
    const info = await resolver.resolve(['hr.employee', 'hr.employee.public', 'sale.order'], 'department_id');
    assert.equal(info.known, true);
    assert.deepEqual(info.relationModels, ['hr.department', 'x_custom.dept']);
    assert.deepEqual(info.fieldDocs[0], { relation: 'hr.department', label: 'Department', help: 'Org unit' });

    const text = await resolver.resolve(['hr.employee'], 'name');
    assert.deepEqual(text.relationModels, []);
    await resolver.resolve(['hr.employee'], 'parent_id');

    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.method, 'fields_get');
      assert.deepEqual(call.positionalArgs, []);
      assert.deepEqual(call.kwargs, { attributes: ['type', 'relation', 'string', 'help'] });
    }
    assert.deepEqual(
      calls.map((c) => c.model),
      ['hr.employee', 'hr.employee.public', 'sale.order'],
      'cached per model',
    );
  });

  it('an absent client, a failing call or an invalid model name means relation unknown', async () => {
    const none = await createOdooRelationResolver(undefined).resolve(['hr.employee'], 'department_id');
    assert.deepEqual(none, { known: false, relationModels: [], fieldDocs: [] });

    const calls: Call[] = [];
    const failing = createOdooRelationResolver(client({}, calls, new Set(['hr.employee'])));
    assert.equal((await failing.resolve(['hr.employee'], 'department_id')).known, false);

    const invalid = await failing.resolve(["x'; drop", 'Bad Model'], 'department_id');
    assert.equal(invalid.known, false);
    assert.deepEqual(
      calls.map((c) => c.model),
      ['hr.employee'],
    );
  });
});
