import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseAgentSpec,
  validateSpecForCodegen,
  registerAgentTemplate,
  getKnownAgentTemplates,
} from '../../src/plugins/builder/agentSpec.js';

const validBase = {
  id: 'de.byte5.agent.weather',
  name: 'Weather Agent',
  description: 'Weather forecast agent',
  category: 'analysis',
  skill: { role: 'a weather expert' },
  playbook: { when_to_use: 'when user asks about weather' },
} as const;

describe('agentSpec', () => {
  describe('parseAgentSpec', () => {
    it('accepts a minimal valid spec and applies defaults', () => {
      const spec = parseAgentSpec(validBase);
      assert.equal(spec.template, 'agent-integration');
      assert.equal(spec.version, '0.1.0');
      assert.deepEqual(spec.depends_on, []);
      assert.deepEqual(spec.tools, []);
      assert.deepEqual(spec.slots, {});
      assert.deepEqual(spec.network.outbound, []);
      assert.deepEqual(spec.playbook.not_for, []);
      assert.deepEqual(spec.playbook.example_prompts, []);
    });

    it('rejects an invalid agent id (uppercase)', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, id: 'INVALID_ID' }));
    });

    it('rejects an invalid agent id (starting with digit)', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, id: '1foo' }));
    });

    it('rejects unknown top-level keys via strict()', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, extra_field: 'x' }));
    });

    it('rejects setup_field type "password" (not in allowed enum)', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          setup_fields: [{ key: 'pw', type: 'password', required: true }],
        }),
      );
    });

    it('accepts setup_field type "secret"', () => {
      const spec = parseAgentSpec({
        ...validBase,
        setup_fields: [{ key: 'api_key', type: 'secret', required: true }],
      });
      assert.equal(spec.setup_fields[0]?.type, 'secret');
    });

    it('rejects an unknown template id', () => {
      assert.throws(() =>
        parseAgentSpec({ ...validBase, template: 'nonexistent-template' }),
      );
    });

    it('rejects an invalid tool id (uppercase)', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          tools: [{ id: 'BadName', description: 'x', input: { type: 'object' } }],
        }),
      );
    });

    it('rejects an invalid version (non-semver)', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, version: '1.0' }));
    });

    it('accepts an optional admin_ui_path with the recommended shape', () => {
      const spec = parseAgentSpec({
        ...validBase,
        admin_ui_path: '/api/de.byte5.agent.weather/admin/index.html',
      });
      assert.equal(
        spec.admin_ui_path,
        '/api/de.byte5.agent.weather/admin/index.html',
      );
    });

    it('omits admin_ui_path when not provided (Optional Admin-UI)', () => {
      const spec = parseAgentSpec(validBase);
      assert.equal(spec.admin_ui_path, undefined);
    });

    it('rejects admin_ui_path that does not start with `/`', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          admin_ui_path: 'api/x/admin/index.html',
        }),
      );
    });

    it('rejects admin_ui_path with a protocol scheme', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          admin_ui_path: 'https://example.com/admin/index.html',
        }),
      );
    });

    it('roundtrips a complete spec through JSON', () => {
      const initial = parseAgentSpec({
        ...validBase,
        version: '1.2.3',
        depends_on: ['de.byte5.integration.openweather'],
        tools: [
          {
            id: 'get_forecast',
            description: 'Fetch the forecast',
            input: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
        setup_fields: [{ key: 'api_key', type: 'secret', required: true }],
        playbook: {
          when_to_use: 'weather questions',
          not_for: ['historical climate data'],
          example_prompts: ['Wie wird das Wetter morgen?'],
        },
        network: { outbound: ['api.openweather.org'] },
        slots: { 'client-impl': 'class Client {}', 'toolkit-impl': 'export const tools = []' },
      });
      const json: unknown = JSON.parse(JSON.stringify(initial));
      const reparsed = parseAgentSpec(json);
      assert.deepEqual(reparsed, initial);
    });

    it('defaults builder_settings.auto_fix_enabled to false when omitted (Option-C)', () => {
      const spec = parseAgentSpec(validBase);
      assert.deepEqual(spec.builder_settings, { auto_fix_enabled: false });
    });

    it('accepts builder_settings.auto_fix_enabled = true', () => {
      const spec = parseAgentSpec({
        ...validBase,
        builder_settings: { auto_fix_enabled: true },
      });
      assert.equal(spec.builder_settings.auto_fix_enabled, true);
    });

    it('rejects unknown keys inside builder_settings via strict()', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          builder_settings: { auto_fix_enabled: false, retry_limit: 5 },
        }),
      );
    });
  });

  describe('validateSpecForCodegen', () => {
    it('returns no issues for a clean spec', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'get_weather', description: 'x', input: { type: 'object' } }],
        depends_on: ['de.byte5.integration.openweather'],
      });
      assert.deepEqual(validateSpecForCodegen(spec), []);
    });

    it('flags a reserved exact tool id', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'query_memory', description: 'x', input: { type: 'object' } }],
      });
      const issues = validateSpecForCodegen(spec);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.code, 'reserved_tool_id');
      assert.equal(issues[0]?.toolId, 'query_memory');
    });

    it('flags a reserved prefix tool id', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'query_odoo_invoices', description: 'x', input: { type: 'object' } }],
      });
      const issues = validateSpecForCodegen(spec);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.code, 'reserved_tool_id');
    });

    it('flags duplicate tool ids', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [
          { id: 'foo', description: 'a', input: { type: 'object' } },
          { id: 'foo', description: 'b', input: { type: 'object' } },
        ],
      });
      const issues = validateSpecForCodegen(spec);
      assert.equal(issues.filter((i) => i.code === 'duplicate_tool_id').length, 1);
    });

    it('flags self-dependency', () => {
      const spec = parseAgentSpec({
        ...validBase,
        depends_on: [validBase.id],
      });
      const issues = validateSpecForCodegen(spec);
      assert.ok(issues.some((i) => i.code === 'self_dependency'));
    });

    it('reports multiple issues when present', () => {
      const spec = parseAgentSpec({
        ...validBase,
        depends_on: [validBase.id],
        tools: [
          { id: 'query_memory', description: 'x', input: { type: 'object' } },
          { id: 'foo', description: 'a', input: { type: 'object' } },
          { id: 'foo', description: 'b', input: { type: 'object' } },
        ],
      });
      const issues = validateSpecForCodegen(spec);
      assert.ok(issues.some((i) => i.code === 'reserved_tool_id'));
      assert.ok(issues.some((i) => i.code === 'duplicate_tool_id'));
      assert.ok(issues.some((i) => i.code === 'self_dependency'));
    });
  });

  describe('template registry', () => {
    it('registers a new template id and accepts it via parseAgentSpec', () => {
      const before = getKnownAgentTemplates();
      assert.ok(!before.includes('agent-pure-compute'));

      registerAgentTemplate('agent-pure-compute');

      const after = getKnownAgentTemplates();
      assert.ok(after.includes('agent-pure-compute'));

      const spec = parseAgentSpec({ ...validBase, template: 'agent-pure-compute' });
      assert.equal(spec.template, 'agent-pure-compute');
    });

    it('rejects an empty template id at register-time', () => {
      assert.throws(() => registerAgentTemplate(''));
    });
  });
});
