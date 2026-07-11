import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevGithubAppStore } from '../../src/devplatform/githubApp/appStore.js';
import { DEV_PLATFORM_AGENT_ID } from '../../src/devplatform/devRepoCredentials.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';
import type { AppConversion } from '../../src/devplatform/githubApp/manifestFlow.js';

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

let pgAvailable = true;
try {
  const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
  await probe.query('SELECT 1');
  await probe.end();
} catch {
  pgAvailable = false;
}

const MARK = 'appstore-test';

function conversion(id: number, over: Partial<AppConversion> = {}): AppConversion {
  return {
    id,
    slug: `omadia-dev-${id}`,
    ownerLogin: 'byte5ai',
    clientId: 'Iv1.abc',
    clientSecret: 'client-secret',
    webhookSecret: 'webhook-secret',
    pem: 'FAKE-PEM-FIXTURE-not-a-key',
    htmlUrl: `https://github.com/apps/omadia-dev-${id}`,
    ...over,
  };
}

describe('devplatform/DevGithubAppStore (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let vault: InMemorySecretVault;
  let store: DevGithubAppStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await runMultiOrchestratorMigrations(pool);
    vault = new InMemorySecretVault();
    store = new DevGithubAppStore(pool, vault);
  });

  after(async () => {
    await pool.query('DELETE FROM dev_github_apps WHERE created_by = $1', [MARK]);
    await pool.end();
  });

  it('splits metadata to Postgres and secrets to Vault under core:dev-platform', async () => {
    const app = await store.saveApp(conversion(1001), 'https://api.github.com', MARK);
    assert.equal(app.appId, '1001');
    assert.equal(app.ownerLogin, 'byte5ai');

    // The row carries no secret columns — the table has none, but assert the
    // read path never surfaces them either.
    const row = await pool.query(
      'SELECT * FROM dev_github_apps WHERE app_id = $1',
      ['1001'],
    );
    const columns = Object.keys(row.rows[0]!);
    for (const c of columns) {
      assert.ok(!/pem|secret|private|key/i.test(c), `secret-shaped column leaked: ${c}`);
    }

    // Secrets live in Vault under github-app/<id>/.
    assert.equal(await vault.get(DEV_PLATFORM_AGENT_ID, 'github-app/1001/private_key'), conversion(1001).pem);
    assert.equal(await vault.get(DEV_PLATFORM_AGENT_ID, 'github-app/1001/webhook_secret'), 'webhook-secret');
    assert.equal(await vault.get(DEV_PLATFORM_AGENT_ID, 'github-app/1001/client_secret'), 'client-secret');
  });

  it('listApps returns no secret material, with installation counts', async () => {
    const app = await store.saveApp(conversion(1002), 'https://api.github.com', MARK);
    await store.upsertInstallation(app.id, '55', 'byte5ai');
    await store.upsertInstallation(app.id, '56', 'byte5ai-2');
    const apps = await store.listApps();
    const mine = apps.find((a) => a.appId === '1002');
    assert.equal(mine?.installations, 2);
    const serialized = JSON.stringify(apps);
    assert.ok(!serialized.includes('FAKE-PEM-FIXTURE') && !serialized.includes('client-secret'), 'no secret in the list');
  });

  it('getSecrets reads the mint material back from Vault', async () => {
    await store.saveApp(conversion(1003), 'https://api.github.com', MARK);
    const secrets = await store.getSecrets('1003');
    assert.ok(secrets?.privateKey.includes('FAKE-PEM-FIXTURE'));
    assert.equal(secrets?.clientSecret, 'client-secret');
  });

  it('returns null secrets for an unknown App rather than an empty object', async () => {
    assert.equal(await store.getSecrets('does-not-exist'), null);
  });

  it('upsertInstallation is idempotent on (app, installation)', async () => {
    const app = await store.saveApp(conversion(1004), 'https://api.github.com', MARK);
    const a = await store.upsertInstallation(app.id, '77', 'byte5ai');
    const b = await store.upsertInstallation(app.id, '77', 'byte5ai-renamed');
    assert.equal(a.id, b.id, 'the same installation row is reused');
    assert.equal(b.accountLogin, 'byte5ai-renamed', 'and the account login is updated');
    const found = await store.findInstallation('77');
    assert.equal(found?.appRowId, app.id);
  });

  it('rolls back the row when the Vault write fails — no half-registered App', async () => {
    const failing = new InMemorySecretVault();
    failing.setMany = async () => {
      throw new Error('vault down');
    };
    const brittle = new DevGithubAppStore(pool, failing);
    await assert.rejects(() => brittle.saveApp(conversion(1005), 'https://api.github.com', MARK), /vault down/);
    assert.equal(await store.getAppByGithubId('1005'), null, 'the metadata row must not survive a secrets failure');
  });
});

describe('devplatform/DevGithubAppStore — COMMIT failure after the Vault write cleans up (Forge #5)', () => {
  it('deletes the written Vault secrets when COMMIT throws', async () => {
    const deleted: string[] = [];
    const vault = {
      setMany: async () => {},
      deleteKey: async (_agentId: string, key: string) => void deleted.push(key),
      set: async () => {},
      get: async () => undefined,
      listKeys: async () => [],
      purge: async () => {},
    };
    // A fake pool whose client COMMITs with a failure AFTER setMany succeeded.
    const client = {
      query: async (sql: string) => {
        if (typeof sql === 'string' && sql.startsWith('COMMIT')) throw new Error('commit failed');
        if (typeof sql === 'string' && sql.startsWith('INSERT')) {
          return { rows: [{ id: 'row-1', app_id: '9', slug: 's', owner_login: 'o', html_url: 'u', api_base_url: 'a', created_by: 'c' }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const store = new DevGithubAppStore(pool, vault as unknown as InMemorySecretVault);
    await assert.rejects(() => store.saveApp(conversion(9), 'https://api.github.com', 'me'), /commit failed/);
    assert.equal(deleted.length, 4, 'all four secret keys were removed');
    assert.ok(deleted.every((k) => k.startsWith('github-app/9/')), 'the right namespace');
  });
});
