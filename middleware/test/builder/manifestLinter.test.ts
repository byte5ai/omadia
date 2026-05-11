import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  validateSpec,
  formatViolations,
} from '../../src/plugins/builder/manifestLinter.js';
import {
  _resetServiceTypeRegistryForTests,
  registerServiceType,
} from '../../src/plugins/builder/serviceTypeRegistry.js';

// Phase 5B: registry is empty by default. Seed the historical 5 entries
// so the external_reads test cases that look up 'odoo.client' /
// 'confluence.client' / 'microsoft365.graph' continue to find them.
function seedServiceTypeRegistry(): void {
  _resetServiceTypeRegistryForTests();
  registerServiceType('odoo.client', {
    providedBy: 'de.byte5.integration.odoo',
    typeImport: { from: '@omadia/integration-odoo', name: 'OdooClient' },
  });
  registerServiceType('odoo.cache', {
    providedBy: 'de.byte5.integration.odoo',
    typeImport: { from: '@omadia/integration-odoo', name: 'OdooResponseCache' },
  });
  registerServiceType('confluence.client', {
    providedBy: 'de.byte5.integration.confluence',
    typeImport: {
      from: '@omadia/integration-confluence',
      name: 'ConfluenceClient',
    },
  });
  registerServiceType('confluence.toolkit', {
    providedBy: 'de.byte5.integration.confluence',
    typeImport: {
      from: '@omadia/integration-confluence',
      name: 'LocalSubAgentTool[]',
    },
  });
  registerServiceType('microsoft365.graph', {
    providedBy: 'de.byte5.integration.microsoft365',
    typeImport: {
      from: '@omadia/integration-microsoft365',
      name: 'Microsoft365Accessor',
    },
  });
}

const validSpec = {
  template: 'agent-integration',
  id: 'de.byte5.agent.weather',
  name: 'Weather',
  version: '0.1.0',
  description: 'fixture',
  category: 'analysis',
  depends_on: ['de.byte5.integration.openweather'],
  tools: [
    { id: 'get_forecast', description: 'a' },
    { id: 'get_history', description: 'b' },
  ],
  skill: { role: 'tester' },
  setup_fields: [
    { key: 'api_key', type: 'secret' },
    { key: 'region_default', type: 'string' },
  ],
  playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
  network: { outbound: ['api.openweather.org', 'api.weatherapi.com'] },
  slots: {},
};

const knownPlugins = (): readonly string[] => [
  'de.byte5.integration.openweather',
  'de.byte5.integration.confluence',
];

