/**
 * #2043 — a facilitator gets the facilitation engine without a manual grant,
 * in both orders (facilitator first, engine first), and nothing else is ever
 * attached. The engine in turn is never attached to a standard agent.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  attachEngineToFacilitator,
  attachEngineToFacilitators,
} from '../src/platform/facilitatorEngineAttach.js';
import { assertEngineOnlyForFacilitators } from '../src/platform/facilitatorGuard.js';
import { attachablePluginIds } from '../src/plugins/defaultOrchestratorAttach.js';

const ENGINE = '@omadia/agent-facilitator';
const ODOO = '@omadia/integration-odoo';

interface Row {
  agentId: string;
  pluginId: string;
  enabled: boolean;
}

function world(installed: string[]) {
  const agents = [
    { id: 'a-mara', slug: 'mara', kind: 'facilitator' as const },
    { id: 'a-nora', slug: 'nora', kind: 'facilitator' as const },
    { id: 'a-hr', slug: 'hr', kind: 'standard' as const },
  ];
  const rows: Row[] = [];
  const provides: Record<string, string[]> = {
    [ENGINE]: ['facilitationEngine@1'],
    '@acme/engine-2': ['facilitationEngine@1'],
    [ODOO]: ['odoo@1'],
  };
  const state = { installed };
  return {
    agents,
    rows,
    state,
    sources: {
      installedRegistry: { list: () => state.installed.map((id) => ({ id, status: 'active' })) } as never,
      catalog: { get: (id: string) => (provides[id] ? { plugin: { provides: provides[id] } } : undefined) } as never,
    },
    store: {
      listAgents: () => Promise.resolve(agents),
      listAgentPlugins: (agentId: string) => Promise.resolve(rows.filter((r) => r.agentId === agentId)),
      upsertAgentPlugin: (agentId: string, input: { pluginId: string; enabled?: boolean }) => {
        rows.push({ agentId, pluginId: input.pluginId, enabled: input.enabled ?? true });
        return Promise.resolve({});
      },
    } as never,
  };
}

describe('facilitation engine auto-attach', () => {
  it('engine first: a newly created facilitator gets it', async () => {
    const w = world([ENGINE, ODOO]);
    assert.equal(await attachEngineToFacilitator(w.store, w.agents[0]!, w.sources), ENGINE);
    assert.deepEqual(w.rows, [{ agentId: 'a-mara', pluginId: ENGINE, enabled: true }]);
    // Idempotent, and a standard agent is never touched.
    assert.equal(await attachEngineToFacilitator(w.store, w.agents[0]!, w.sources), undefined);
    assert.equal(await attachEngineToFacilitator(w.store, w.agents[2]!, w.sources), undefined);
    assert.equal(w.rows.length, 1);
  });

  it('facilitators first: installing the engine later attaches it to all of them, and only it', async () => {
    const w = world([ODOO]);
    assert.deepEqual(await attachEngineToFacilitators(w.store, w.sources), [], 'no engine yet');
    assert.deepEqual(w.rows, []);
    w.state.installed = [ODOO, ENGINE];
    const logs: string[] = [];
    assert.deepEqual(await attachEngineToFacilitators(w.store, w.sources, (m) => logs.push(m)), ['mara', 'nora']);
    assert.deepEqual(
      w.rows.map((r) => `${r.agentId}:${r.pluginId}`),
      [`a-mara:${ENGINE}`, `a-nora:${ENGINE}`],
    );
    assert.match(logs[0]!, /facilitation engine attached to: mara, nora/);
    assert.deepEqual(await attachEngineToFacilitators(w.store, w.sources), [], 'second pass changes nothing');
  });

  it('a replaced engine is attached; a disabled row is left to the operator; two engines attach nothing', async () => {
    const w = world([ENGINE]);
    await attachEngineToFacilitators(w.store, w.sources);
    // The old engine is uninstalled (its rows are purged by the uninstall) and another takes its place.
    w.rows.length = 0;
    w.state.installed = ['@acme/engine-2'];
    assert.deepEqual(await attachEngineToFacilitators(w.store, w.sources), ['mara', 'nora']);
    assert.ok(w.rows.every((r) => r.pluginId === '@acme/engine-2'));

    const disabled = world([ENGINE]);
    disabled.rows.push({ agentId: 'a-mara', pluginId: ENGINE, enabled: false });
    assert.deepEqual(await attachEngineToFacilitators(disabled.store, disabled.sources), ['nora']);
    assert.equal(disabled.rows.find((r) => r.agentId === 'a-mara')!.enabled, false);

    const two = world([ENGINE, '@acme/engine-2']);
    assert.deepEqual(await attachEngineToFacilitators(two.store, two.sources), []);
    assert.deepEqual(two.rows, []);
  });

  it('the engine is never part of a default attach, and cannot be granted to a standard agent', () => {
    const w = world([ENGINE, ODOO]);
    const catalog = w.sources.catalog as { get(id: string): never };
    assert.deepEqual(attachablePluginIds([ENGINE, ODOO, '@unknown/x'], catalog), [ODOO, '@unknown/x']);
    assert.throws(
      () => assertEngineOnlyForFacilitators(w.agents[2]!, [{ pluginId: ENGINE, enabled: true }], w.sources),
      /can only be granted to a facilitator/,
    );
    assert.doesNotThrow(() =>
      assertEngineOnlyForFacilitators(w.agents[2]!, [{ pluginId: ENGINE, enabled: false }, { pluginId: ODOO }], w.sources),
    );
    assert.doesNotThrow(() =>
      assertEngineOnlyForFacilitators(w.agents[0]!, [{ pluginId: ENGINE, enabled: true }], w.sources),
    );
  });
});
