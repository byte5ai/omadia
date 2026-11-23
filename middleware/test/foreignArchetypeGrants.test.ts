/**
 * S3c — a grant of an archetype plugin held by an agent of ANOTHER archetype
 * (for example the facilitation engine on a standard agent, a row from
 * before #2088) is invalid. Found live on the default agent: it made every
 * replace of that agent's grant set fail with 409, so the operator could not
 * remove any grant there.
 *
 *  1. The kernel removes such grants at boot and whenever plugins or grants
 *     change, with a warning per removal.
 *  2. A replace of the grant set removes them too, whether the request lists
 *     them or not, and never fails on them. A NEW such grant is still refused.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { revokeForeignArchetypeGrants } from '../src/platform/facilitatorEngineAttach.js';
import { foreignArchetypeGrants } from '../src/platform/facilitatorGuard.js';
import { ENGINE, ODOO, routesHarness } from './_helpers/facilitatorRoutesHarness.js';

const X = 'de.byte5.agent.x';
const TRACKER = '@omadia/agent-github-issue-tracker';

const catalog = {
  get: (id: string) =>
    id === ENGINE
      ? ({ plugin: { id, kind: 'archetype', archetype: { id: 'facilitator' } } } as never)
      : ({ plugin: { id, kind: 'integration' } } as never),
};

describe('foreign archetype grants: boot reconcile', () => {
  it('finds them, disabled ones included, and never the agent’s own archetype', () => {
    const grants = [{ pluginId: ENGINE }, { pluginId: ODOO }];
    assert.deepEqual(foreignArchetypeGrants({ archetype: 'standard' }, grants, catalog), [
      { pluginId: ENGINE, archetype: 'facilitator' },
    ]);
    assert.deepEqual(foreignArchetypeGrants({ archetype: 'facilitator' }, grants, catalog), []);
  });

  it('removes them from every agent with a warning, keeps everything else, and goes on after a failure', async () => {
    const rows = [
      { agentId: 'a-fallback', pluginId: ENGINE, enabled: false },
      { agentId: 'a-fallback', pluginId: ODOO, enabled: true },
      { agentId: 'a-mara', pluginId: ENGINE, enabled: true },
      { agentId: 'a-broken', pluginId: ENGINE, enabled: true },
    ];
    const store = {
      listAgents: () =>
        Promise.resolve([
          { id: 'a-broken', slug: 'broken', archetype: 'standard' },
          { id: 'a-fallback', slug: 'fallback', archetype: 'standard' },
          { id: 'a-mara', slug: 'mara', archetype: 'facilitator' },
        ]),
      listAgentPlugins: (agentId: string) => {
        if (agentId === 'a-broken') return Promise.reject(new Error('connection reset'));
        return Promise.resolve(rows.filter((r) => r.agentId === agentId));
      },
      removeAgentPlugin: (agentId: string, pluginId: string) => {
        rows.splice(rows.findIndex((r) => r.agentId === agentId && r.pluginId === pluginId), 1);
        return Promise.resolve();
      },
    } as never;
    const logs: string[] = [];

    const revoked = await revokeForeignArchetypeGrants(store, catalog, (m) => logs.push(m));

    assert.deepEqual(revoked, [{ agentSlug: 'fallback', pluginId: ENGINE, archetype: 'facilitator' }]);
    assert.deepEqual(
      rows.map((r) => `${r.agentId}:${r.pluginId}`),
      [`a-fallback:${ODOO}`, `a-mara:${ENGINE}`, `a-broken:${ENGINE}`],
    );
    assert.ok(logs.some((m) => /removed the grant of '@omadia\/agent-facilitator' from agent 'fallback'/.test(m)));
    assert.ok(logs.some((m) => /'broken'.*connection reset/.test(m)), 'a failing agent is logged, not thrown');
  });
});

describe('foreign archetype grants: replacing an agent’s grant set', () => {
  const h = routesHarness();

  const holdLegacy = (): void => {
    h.grants = [
      { agentId: 'id-hr', pluginId: ENGINE, enabled: true, config: {} },
      { agentId: 'id-hr', pluginId: ODOO, enabled: true, config: {} },
      { agentId: 'id-hr', pluginId: X, enabled: false, config: {} },
      { agentId: 'id-hr', pluginId: TRACKER, enabled: false, config: {} },
    ];
  };

  it('the set as the store page sends it back (legacy grant included) goes through and drops the legacy grant', async () => {
    holdLegacy();
    const res = await h.call('PUT', '/agents/hr/plugins', {
      plugins: [
        { id: ENGINE, enabled: true },
        { id: ODOO, enabled: true },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json['removed_invalid_grants'], [ENGINE], 'the answer says the legacy grant is gone');
    const removed = h.writes.filter((w) => w.startsWith('removeAgentPlugin'));
    assert.deepEqual(removed, [
      `removeAgentPlugin(["id-hr","${ENGINE}"])`,
      `removeAgentPlugin(["id-hr","${X}"])`,
      `removeAgentPlugin(["id-hr","${TRACKER}"])`,
    ]);
    assert.equal(
      h.writes.some((w) => w.startsWith('upsertAgentPlugin') && w.includes(ENGINE)),
      false,
      'the legacy grant is not written back',
    );
  });

  it('a set that leaves the legacy grant out removes it too', async () => {
    holdLegacy();
    const res = await h.call('PUT', '/agents/hr/plugins', { plugins: [{ id: ODOO, enabled: true }] });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(h.writes.includes(`removeAgentPlugin(["id-hr","${ENGINE}"])`));
  });

  it('a NEW grant of a foreign archetype plugin is still refused, and nothing is written', async () => {
    h.grants = [{ agentId: 'id-hr', pluginId: ODOO, enabled: true, config: {} }];
    const res = await h.call('PUT', '/agents/hr/plugins', {
      plugins: [
        { id: ENGINE, enabled: true },
        { id: ODOO, enabled: true },
      ],
    });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json['message']), /archetype plugin can only be granted to agents of its own archetype/);
    assert.deepEqual(h.writes, []);
  });
});
