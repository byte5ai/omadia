/**
 * #1942 — an assigned plugin whose package is gone (the canvas packages after
 * v0.201.0) runs nowhere, but the agent page showed it as "active". The
 * plugin lists of the operator-agents router mark it `package_missing`.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { FakeConfigRevisions } from './_helpers/fakeConfigRevisions.js';

const AGENT = { id: 'a-1', slug: 'fallback', name: 'Standard', archetype: 'standard', status: 'enabled' };
const ROWS = [
  { agentId: 'a-1', pluginId: '@omadia/ui-orchestrator', config: {}, enabled: true },
  { agentId: 'a-1', pluginId: '@omadia/odoo', config: { x: 1 }, enabled: true },
];

const store = {
  getAgentBySlug: (slug: string) => Promise.resolve(slug === AGENT.slug ? AGENT : undefined),
  listAgentPlugins: () => Promise.resolve(ROWS),
  ...(({ configRevisions, claimConfigRevision }) => ({ configRevisions, claimConfigRevision }))(new FakeConfigRevisions()),
};

async function pluginsOf(hasPackage?: (id: string) => boolean): Promise<Array<Record<string, unknown>>> {
  const app = express();
  app.use(
    '/agents',
    createOperatorAgentsRouter({
      getConfigStore: () => store,
      getRegistry: () => ({}),
      getChatSessionStore: () => undefined,
      ...(hasPackage ? { hasPackage } : {}),
    } as never),
  );
  const server = await listenLoopback(app);
  try {
    const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/agents/fallback/plugins`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { plugins: Array<Record<string, unknown>> }).plugins;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('#1942 assigned plugins without a package', () => {
  it('GET /:slug/plugins marks each assignment with package_missing', async () => {
    const plugins = await pluginsOf((id) => id === '@omadia/odoo');
    assert.deepEqual(plugins, [
      { id: '@omadia/ui-orchestrator', config: {}, enabled: true, package_missing: true },
      { id: '@omadia/odoo', config: { x: 1 }, enabled: true, package_missing: false },
    ]);
  });

  it('says nothing about packages when the router is mounted without the check', async () => {
    const plugins = await pluginsOf();
    assert.equal('package_missing' in plugins[0]!, false);
  });
});
