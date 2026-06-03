/**
 * Per-Agent domain-tool isolation (`scopeDomainToolsToPlugins`).
 *
 * Regression: the "marketing" Agent — whose only enabled plugin was
 * `de.byte5.agent.x` — could call `query_odoo_accounting` and reach Odoo,
 * because the kernel hydrated EVERY per-Agent orchestrator with the full
 * domain-tool set. An Agent must only receive sub-agent tools whose backing
 * plugin is enabled on it; the fallback (all plugins) still gets everything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DomainTool } from '../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import {
  scopeDomainToolsToPlugins,
  type AgentPluginScope,
} from '../src/agents/scopeDomainTools.js';

function tool(name: string, agentId?: string): DomainTool {
  return {
    name,
    domain: 'test',
    ...(agentId !== undefined ? { agentId } : {}),
    spec: {
      name,
      description: name,
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handle: () => Promise.resolve('ok'),
  };
}

const ODOO = tool('query_odoo_accounting', 'de.byte5.agent.odoo-accounting');
const X = tool('query_x', 'de.byte5.agent.x');
const CONFLUENCE = tool('query_confluence_playbook', 'de.byte5.agent.confluence');
const MEMORY = tool('memory'); // core helper, no agentId
const ALL = [ODOO, X, CONFLUENCE, MEMORY];

function plugin(pluginId: string, enabled = true): AgentPluginScope {
  return { pluginId, enabled };
}

test('a scoped Agent only receives tools for its enabled plugins (+ core helpers)', () => {
  // "marketing" enables only the X plugin.
  const scoped = scopeDomainToolsToPlugins(ALL, [plugin('de.byte5.agent.x')]);
  const names = scoped.map((t) => t.name).sort();
  assert.deepEqual(names, ['memory', 'query_x']);
  // The leak this fixes: Odoo must NOT be reachable.
  assert.ok(!names.includes('query_odoo_accounting'));
});

test('the fallback Agent (all plugins enabled) still receives the full set', () => {
  const fallbackPlugins = [
    plugin('de.byte5.agent.odoo-accounting'),
    plugin('de.byte5.agent.x'),
    plugin('de.byte5.agent.confluence'),
  ];
  const scoped = scopeDomainToolsToPlugins(ALL, fallbackPlugins);
  assert.equal(scoped.length, ALL.length);
});

test('a disabled plugin row does NOT grant its tool', () => {
  const scoped = scopeDomainToolsToPlugins(ALL, [
    plugin('de.byte5.agent.odoo-accounting', false), // disabled / quarantined
    plugin('de.byte5.agent.x', true),
  ]);
  const names = scoped.map((t) => t.name).sort();
  assert.deepEqual(names, ['memory', 'query_x']);
});

test('core helper tools (no agentId) are always included, even for a plugin-less Agent', () => {
  const scoped = scopeDomainToolsToPlugins(ALL, []);
  assert.deepEqual(
    scoped.map((t) => t.name),
    ['memory'],
  );
});
