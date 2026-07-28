import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { InMemorySecretVault } from '../../src/secrets/vault.js';
import {
  DEV_PLATFORM_AGENT_ID,
  DevRepoCredentialStore,
} from '../../src/devplatform/devRepoCredentials.js';

const REPO = 'r-123';
const SUB = 'op-abc';
const TOKEN = 'gho_secretDeviceFlowToken';
const PAT = 'ghp_secretPersonalAccessToken';

describe('DevRepoCredentialStore', () => {
  let vault: InMemorySecretVault;
  let store: DevRepoCredentialStore;

  beforeEach(() => {
    vault = new InMemorySecretVault();
    store = new DevRepoCredentialStore(vault);
  });

  it('lands a device-flow token in the core:dev-platform namespace', async () => {
    await store.save(REPO, { token: TOKEN, kind: 'device_flow', login: 'octo' });

    // Stored under the fixed namespace, prefixed keys.
    const keys = await vault.listKeys(DEV_PLATFORM_AGENT_ID);
    assert.deepEqual(keys, [
      `repo/${REPO}/login`,
      `repo/${REPO}/token`,
      `repo/${REPO}/token_kind`,
    ]);
    assert.equal(await store.resolve(REPO), TOKEN);
    assert.equal(await store.getKind(REPO), 'device_flow');
  });

  it('stores a PAT under the same keys with kind=pat', async () => {
    await store.save(REPO, { token: PAT, kind: 'pat', login: 'octo' });
    assert.equal(await store.resolve(REPO), PAT);
    assert.equal(await store.getKind(REPO), 'pat');
  });

  it('never puts the token in the browser-facing connection view', async () => {
    await store.save(REPO, { token: TOKEN, kind: 'device_flow', login: 'octo' });
    const conn = await store.getConnection(REPO);
    assert.deepEqual(conn, { connected: true, login: 'octo', kind: 'device_flow' });
    // The serialised connection must not carry the secret.
    assert.ok(!JSON.stringify(conn).includes(TOKEN));
  });

  it('reports a disconnected repo before any save', async () => {
    assert.deepEqual(await store.getConnection('unknown'), { connected: false });
    assert.equal(await store.resolve('unknown'), undefined);
  });

  it('clear() purges all three per-repo keys', async () => {
    await store.save(REPO, { token: TOKEN, kind: 'device_flow', login: 'octo' });
    await store.clear(REPO);

    assert.deepEqual(await vault.listKeys(DEV_PLATFORM_AGENT_ID), []);
    assert.equal(await store.resolve(REPO), undefined);
    assert.equal(await store.getKind(REPO), undefined);
    assert.deepEqual(await store.getConnection(REPO), { connected: false });
  });

  it('parks a pending token then promotes it onto the repo row', async () => {
    await store.stashPending(SUB, TOKEN);
    assert.equal(await store.resolvePending(SUB), TOKEN);

    const moved = await store.promotePending(SUB, REPO, 'octo');
    assert.equal(moved, true);

    // Token now lives on the repo row, staging key is gone.
    assert.equal(await store.resolve(REPO), TOKEN);
    assert.equal(await store.getKind(REPO), 'device_flow');
    assert.equal(await store.resolvePending(SUB), undefined);
    assert.deepEqual(await store.getConnection(REPO), {
      connected: true,
      login: 'octo',
      kind: 'device_flow',
    });
  });

  it('promotePending returns false when nothing was parked', async () => {
    assert.equal(await store.promotePending(SUB, REPO), false);
    assert.deepEqual(await store.getConnection(REPO), { connected: false });
  });
});
