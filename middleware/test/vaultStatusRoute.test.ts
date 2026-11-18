import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import type { MasterKeySource } from '../src/health/platformHealth.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { createVaultStatusRouter } from '../src/routes/vaultStatus.js';
import type { VaultStatusResponse } from '../src/routes/vaultStatus.js';
import type { SecretVault } from '../src/secrets/vault.js';

/**
 * #1387 — `/api/v1/admin/vault-status` reported the vault master key only.
 * With VAULT_KEY set and CREDENTIAL_KEYCHAIN_KEY unset, the card turned green
 * ("production") while the keychain key still came from the dev file.
 */

const fakeVault = { listKeys: async () => [] } as unknown as SecretVault;

let dataDir: string;

async function fetchStatus(
  vaultKey: MasterKeySource,
  keychainKey: MasterKeySource,
): Promise<VaultStatusResponse> {
  const app = express();
  app.use(
    '/vault-status',
    createVaultStatusRouter({
      vault: fakeVault,
      registry: new InMemoryInstalledRegistry(),
      vaultPath: join(dataDir, 'vault.enc'),
      dataDir,
      masterKeySource: vaultKey,
      keychainKeySource: keychainKey,
      backup: null,
    }),
  );
  const server: Server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => { done(s); });
  });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}/vault-status`);
    assert.equal(res.status, 200);
    return (await res.json()) as VaultStatusResponse;
  } finally {
    await new Promise((done) => { server.close(done); });
  }
}

describe('vault-status — keychain master key (#1387)', () => {
  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vault-status-'));
  });
  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('VAULT_KEY set, CREDENTIAL_KEYCHAIN_KEY unset → not production ready', async () => {
    const body = await fetchStatus('env', 'dev-file-existed');
    assert.equal(body.vault.master_key_source, 'env');
    assert.equal(body.vault.keychain_key_source, 'dev-file-existed');
    assert.equal(body.vault.production_ready, false);
  });

  it('CREDENTIAL_KEYCHAIN_KEY set, VAULT_KEY unset → not production ready', async () => {
    const body = await fetchStatus('dev-file-created', 'env');
    assert.equal(body.vault.keychain_key_source, 'env');
    assert.equal(body.vault.production_ready, false);
  });

  it('both keys from env → production ready', async () => {
    const body = await fetchStatus('env', 'env');
    assert.equal(body.vault.production_ready, true);
  });
});
