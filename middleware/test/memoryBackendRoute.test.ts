import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import type { Config } from '../src/config.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { createMemoryBackendRouter } from '../src/routes/memoryBackend.js';

/**
 * #1834 — `GET /api/v1/admin/memory/backend` reported the saved choice as
 * `current`, so "Active backend" and the /memory badge named a backend that
 * was not running. `current` is now the running backend and `desired` the
 * saved choice the next boot applies.
 */

interface BackendState {
  current: string;
  desired: string;
  activeProviderId: string | null;
  restartRequiredToApply: boolean;
}

async function getState(
  registry: InMemoryInstalledRegistry,
  config: Partial<Config>,
): Promise<BackendState> {
  const app = express();
  app.use(
    '/backend',
    createMemoryBackendRouter({ registry, config: config as Config }),
  );
  const server: Server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => { done(s); });
  });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}/backend`);
    assert.equal(res.status, 200);
    return (await res.json()) as BackendState;
  } finally {
    await new Promise((done) => { server.close(done); });
  }
}

async function seed(
  registry: InMemoryInstalledRegistry,
  id: string,
  config: Record<string, unknown>,
): Promise<void> {
  await registry.register({
    id,
    installed_version: '0.1.0',
    installed_at: '2026-11-26T00:00:00Z',
    status: 'active',
    config,
  });
}

describe('memory backend route — running vs saved backend (#1834)', () => {
  it('a saved but not applied switch keeps `current` on the running backend', async () => {
    const reg = new InMemoryInstalledRegistry();
    await seed(reg, '@omadia/memory-postgres', { memory_backend: 'inmemory' });
    const s = await getState(reg, { DATABASE_URL: 'postgres://x' });
    assert.equal(s.current, 'postgres', 'Postgres is still running');
    assert.equal(s.desired, 'inmemory');
    assert.equal(s.restartRequiredToApply, true);
  });

  it('after the restart applied the switch, nothing is pending', async () => {
    const reg = new InMemoryInstalledRegistry();
    // The boot carried the choice over onto the provider it installed.
    await seed(reg, '@omadia/memory', { memory_backend: 'inmemory' });
    const s = await getState(reg, { DATABASE_URL: 'postgres://x' });
    assert.equal(s.current, 'inmemory');
    assert.equal(s.desired, 'inmemory');
    assert.equal(s.activeProviderId, '@omadia/memory');
    assert.equal(s.restartRequiredToApply, false);
  });

  it('without a saved choice, the environment decides `desired`', async () => {
    const reg = new InMemoryInstalledRegistry();
    await seed(reg, '@omadia/memory', {});
    const s = await getState(reg, { DATABASE_URL: 'postgres://x' });
    assert.equal(s.current, 'inmemory');
    assert.equal(s.desired, 'postgres', 'derived default with DATABASE_URL');
    assert.equal(s.restartRequiredToApply, true);
  });
});