describe('manifestLinter.validateSpec — happy paths', () => {
  it('passes a fully-valid spec with known catalog', () => {
    const result = validateSpec(validSpec, { knownPluginIds: knownPlugins });
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  it('skips depends_on resolvability when knownPluginIds returns empty', () => {
    const result = validateSpec(validSpec, { knownPluginIds: () => [] });
    assert.equal(result.ok, true);
  });

  it('skips depends_on resolvability when knownPluginIds is not provided', () => {
    const result = validateSpec(validSpec);
    assert.equal(result.ok, true);
  });

  it('accepts empty depends_on', () => {
    const result = validateSpec(
      { ...validSpec, depends_on: [] },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, true);
  });

  it('accepts spec with 0 tools', () => {
    const result = validateSpec({ ...validSpec, tools: [] }, { knownPluginIds: knownPlugins });
    assert.equal(result.ok, true);
  });

  it('accepts empty network.outbound', () => {
    const result = validateSpec(
      { ...validSpec, network: { outbound: [] } },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, true);
  });
});

describe('manifestLinter.validateSpec — depends_on checks', () => {
  it('flags depends_on entries not in the catalog', () => {
    const result = validateSpec(
      { ...validSpec, depends_on: ['de.byte5.integration.unknown'] },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.kind, 'depends_on_unresolvable');
    assert.equal(result.violations[0]?.path, '/depends_on/0');
    assert.match(result.violations[0]?.message ?? '', /unknown/);
  });

  it('flags self-reference in depends_on', () => {
    const result = validateSpec(
      { ...validSpec, depends_on: [validSpec.id] },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.kind, 'depends_on_self_reference');
  });

  it('flags multiple unresolvable entries with separate violations', () => {
    const result = validateSpec(
      { ...validSpec, depends_on: ['unknown.a', 'unknown.b'] },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.violations.length, 2);
    assert.equal(result.violations[0]?.path, '/depends_on/0');
    assert.equal(result.violations[1]?.path, '/depends_on/1');
  });
});

describe('manifestLinter.validateSpec — tools[] checks', () => {
  it('flags duplicate tool ids', () => {
    const result = validateSpec(
      {
        ...validSpec,
        tools: [
          { id: 'get_forecast', description: 'a' },
          { id: 'get_forecast', description: 'b' },
        ],
      },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.kind, 'tool_id_duplicate');
    assert.match(result.violations[0]?.message ?? '', /0, 1/);
  });

  it('flags non-snake-case tool ids', () => {
    const cases = ['GetForecast', 'get-forecast', '0_lead', 'GET_FORECAST', 'get.forecast'];
    for (const id of cases) {
      const result = validateSpec(
        { ...validSpec, tools: [{ id, description: 'a' }] },
        { knownPluginIds: knownPlugins },
      );
      const synErr = result.violations.find((v) => v.kind === 'tool_id_invalid_syntax');
      assert.ok(synErr, `expected violation for tool id '${id}'`);
    }
  });

  it('accepts canonical snake_case tool ids', () => {
    const cases = ['get_forecast', 'list_alerts_v2', 'a', 'tool_42'];
    for (const id of cases) {
      const result = validateSpec(
        { ...validSpec, tools: [{ id, description: 'a' }] },
        { knownPluginIds: knownPlugins },
      );
      assert.equal(result.ok, true, `'${id}' should be valid`);
    }
  });
});

describe('manifestLinter.validateSpec — network.outbound checks', () => {
  it('rejects URLs (with protocol)', () => {
    const result = validateSpec(
      { ...validSpec, network: { outbound: ['https://api.example.com'] } },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.violations[0]?.kind, 'network_outbound_invalid');
  });

  it('rejects wildcards', () => {
    const result = validateSpec(
      { ...validSpec, network: { outbound: ['*.example.com'] } },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.violations[0]?.kind, 'network_outbound_invalid');
  });

  it('rejects bare strings without TLD', () => {
    const result = validateSpec(
      { ...validSpec, network: { outbound: ['localhost'] } },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.violations[0]?.kind, 'network_outbound_invalid');
  });

  it('rejects paths', () => {
    const result = validateSpec(
      { ...validSpec, network: { outbound: ['api.example.com/v1'] } },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.violations[0]?.kind, 'network_outbound_invalid');
  });

  it('accepts canonical hostnames', () => {
    const cases = ['api.example.com', 'api-v2.example.org', 'sub.domain.co.uk'];
    for (const host of cases) {
      const result = validateSpec(
        { ...validSpec, network: { outbound: [host] } },
        { knownPluginIds: knownPlugins },
      );
      assert.equal(result.ok, true, `'${host}' should be valid`);
    }
  });
});

describe('manifestLinter.validateSpec — setup_fields checks', () => {
  it('flags duplicate setup_field keys', () => {
    const result = validateSpec(
      {
        ...validSpec,
        setup_fields: [
          { key: 'api_key', type: 'secret' },
          { key: 'api_key', type: 'string' },
        ],
      },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.kind, 'setup_field_key_duplicate');
  });
});

describe('manifestLinter.validateSpec — reserved id checks', () => {
  it('flags spec.id in de.byte5.platform.* namespace', () => {
    const result = validateSpec(
      { ...validSpec, id: 'de.byte5.platform.foo' },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.kind, 'reserved_id');
  });

  it('flags spec.id in core.* namespace', () => {
    const result = validateSpec(
      { ...validSpec, id: 'core.something' },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.violations[0]?.kind, 'reserved_id');
  });

  it('respects custom reservedIdPrefixes override', () => {
    const result = validateSpec(
      { ...validSpec, id: 'foo.bar' },
      {
        knownPluginIds: knownPlugins,
        reservedIdPrefixes: ['foo.'],
      },
    );
    assert.equal(result.violations[0]?.kind, 'reserved_id');
  });
});

describe('manifestLinter.validateSpec — multi-violation aggregation', () => {
  it('collects violations across categories in a single pass', () => {
    const broken = {
      ...validSpec,
      id: 'core.bad',
      depends_on: ['unknown.plugin'],
      tools: [
        { id: 'BadName', description: 'a' },
        { id: 'BadName', description: 'b' },
      ],
      network: { outbound: ['*.bad.com'] },
    };
    const result = validateSpec(broken, { knownPluginIds: knownPlugins });
    const kinds = new Set(result.violations.map((v) => v.kind));
    assert.ok(kinds.has('reserved_id'));
    assert.ok(kinds.has('depends_on_unresolvable'));
    assert.ok(kinds.has('tool_id_invalid_syntax'));
    assert.ok(kinds.has('tool_id_duplicate'));
    assert.ok(kinds.has('network_outbound_invalid'));
  });
});

describe('manifestLinter.validateSpec — external_reads checks (Theme A)', () => {
  beforeEach(() => {
    seedServiceTypeRegistry();
  });

  it('flags external_read referencing an unknown service name', () => {
    const result = validateSpec(
      {
        ...validSpec,
        external_reads: [
          {
            id: 'fetch_x',
            description: 'x',
            service: 'totally.invented.service',
            method: 'm',
          },
        ],
      },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(result.ok, false);
    const v = result.violations.find(
      (x) => x.kind === 'external_read_unknown_service',
    );
    assert.ok(v, 'expected external_read_unknown_service violation');
    assert.equal(v.path, '/external_reads/0/service');
    assert.match(v.message, /totally\.invented\.service/);
  });

  it('flags external_read whose providing-plugin is missing from depends_on', () => {
    const result = validateSpec(
      {
        ...validSpec,
        // depends_on does NOT include de.byte5.integration.odoo
        external_reads: [
          {
            id: 'list_employees',
            description: 'x',
            service: 'odoo.client',
            method: 'execute',
          },
        ],
      },
      {
        knownPluginIds: () => [
          'de.byte5.integration.openweather',
          'de.byte5.integration.odoo',
        ],
      },
    );
    assert.equal(result.ok, false);
    const v = result.violations.find(
      (x) => x.kind === 'external_read_integration_missing',
    );
    assert.ok(v, 'expected external_read_integration_missing violation');
    assert.match(v.message, /de\.byte5\.integration\.odoo/);
    assert.match(v.message, /depends_on/);
  });

  it('passes a known service when depends_on contains the providing plugin', () => {
    const result = validateSpec(
      {
        ...validSpec,
        depends_on: ['de.byte5.integration.openweather', 'de.byte5.integration.odoo'],
        external_reads: [
          {
            id: 'list_employees',
            description: 'x',
            service: 'odoo.client',
            method: 'execute',
          },
        ],
      },
      {
        knownPluginIds: () => [
          'de.byte5.integration.openweather',
          'de.byte5.integration.odoo',
        ],
      },
    );
    assert.equal(result.ok, true);
  });

  it('accepts an empty/absent external_reads array', () => {
    const r1 = validateSpec(
      { ...validSpec, external_reads: [] },
      { knownPluginIds: knownPlugins },
    );
    assert.equal(r1.ok, true);
    const { external_reads: _omitted, ...withoutField } = validSpec as Record<string, unknown>;
    void _omitted;
    const r2 = validateSpec(withoutField, { knownPluginIds: knownPlugins });
    assert.equal(r2.ok, true);
  });
});

describe('manifestLinter.formatViolations', () => {
  it('returns "no manifest violations" for empty input', () => {
    assert.equal(formatViolations([]), 'no manifest violations');
  });

  it('renders violations as bracketed kind + path + message lines', () => {
    const result = validateSpec(
      { ...validSpec, depends_on: ['unknown.x'] },
      { knownPluginIds: knownPlugins },
    );
    const formatted = formatViolations(result.violations);
    assert.match(formatted, /\[depends_on_unresolvable\]/);
    assert.match(formatted, /\/depends_on\/0/);
  });
});
