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
import { createSubscriptionGroundCheck } from '../src/channels/conversationMessages/wiring.js';
import {
  assertEngineOnlyForFacilitators,
  createSqlGrantView,
  resolveFacilitationEngine,
} from '../src/platform/facilitatorGuard.js';
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

  it('a declared engine is attached only once the operator granted it SQL (the trust step)', async () => {
    const w = world([ENGINE]);
    let granted = false;
    const sources = { ...w.sources, isSqlGranted: (id: string) => granted && id === ENGINE };
    assert.deepEqual(resolveFacilitationEngine(sources), { state: 'ungranted', pluginId: ENGINE });
    assert.deepEqual(await attachEngineToFacilitators(w.store, sources), [], 'declaring is not enough');
    assert.equal(await attachEngineToFacilitator(w.store, w.agents[0]!, sources), undefined);
    assert.deepEqual(w.rows, []);
    granted = true;
    assert.deepEqual(resolveFacilitationEngine(sources), { state: 'bound', pluginId: ENGINE });
    assert.deepEqual(await attachEngineToFacilitators(w.store, sources), ['mara', 'nora']);
  });

  it('the SQL grant view is synchronous, refreshes itself when stale and keeps the last state on failure', async () => {
    let now = 0;
    let rows: string[] | Error = [];
    const logs: string[] = [];
    const view = createSqlGrantView({
      listGranted: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)),
      maxAgeMs: 1_000,
      now: () => now,
      log: (m) => logs.push(m),
    });
    assert.equal(view.isGranted(ENGINE), false, 'unknown is not granted');
    await view.refresh(); // the read above started one; overlapping refreshes coalesce
    rows = [ENGINE];
    await view.refresh();
    assert.equal(view.isGranted(ENGINE), true);
    // Revoked in the operator UI: noticed by the next stale read, no restart.
    rows = [];
    now = 2_000;
    assert.equal(view.isGranted(ENGINE), true, 'the stale read still answers, and triggers a refresh');
    await view.refresh();
    assert.equal(view.isGranted(ENGINE), false);
    rows = [ENGINE];
    await view.refresh();
    rows = new Error('pool exhausted');
    await view.refresh();
    assert.equal(view.isGranted(ENGINE), true, 'a failed lookup changes nothing');
    assert.match(logs[0]!, /SQL grant lookup failed/);
  });

  it('the ground of a subscription: engine, agent, identity', async () => {
    const w = world([ENGINE]);
    let status = 'active';
    let agent: { id: string; status: string; kind: string } | undefined = { id: 'a-mara', status: 'enabled', kind: 'facilitator' };
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
    };
    assert.equal(await ground(subscription), undefined, 'stands');
    status = 'inactive';
    assert.match((await ground(subscription))!, /engine plugin is inactive/);
    status = 'active';
    w.state.installed = [ENGINE, '@acme/engine-2'];
    assert.match((await ground(subscription))!, /no longer the facilitation engine/);
    w.state.installed = [];
    assert.match((await ground(subscription))!, /no longer the facilitation engine/);
    w.state.installed = [ENGINE];
    agent = { id: 'a-mara', status: 'disabled', kind: 'facilitator' };
    assert.equal(await ground(subscription), 'the agent is disabled');
    agent = undefined;
    assert.equal(await ground(subscription), 'the agent was deleted');
    agent = { id: 'a-mara', status: 'enabled', kind: 'facilitator' };
    identities = [{ agentId: 'a-mara', channelType: 'teams', channelKey: '28:another-app' }];
    assert.match((await ground(subscription))!, /no longer has the teams identity/);
    identities = [];
    assert.match((await ground(subscription))!, /no longer has the teams identity/);
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
