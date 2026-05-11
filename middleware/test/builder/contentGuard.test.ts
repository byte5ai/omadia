import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { checkSpecDelta, formatViolations } from '../../src/plugins/builder/contentGuard.js';

const baseSpec = {
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

describe('checkSpecDelta', () => {
  it('passes when nothing is removed', () => {
    const result = checkSpecDelta(baseSpec, baseSpec);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  it('passes when entries are added', () => {
    const next = {
      ...baseSpec,
      tools: [...baseSpec.tools, { id: 'get_alerts', description: 'c' }],
      depends_on: [...baseSpec.depends_on, 'de.byte5.integration.alerts'],
    };
    const result = checkSpecDelta(baseSpec, next);
    assert.equal(result.ok, true);
  });

  it('flags silent removal of a tool when user message is empty', () => {
    const next = { ...baseSpec, tools: [baseSpec.tools[0]] };
    const result = checkSpecDelta(baseSpec, next);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.field, 'tools');
    assert.deepEqual(result.violations[0]?.removed, ['get_history']);
  });

  it('flags silent removal of a depends_on entry', () => {
    const next = { ...baseSpec, depends_on: [] };
    const result = checkSpecDelta(baseSpec, next);
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.field, 'depends_on');
    assert.deepEqual(result.violations[0]?.removed, ['de.byte5.integration.openweather']);
  });

  it('flags silent removal of network.outbound hosts', () => {
    const next = {
      ...baseSpec,
      network: { outbound: ['api.openweather.org'] },
    };
    const result = checkSpecDelta(baseSpec, next);
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.field, 'network.outbound');
    assert.deepEqual(result.violations[0]?.removed, ['api.weatherapi.com']);
  });

  it('flags silent removal of setup_fields by key', () => {
    const next = {
      ...baseSpec,
      setup_fields: [baseSpec.setup_fields[0]],
    };
    const result = checkSpecDelta(baseSpec, next);
    assert.equal(result.ok, false);
    assert.equal(result.violations[0]?.field, 'setup_fields');
    assert.deepEqual(result.violations[0]?.removed, ['region_default']);
  });

  it('reports multiple violations across fields', () => {
    const next = {
      ...baseSpec,
      tools: [],
      depends_on: [],
      network: { outbound: [] },
    };
    const result = checkSpecDelta(baseSpec, next);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 3);
    const fields = result.violations.map((v) => v.field).sort();
    assert.deepEqual(fields, ['depends_on', 'network.outbound', 'tools']);
  });

  it('downgrades a removal to allowed when the user message names the entry (case-insensitive)', () => {
    const next = { ...baseSpec, tools: [baseSpec.tools[0]] };
    const result = checkSpecDelta(baseSpec, next, {
      userIntent: 'Please remove the GET_HISTORY tool, we never use it',
    });
    assert.equal(result.ok, true);
  });

  it('only allows the named removal — other concurrent removals still trigger', () => {
    const next = { ...baseSpec, tools: [], depends_on: [] };
    const result = checkSpecDelta(baseSpec, next, {
      userIntent: 'remove get_forecast and get_history',
    });
    // Both tools acknowledged → tools is fine, but depends_on still triggers.
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.field, 'depends_on');
  });

  it('treats a fresh-empty prev spec as no-baseline (no violations possible)', () => {
    const empty = {
      tools: [],
      depends_on: [],
      setup_fields: [],
      network: { outbound: [] },
    };
    const result = checkSpecDelta(empty, empty);
    assert.equal(result.ok, true);
  });

  it('handles missing fields on either side gracefully', () => {
    const result = checkSpecDelta({}, { tools: [] });
    assert.equal(result.ok, true);
  });

  it('formatViolations renders human-readable bulleted output', () => {
    const next = { ...baseSpec, tools: [], depends_on: [] };
    const result = checkSpecDelta(baseSpec, next);
    const formatted = formatViolations(result.violations);
    assert.match(formatted, /\[tools\]/);
    assert.match(formatted, /\[depends_on\]/);
    assert.match(formatted, /get_forecast/);
  });

  it('userIntent substring match is bidirectional via lowercasing', () => {
    const next = { ...baseSpec, tools: [baseSpec.tools[0]] };
    const upper = checkSpecDelta(baseSpec, next, { userIntent: 'GET_HISTORY' });
    const mixed = checkSpecDelta(baseSpec, next, { userIntent: 'Get_History' });
    assert.equal(upper.ok, true);
    assert.equal(mixed.ok, true);
  });
});
