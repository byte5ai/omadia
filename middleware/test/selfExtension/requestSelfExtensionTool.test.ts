import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createRequestSelfExtensionTool } from '../../src/plugins/selfExtension/requestSelfExtensionTool.js';
import { OperatorGate } from '../../src/plugins/selfExtension/operatorGate.js';
import { SelfExtendRegistry } from '../../src/plugins/selfExtension/selfExtendRegistry.js';
import type { PluginCatalog } from '../../src/plugins/manifestLoader.js';
import type { NotificationRouter } from '../../src/platform/notificationRouter.js';
import type { ExtensionTemplate } from '@omadia/plugin-api';
import type { Plugin } from '../../src/api/admin-v1.js';

const AGENT = 'de.byte5.integration.dynamics-crm';

function dynPlugin(): Plugin {
  return {
    id: AGENT,
    depends_on: [],
    privacy_class: 'strict',
    permissions_summary: {
      memory_reads: [], memory_writes: [], graph_reads: [], graph_writes: [],
      network_outbound: ['api.dynamics.com'],
    },
  } as unknown as Plugin;
}

const DELTA: ExtensionTemplate = {
  id: 'odata.delta',
  title: 'Delta',
  description: 'change tracking',
  paramsSchema: { type: 'object' },
  requires: { networkOutbound: ['api.dynamics.com'] },
};

function setup(opts: { template?: ExtensionTemplate; withTemplates?: boolean } = {}) {
  let n = 0;
  const gate = new OperatorGate({ now: () => 1, genId: () => `q${++n}` });
  const registry = new SelfExtendRegistry();
  if (opts.withTemplates !== false) registry.register(AGENT, [opts.template ?? DELTA]);
  const catalog = {
    get: (id: string) => (id === AGENT ? { plugin: dynPlugin() } : undefined),
  } as unknown as PluginCatalog;
  const notes: string[] = [];
  const notificationRouter = {
    dispatch: async (pluginId: string) => { notes.push(pluginId); return { delivered: [], failed: [] }; },
  } as unknown as NotificationRouter;
  const tool = createRequestSelfExtensionTool({ gate, pluginCatalog: catalog, selfExtendRegistry: registry, notificationRouter });
  return { gate, tool, notes };
}

describe('request_self_extension (auto-author tool)', () => {
  it('submits a pending proposal + notifies the operator', async () => {
    const { gate, tool, notes } = setup();
    const out = await tool.handler({ targetPluginId: AGENT, rationale: 'delta needed', templateId: 'odata.delta', params: { entitySet: 'salesorders' } });
    assert.match(out, /PENDING operator approval/);
    assert.equal(gate.list({ pluginId: AGENT, status: 'pending' }).length, 1);
    assert.deepEqual(notes, [AGENT]);
  });

  it('dedupes a second identical-template request', async () => {
    const { tool } = setup();
    await tool.handler({ targetPluginId: AGENT, rationale: 'r', templateId: 'odata.delta', params: {} });
    const out = await tool.handler({ targetPluginId: AGENT, rationale: 'r', templateId: 'odata.delta', params: {} });
    assert.match(out, /already pending/);
  });

  it('rejects an unknown plugin', async () => {
    const { tool } = setup();
    const out = await tool.handler({ targetPluginId: 'de.byte5.nope', rationale: 'r', templateId: 'odata.delta' });
    assert.match(out, /No installed plugin/);
  });

  it('rejects a plugin without self-extend templates', async () => {
    const { tool } = setup({ withTemplates: false });
    const out = await tool.handler({ targetPluginId: AGENT, rationale: 'r', templateId: 'odata.delta' });
    assert.match(out, /does not support self-extension/);
  });

  it('reports an auto-denied escalation without leaving a pending proposal', async () => {
    const greedy: ExtensionTemplate = { ...DELTA, requires: { graphWrites: ['odoo:invoices:*'] } };
    const { gate, tool } = setup({ template: greedy });
    const out = await tool.handler({ targetPluginId: AGENT, rationale: 'grab', templateId: 'odata.delta' });
    assert.match(out, /auto-denied/);
    assert.equal(gate.list({ pluginId: AGENT, status: 'pending' }).length, 0);
  });

  it('requires the mandatory fields', async () => {
    const { tool } = setup();
    const out = await tool.handler({ targetPluginId: AGENT });
    assert.match(out, /needs targetPluginId, rationale and templateId/);
  });
});
