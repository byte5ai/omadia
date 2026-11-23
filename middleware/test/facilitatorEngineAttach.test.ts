/**
 * #2043 — a facilitator gets the facilitation engine without a manual grant,
 * in both orders (facilitator first, engine first), and nothing else is ever
 * attached. The engine in turn is never attached to a standard agent.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  attachEngineToFacilitator,
  attachEngineToFacilitators,
  syncArchetypesAndAttachEngine,
} from '../src/platform/facilitatorEngineAttach.js';
import { createSubscriptionGroundCheck } from '../src/channels/conversationMessages/wiring.js';
import {
  assertEngineOnlyForFacilitators,
  resolveFacilitationEngine,
} from '../src/platform/facilitatorGuard.js';
import { capabilityPluginIds } from '../src/plugins/capabilityPlugins.js';

const ENGINE = '@omadia/agent-facilitator';
const ODOO = '@omadia/integration-odoo';

interface Row {
  agentId: string;
  pluginId: string;
  enabled: boolean;
}

function world(installed: string[]) {
  const agents = [
    { id: 'a-mara', slug: 'mara', archetype: 'facilitator' as const },
    { id: 'a-nora', slug: 'nora', archetype: 'facilitator' as const },
    { id: 'a-hr', slug: 'hr', archetype: 'standard' as const },
  ];
  const rows: Row[] = [];
  const engine = { kind: 'archetype', archetype: { id: 'facilitator' } };
  const plugins: Record<string, object> = {
    [ENGINE]: engine,
    '@acme/engine-2': engine,
    [ODOO]: { kind: 'integration', provides: ['odoo@1'] },
  };
  const state = { installed };
  return {
    agents,
    rows,
    state,
    sources: {
      installedRegistry: { list: () => state.installed.map((id) => ({ id, status: 'active' })) } as never,
      catalog: { get: (id: string) => (plugins[id] ? { plugin: plugins[id] } : undefined) } as never,
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
      (w.rows as Row[]).map((r) => `${r.agentId}:${r.pluginId}`),
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

  it('the ground of a subscription: a running plugin, the agent, its identity', async () => {
    const w = world([ENGINE]);
    let status = 'active';
    let agent: { id: string; status: string; archetype: string } | undefined = { id: 'a-mara', status: 'enabled', archetype: 'facilitator' };
    let identities = [{ agentId: 'a-mara', channelType: 'teams', channelKey: '28:AAAA-MARA' }];
    const ground = createSubscriptionGroundCheck({
      engineSources: () => ({
        ...w.sources,
        installedRegistry: { list: () => w.state.installed.map((id) => ({ id, status })) } as never,
      }),
      getConfigStore: () =>
        ({
          getAgentById: () => Promise.resolve(agent),
          listChannelIdentities: () => Promise.resolve(identities),
        }) as never,
    });
    const subscription = {
      id: 's1',
      agentId: 'a-mara',
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: 'c',
      channelKey: '28:aaaa-mara',
      pluginId: ENGINE,
      createdAt: new Date(0),
      processId: 'facilitation-1',
      mode: 'all' as const,
    };
    assert.equal(await ground(subscription), undefined, 'stands');
    status = 'inactive';
    assert.equal(await ground(subscription), 'the plugin that subscribed is inactive');
    status = 'active';
    // Who may run a process of this agent is not asked here: the subscription
    // stands on its process's execution scope, which the hub checks, and which
    // was revoked if the plugin was uninstalled. A second engine next to it,
    // or the plugin missing from the registry, ends nothing by itself.
    w.state.installed = [ENGINE, '@acme/engine-2'];
    assert.equal(await ground(subscription), undefined);
    w.state.installed = [];
    assert.equal(await ground(subscription), undefined);
    w.state.installed = [ENGINE];
    agent = { id: 'a-mara', status: 'disabled', archetype: 'facilitator' };
    assert.equal(await ground(subscription), 'the agent is disabled');
    agent = undefined;
    assert.equal(await ground(subscription), 'the agent was deleted');
    agent = { id: 'a-mara', status: 'enabled', archetype: 'facilitator' };
    identities = [{ agentId: 'a-mara', channelType: 'teams', channelKey: '28:another-app' }];
    assert.match((await ground(subscription))!, /no longer has the teams identity/);
    identities = [];
    assert.match((await ground(subscription))!, /no longer has the teams identity/);
  });

  it('the engine is never offered as a capability, and cannot be granted to a standard agent', () => {
    const w = world([ENGINE, ODOO]);
    const catalog = w.sources.catalog as { get(id: string): never };
    // #2054 — an id the catalog does not know is not offered either.
    assert.deepEqual(capabilityPluginIds([ENGINE, ODOO, '@unknown/x'], catalog), [ODOO]);
    assert.throws(
      () => assertEngineOnlyForFacilitators(w.agents[2]!, [{ pluginId: ENGINE, enabled: true }], w.sources),
      /an archetype plugin can only be granted to agents of its own archetype/,
    );
    assert.doesNotThrow(() =>
      assertEngineOnlyForFacilitators(w.agents[2]!, [{ pluginId: ENGINE, enabled: false }, { pluginId: ODOO }], w.sources),
    );
    assert.doesNotThrow(() =>
      assertEngineOnlyForFacilitators(w.agents[0]!, [{ pluginId: ENGINE, enabled: true }], w.sources),
    );
  });
});

describe('syncArchetypesAndAttachEngine: the boot and install path', () => {
  const run = async (opts: { store?: object; syncFails?: boolean; attachFails?: boolean }) => {
    const calls: string[] = [];
    const logs: string[] = [];
    await syncArchetypesAndAttachEngine({
      sync: () => {
        calls.push('sync');
        return opts.syncFails ? Promise.reject(new Error('catalog down')) : Promise.resolve();
      },
      getStore: () => opts.store as never,
      attach: () => {
        calls.push('attach');
        return opts.attachFails ? Promise.reject(new Error('db down')) : Promise.resolve();
      },
      reload: () => {
        calls.push('reload');
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
    });
    return { calls, logs };
  };

  it('syncs the archetypes also without a config store, and attaches nothing then', async () => {
    assert.deepEqual((await run({})).calls, ['sync']);
  });

  it('with a config store: sync, then attach, then rebuild', async () => {
    assert.deepEqual((await run({ store: {} })).calls, ['sync', 'attach', 'reload']);
  });

  it('a failed sync attaches nothing and says so; a failed attach is logged, never thrown', async () => {
    const failedSync = await run({ store: {}, syncFails: true });
    assert.deepEqual(failedSync.calls, ['sync']);
    assert.match(failedSync.logs.join('\n'), /archetype sync FAILED: catalog down/);
    const failedAttach = await run({ store: {}, attachFails: true });
    assert.deepEqual(failedAttach.calls, ['sync', 'attach']);
    assert.match(failedAttach.logs.join('\n'), /facilitation engine attach FAILED: db down/);
  });
});

describe('wiring: the boot path syncs archetypes before it needs a config store', () => {
  it('index.ts builds attachFacilitationEngine on syncArchetypesAndAttachEngine', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    const start = source.indexOf('const attachFacilitationEngine');
    assert.ok(start > 0, 'attachFacilitationEngine is defined');
    const body = source.slice(start, source.indexOf('const propagatePluginInstall', start));
    assert.match(body, /syncArchetypesAndAttachEngine\(/);
    assert.doesNotMatch(body, /if \(!store\) return/, 'no early return before the sync');
  });
});
