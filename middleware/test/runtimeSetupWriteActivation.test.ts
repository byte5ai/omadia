import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MissingSecretError } from '@omadia/plugin-api';

import { describeActivationFailure } from '../src/plugins/activationFailure.js';
import { FileInstalledRegistry } from '../src/plugins/fileInstalledRegistry.js';
import {
  recordActivationFailure,
  recordActivationSuccess,
} from '../src/plugins/installedRegistry.js';
import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * #1497 — a setup-field write re-activates the plugin, and the response says
 * whether it came back up. The PATCH used to answer only the key names it
 * stored, so the store rendered "✓ Saved" over a plugin that had just failed
 * to start on the new values.
 *
 * `reactivate` is a stand-in for `installService.reactivate` with the same
 * contract: it never throws on an activation failure, it records it — here the
 * real `MissingSecretError` a plugin's `ctx.secrets.require()` throws.
 */

const ID = '@omadia/integration-odoo';
const KEY = 'odoo_api_key';

interface Harness {
  baseUrl: string;
  registry: FileInstalledRegistry;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n03-setup-write-'));
  const registry = new FileInstalledRegistry(path.join(dir, 'installed.json'));
  await registry.load();
  await registry.register({
    id: ID,
    installed_version: '0.2.1',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {},
  });
  const vault = new InMemorySecretVault();
  await vault.setMany(ID, { [KEY]: 'valid' });

  const reactivate = async (pluginId: string): Promise<void> => {
    const keys = await vault.listKeys(pluginId);
    if (!keys.includes(KEY)) {
      await recordActivationFailure(
        registry,
        pluginId,
        describeActivationFailure(new MissingSecretError(pluginId, KEY)),
      );
      return;
    }
    await recordActivationSuccess(registry, pluginId);
  };

  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      verifyConnection: async () => undefined,
      serviceRegistry: stubReg as never,
      turnHookRegistry: stubReg as never,
      backgroundJobRegistry: stubReg as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      vault,
      reactivate,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/runtime`,
    registry,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function patchSecrets(h: Harness, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.baseUrl}/installed/${encodeURIComponent(ID)}/secrets`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

describe('PATCH …/secrets reports the re-activation outcome (#1497)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('deleting a required secret answers errored + secret_missing, not just the keys', async () => {
    h = await makeHarness();
    const body = await patchSecrets(h, { delete: [KEY] });
    assert.deepEqual(body['keys'], []);
    const activation = body['activation'] as Record<string, unknown>;
    assert.equal(activation['state'], 'errored');
    assert.equal(activation['ok'], false);
    assert.equal(activation['error_code'], 'secret_missing');
    assert.match(String(activation['error']), new RegExp(KEY));
  });

  it('saving the missing secret back answers active and lifts the old error', async () => {
    h = await makeHarness();
    await patchSecrets(h, { delete: [KEY] });
    const body = await patchSecrets(h, { set: { [KEY]: 'valid-again' } });
    assert.deepEqual(body['activation'], {
      state: 'active',
      ok: true,
      error: null,
      error_code: null,
    });
  });

  it('GET /installed serves the same code the PATCH answered', async () => {
    h = await makeHarness();
    await patchSecrets(h, { delete: [KEY] });
    const res = await fetch(`${h.baseUrl}/installed`);
    const list = (await res.json()) as { items: Array<Record<string, unknown>> };
    const row = list.items.find((r) => r['id'] === ID);
    assert.equal(row?.['status'], 'errored');
    assert.equal(row?.['last_activation_error_code'], 'secret_missing');
  });

  it('the file registry persists the code across a reload', async () => {
    h = await makeHarness();
    await patchSecrets(h, { delete: [KEY] });
    const reread = new FileInstalledRegistry(
      // Same file the harness wrote through.
      (h.registry as unknown as { filePath: string }).filePath,
    );
    await reread.load();
    assert.equal(reread.get(ID)?.last_activation_error_code, 'secret_missing');
  });
});
