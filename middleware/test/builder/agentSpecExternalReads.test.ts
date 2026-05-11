import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseAgentSpec,
  validateSpecForCodegen,
} from '../../src/plugins/builder/agentSpec.js';

const validBase = {
  id: 'de.byte5.agent.weather',
  name: 'Weather Agent',
  description: 'Weather forecast agent',
  category: 'analysis',
  skill: { role: 'a weather expert' },
  playbook: { when_to_use: 'when user asks about weather' },
} as const;

describe('agentSpec.external_reads — schema', () => {
  it('defaults to an empty array when omitted', () => {
    const spec = parseAgentSpec(validBase);
    assert.deepEqual(spec.external_reads, []);
  });

  it('accepts a fully-specified entry with mapping', () => {
    const spec = parseAgentSpec({
      ...validBase,
      depends_on: ['de.byte5.integration.odoo'],
      external_reads: [
        {
          id: 'list_employees',
          description: 'Mitarbeiterliste aus Odoo HR',
          service: 'odoo.client',
          model: 'hr.employee',
          method: 'execute',
          args: [{ model: 'hr.employee', method: 'search_read' }],
          kwargs: { domain: [] },
          result_mapping: { employees: 'data' },
        },
      ],
    });
    assert.equal(spec.external_reads.length, 1);
    assert.equal(spec.external_reads[0]?.id, 'list_employees');
    assert.equal(spec.external_reads[0]?.service, 'odoo.client');
  });

  it('applies defaults for optional fields (args=[], kwargs={})', () => {
    const spec = parseAgentSpec({
      ...validBase,
      external_reads: [
        {
          id: 'ping',
          description: 'health probe',
          service: 'odoo.client',
          method: 'getUid',
        },
      ],
    });
    assert.deepEqual(spec.external_reads[0]?.args, []);
    assert.deepEqual(spec.external_reads[0]?.kwargs, {});
    assert.equal(spec.external_reads[0]?.result_mapping, undefined);
  });

  it('rejects malformed entries — missing required field', () => {
    assert.throws(() =>
      parseAgentSpec({
        ...validBase,
        external_reads: [
          {
            id: 'broken',
            // missing description
            service: 'odoo.client',
            method: 'getUid',
          },
        ],
      }),
    );
  });

  it('rejects non-snake_case ids on entries', () => {
    assert.throws(() =>
      parseAgentSpec({
        ...validBase,
        external_reads: [
          {
            id: 'BadId',
            description: 'x',
            service: 'odoo.client',
            method: 'm',
          },
        ],
      }),
    );
  });

  it('rejects unknown extra keys (strict mode)', () => {
    assert.throws(() =>
      parseAgentSpec({
        ...validBase,
        external_reads: [
          {
            id: 'foo',
            description: 'x',
            service: 'odoo.client',
            method: 'm',
            extra_garbage: true,
          },
        ],
      }),
    );
  });
});

describe('agentSpec.external_reads — validateSpecForCodegen', () => {
  it('flags external_read.id that collides with a tools[].id', () => {
    const spec = parseAgentSpec({
      ...validBase,
      tools: [{ id: 'list_employees', description: 'x', input: { type: 'object' } }],
      external_reads: [
        {
          id: 'list_employees',
          description: 'duplicate',
          service: 'odoo.client',
          method: 'execute',
        },
      ],
    });
    const issues = validateSpecForCodegen(spec);
    const collision = issues.find((i) => i.code === 'external_read_id_collides_with_tool');
    assert.ok(collision, 'expected external_read_id_collides_with_tool');
    assert.equal(collision.toolId, 'list_employees');
  });

  it('flags duplicate ids inside external_reads[]', () => {
    const spec = parseAgentSpec({
      ...validBase,
      external_reads: [
        { id: 'fetch', description: 'a', service: 'odoo.client', method: 'm' },
        { id: 'fetch', description: 'b', service: 'odoo.client', method: 'm' },
      ],
    });
    const issues = validateSpecForCodegen(spec);
    const dup = issues.find((i) => i.code === 'duplicate_tool_id' && i.toolId === 'fetch');
    assert.ok(dup);
  });

  it('lets a valid external_reads entry through', () => {
    const spec = parseAgentSpec({
      ...validBase,
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      external_reads: [
        {
          id: 'list_employees',
          description: 'x',
          service: 'odoo.client',
          method: 'execute',
        },
      ],
    });
    const issues = validateSpecForCodegen(spec);
    assert.equal(issues.length, 0);
  });
});
