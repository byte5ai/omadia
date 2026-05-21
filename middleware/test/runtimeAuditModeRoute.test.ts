import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';

/**
 * #91 — PATCH /installed/:id/audit-mode. The operator mode switch for an
 * audit/scanner plugin. The endpoint validates the mode enum, gates on the
 * manifest's `permissions.network.web_scanner` flag, and merges `audit_mode`
 * into the InstalledRegistry config.
 */

const TEST_ID = 'de.byte5.agent.scanner';

interface Harness {
  server: Server;
  baseUrl: string;
  registry: InMemoryInstalledRegistry;
  close(): Promise<void>;
}

async function makeHarness(opts: {
  webScanner: boolean;
  initialConfig?: Record<string, unknown>;
}): Promise<Harness> {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: TEST_ID,
    installed_version: '0.1.0',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: opts.initialConfig ?? {},
  });

  const stubEntry: PluginCatalogEntry = {
    plugin: {
      id: TEST_ID,
      name: 'Scanner Agent',
      version: '0.1.0',
      permissions_summary: { network_web_scanner: opts.webScanner },
    } as never,
    manifest: {},
    source_path: '<test>',
    source_kind: 'manifest-v1',
  };
  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined =>
      id === TEST_ID ? stubEntry : undefined,
  } as unknown as PluginCatalog;

  const stubReg = { names: () => [], counts: () => ({}) };
  const router = createRuntimeRouter({
    installedRegistry: registry,
    serviceRegistry: stubReg as never,
    turnHookRegistry: stubReg as never,
    backgroundJobRegistry: stubReg as never,
    chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
    promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
    catalog,
  });

  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/admin/runtime', router);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    registry,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function patchMode(
  baseUrl: string,
  id: string,
  body: unknown,
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/v1/admin/runtime/installed/${encodeURIComponent(id)}/audit-mode`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

describe('runtime audit-mode route — PATCH /installed/:id/audit-mode', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('sets the mode for a web_scanner plugin and persists audit_mode', async () => {
    h = await makeHarness({ webScanner: true, initialConfig: { other: 'keep' } });
    const res = await patchMode(h.baseUrl, TEST_ID, { mode: 'public-web' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { audit_mode: string };
    assert.equal(body.audit_mode, 'public-web');
    const stored = h.registry.get(TEST_ID)?.config;
    assert.equal(stored?.['audit_mode'], 'public-web');
    // unrelated config keys survive the merge
    assert.equal(stored?.['other'], 'keep');
  });

  it('rejects an invalid mode with 400', async () => {
    h = await makeHarness({ webScanner: true });
    const res = await patchMode(h.baseUrl, TEST_ID, { mode: 'wide-open' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'runtime.invalid_audit_mode');
  });

  it('rejects a plugin that does not declare web_scanner with 400', async () => {
    h = await makeHarness({ webScanner: false });
    const res = await patchMode(h.baseUrl, TEST_ID, { mode: 'public-web' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'runtime.not_web_scanner');
  });

  it('returns 404 for an uninstalled plugin', async () => {
    h = await makeHarness({ webScanner: true });
    const res = await patchMode(h.baseUrl, 'de.byte5.agent.absent', {
      mode: 'allowlist',
    });
    assert.equal(res.status, 404);
  });
});
