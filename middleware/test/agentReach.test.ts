/**
 * #2054 — spec 2042 §5.7: the reach of an agent is derived deterministically
 * from its effective grants (plugin grants + MCP grants), read and write
 * marked separately; "broad" = every connected system, at least two.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeAgentReach,
  declaredSideEffects,
  discoveredMcpTools,
  requiresBroadReachConfirmation,
  type ReachEnvironment,
  type ReachGrants,
} from '../src/agents/agentReach.js';
import { capabilityPluginIds, isCapabilityPlugin } from '../src/plugins/capabilityPlugins.js';

const ENV: ReachEnvironment = {
  plugins: [
    { id: '@acme/odoo', name: 'Odoo', sideEffects: ['read', 'write'] },
    { id: '@acme/search', name: 'Web search', sideEffects: ['read'] },
    { id: '@acme/legacy', name: 'Legacy', sideEffects: [] },
  ],
  mcpServers: [
    {
      id: 'srv-jira',
      name: 'jira',
      tools: [
        { name: 'search_issues', readOnly: true },
        { name: 'create_issue', readOnly: false },
        { name: 'comment', readOnly: undefined },
      ],
    },
    { id: 'srv-empty', name: 'empty', tools: [] },
  ],
};

const NONE: ReachGrants = { plugins: [], mcpToolGrants: [], pluginMcpGrants: [] };

describe('computeAgentReach', () => {
  it('an agent without grants reaches nothing', () => {
    const reach = computeAgentReach(ENV, NONE);
    assert.deepEqual(reach.systems, []);
    assert.equal(reach.connectedSystems, 5);
    assert.equal(reach.coversEverySystem, false);
    assert.equal(reach.broad, false);
  });

  it('marks read and write per plugin from the manifest, conservatively when undeclared', () => {
    const reach = computeAgentReach(ENV, {
      ...NONE,
      plugins: [
        { pluginId: '@acme/odoo', enabled: true },
        { pluginId: '@acme/search', enabled: true },
        { pluginId: '@acme/legacy', enabled: true },
        // Not a capability plugin of the instance (a channel, say): no system.
        { pluginId: '@acme/channel', enabled: true },
      ],
    });
    assert.deepEqual(
      reach.systems.map((s) => [s.ref, s.read, s.write, s.declared]),
      [
        ['@acme/legacy', true, true, false],
        ['@acme/odoo', true, true, true],
        ['@acme/search', true, false, true],
      ],
    );
  });

  it('a disabled grant row is no reach', () => {
    const reach = computeAgentReach(ENV, { ...NONE, plugins: [{ pluginId: '@acme/odoo', enabled: false }] });
    assert.deepEqual(reach.systems, []);
  });

  it('marks MCP tools by readOnlyHint; an unannotated tool is a write, an unknown tool is anything', () => {
    const readOnly = computeAgentReach(ENV, {
      ...NONE,
      mcpToolGrants: [{ mcpServerId: 'srv-jira', toolName: 'search_issues' }],
    });
    assert.deepEqual(
      readOnly.systems.map((s) => [s.key, s.read, s.write, s.declared, s.via]),
      [['mcp:srv-jira', true, false, true, ['grant']]],
    );
    const unannotated = computeAgentReach(ENV, {
      ...NONE,
      mcpToolGrants: [{ mcpServerId: 'srv-jira', toolName: 'comment' }],
    });
    assert.deepEqual(unannotated.systems.map((s) => [s.read, s.write, s.declared]), [[false, true, false]]);
    const unknown = computeAgentReach(ENV, {
      ...NONE,
      mcpToolGrants: [{ mcpServerId: 'srv-jira', toolName: 'gone' }],
    });
    assert.deepEqual(unknown.systems.map((s) => [s.read, s.write, s.declared]), [[true, true, false]]);
  });

  it('reaches a server through a held plugin that holds it — the whole server', () => {
    const grants: ReachGrants = {
      plugins: [{ pluginId: '@acme/odoo', enabled: true }],
      mcpToolGrants: [],
      pluginMcpGrants: [
        { pluginId: '@acme/odoo', mcpServerId: 'srv-jira' },
        // Held by a plugin the agent does not hold: no reach.
        { pluginId: '@acme/search', mcpServerId: 'srv-empty' },
      ],
    };
    const reach = computeAgentReach(ENV, grants);
    const jira = reach.systems.find((s) => s.key === 'mcp:srv-jira');
    assert.deepEqual(jira && [jira.read, jira.write, jira.via], [true, true, ['@acme/odoo']]);
    assert.equal(reach.systems.some((s) => s.key === 'mcp:srv-empty'), false);
  });

  it('broad = every connected system, and at least two of them', () => {
    const all: ReachGrants = {
      plugins: ENV.plugins.map((p) => ({ pluginId: p.id, enabled: true })),
      mcpToolGrants: [{ mcpServerId: 'srv-jira', toolName: 'search_issues' }],
      pluginMcpGrants: [{ pluginId: '@acme/odoo', mcpServerId: 'srv-empty' }],
    };
    const broad = computeAgentReach(ENV, all);
    assert.equal(broad.systems.length, 5);
    assert.equal(broad.broad, true);

    const almost = computeAgentReach(ENV, { ...all, mcpToolGrants: [] });
    assert.equal(almost.broad, false);
    assert.equal(requiresBroadReachConfirmation(almost, broad), true);
    assert.equal(requiresBroadReachConfirmation(broad, broad), false, 'only the change INTO broad asks');

    const single: ReachEnvironment = { plugins: [ENV.plugins[0]!], mcpServers: [] };
    const one = computeAgentReach(single, { ...NONE, plugins: [{ pluginId: '@acme/odoo', enabled: true }] });
    assert.equal(one.coversEverySystem, true);
    assert.equal(one.broad, false, 'one system is never "every connected system"');
  });
});

describe('reach inputs', () => {
  it('reads side_effects from manifest capabilities, dropping unknown values', () => {
    assert.deepEqual(
      declaredSideEffects({
        capabilities: [{ side_effects: 'read' }, { side_effects: 'write' }, { side_effects: 'delete' }, {}],
      }),
      ['read', 'write'],
    );
    assert.deepEqual(declaredSideEffects({}), []);
    assert.deepEqual(declaredSideEffects(null), []);
  });

  it('reads readOnlyHint from discovered MCP tools', () => {
    assert.deepEqual(
      discoveredMcpTools([
        { name: 'a', annotations: { readOnlyHint: true } },
        { name: 'b', annotations: {} },
        { name: 'c' },
        { nope: true },
      ]),
      [
        { name: 'a', readOnly: true },
        { name: 'b', readOnly: undefined },
        { name: 'c', readOnly: undefined },
      ],
    );
  });

  it('reads the flat readOnlyHint McpManager.listTools persists', () => {
    assert.deepEqual(discoveredMcpTools([{ name: 'd', readOnlyHint: true }]), [
      { name: 'd', readOnly: true },
    ]);
  });
});

describe('isCapabilityPlugin', () => {
  it('capabilities are integration, tool and skill; nothing else, not the retired agent kind', () => {
    const p = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
      ({ id, kind, ...extra }) as never;
    assert.equal(isCapabilityPlugin(p('@a/odoo', 'integration')), true);
    assert.equal(isCapabilityPlugin(p('@a/search', 'tool')), true);
    assert.equal(isCapabilityPlugin(p('@a/offers', 'skill')), true);
    assert.equal(isCapabilityPlugin(p('@a/hr', 'agent')), false);
    assert.equal(isCapabilityPlugin(p('@a/teams', 'channel')), false);
    assert.equal(isCapabilityPlugin(p('@a/llm', 'extension')), false);
    assert.equal(isCapabilityPlugin(p('@a/facilitator', 'archetype')), false);
    assert.equal(isCapabilityPlugin(p('@omadia/orchestrator', 'tool')), false);
    assert.equal(isCapabilityPlugin(p('@a/ref', 'agent', { is_reference_only: true })), false);
    assert.equal(isCapabilityPlugin(undefined), false);
    const catalog = { get: (id: string) => (id === '@a/odoo' ? { plugin: p('@a/odoo', 'integration') } : undefined) };
    assert.deepEqual(capabilityPluginIds(['@a/odoo', '@a/unknown'], catalog as never), ['@a/odoo']);
  });
});
