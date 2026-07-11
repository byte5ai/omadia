import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express, { type RequestHandler } from 'express';
import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { assembleDevPlatform, mountDevPlatform } from '../../src/devplatform/wireDevPlatform.js';
import { DevGithubAppStore } from '../../src/devplatform/githubApp/appStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import type { TokenFetch } from '../../src/devplatform/githubApp/installationTokens.js';
import type { DevJobProvisionInput, RunnerBackend, RunnerHandle } from '../../src/devplatform/types.js';

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

const MARK = 'scoped-scm-token';

/** A backend that spawns nothing — this test drives the phone-home router. */
class InertBackend implements RunnerBackend {
  readonly kind = 'local';
  async provision(input: DevJobProvisionInput): Promise<RunnerHandle> {
    return { backend: 'local', id: `inert-${input.jobId}`, pid: 1, startedAt: new Date().toISOString() };
  }
  async terminate(): Promise<void> {}
  async reap(): Promise<RunnerHandle[]> {
    return [];
  }
}

describe('dev-platform wiring — the runner gets a SCOPED, revocable App token (Forge credential-hardening)', {
  skip: !pgAvailable,
}, () => {
  let pool: Pool;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';
  let wired: ReturnType<typeof assembleDevPlatform>;
  let repoId = '';

  // The fake GitHub App API: records every call, answers the mint + revoke.
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const githubAppFetch: TokenFetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST' && url.includes('/access_tokens')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: 'ghs_scoped_readonly', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      };
    }
    if (init.method === 'DELETE' && url.includes('/installation/token')) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await runMultiOrchestratorMigrations(pool);
    const vault = new InMemorySecretVault();
    const appStore = new DevGithubAppStore(pool, vault);
    const repoStore = new DevRepoStore(pool);

    // A registered GitHub App + a repo bound to it.
    const app = await appStore.saveApp(
      {
        id: 777,
        slug: 'omadia-dev-byte5ai',
        ownerLogin: 'byte5ai',
        clientId: 'Iv1.x',
        clientSecret: 'shh',
        webhookSecret: 'wh',
        // A real RSA key so the JWT signs (never a literal PEM string in source).
        pem: (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey.export({ type: 'pkcs1', format: 'pem' })
          .toString(),
        htmlUrl: 'https://github.com/apps/omadia-dev-byte5ai',
      },
      'https://api.github.com',
      MARK,
    );
    const installation = await appStore.upsertInstallation(app.id, '4242', 'byte5ai');
    const repo = await repoStore.createRepo({
      owner: 'byte5ai',
      name: `scoped-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://github.com/byte5ai/omadia.git',
      credentialKind: 'github_app',
      credentialRef: `github_app:${app.id}:${installation.installationId}`,
      runsTests: false,
      createdBy: MARK,
    });
    repoId = repo.id;

    wired = assembleDevPlatform({
      pool,
      vault,
      baseUrl: 'http://127.0.0.1:3333',
      cliBin: 'claude',
      wallClockMs: 600_000,
      heartbeatTimeoutMs: 600_000,
      maxConcurrentJobs: 1,
      commitAuthor: 'omadia-dev <dev-platform@omadia.ai>',
      subscriptionModeEnabled: false,
      workspaceDir: '/tmp/scoped-scm',
      unsafeLocal: false,
      shimEntry: '/dev/null',
      backends: [new InertBackend()],
      githubAppFetch,
    });

    const app_ = express();
    app_.use(express.json());
    const requireAuth: RequestHandler = (_req, _res, next) => next();
    mountDevPlatform(app_, requireAuth, wired);
    server = app_.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    wired?.worker.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
    await pool.query('DELETE FROM dev_github_apps WHERE created_by = $1', [MARK]);
    await pool.end();
  });

  it('mints contents:read for one repo, then revokes it on finalize', async () => {
    // Provision a job on the github_app repo.
    const { hash } = mintRunnerToken();
    const job = await wired.jobStore.createJob({
      repoId,
      kind: 'implement',
      brief: 'scoped token test',
      source: 'admin',
      sourceRef: null,
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
    const lease = randomUUID();
    let claimed = await wired.jobStore.claimNextQueued(lease);
    while (claimed && claimed.id !== job.id) claimed = await wired.jobStore.claimNextQueued(lease);
    const { token } = await wired.jobStore.prepareProvision(claimed!, lease);

    // The runner fetches its clone credential.
    const res = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${job.id}/scm-token`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const scm = (await res.json()) as { token: string };
    assert.equal(scm.token, 'ghs_scoped_readonly', 'the runner gets the scoped token, not the raw repo credential');

    // The mint was scoped: one repo, contents:read ONLY.
    const mint = calls.find((c) => c.method === 'POST' && c.url.includes('/access_tokens'));
    assert.ok(mint, 'a scoped mint happened');
    assert.deepEqual((mint!.body as { permissions: unknown }).permissions, { contents: 'read' }, 'read-only');
    assert.equal((mint!.body as { repositories: string[] }).repositories.length, 1, 'a single repo');

    // Finalize the job → the token must be revoked.
    await wired.finalizeDevJob(job.id, 'done');
    const revoke = calls.find((c) => c.method === 'DELETE' && c.url.includes('/installation/token'));
    assert.ok(revoke, 'the scoped token was revoked on finalize — it does not outlive the job');

    // The audit log records a token mint + revoke (metadata only, never the value).
    const events = await wired.jobStore.listEvents(job.id);
    const tokenEvents = events.filter((e) => e.type === 'token');
    assert.ok(tokenEvents.some((e) => (e.payload as { action?: string }).action === 'mint'));
    assert.ok(tokenEvents.some((e) => (e.payload as { action?: string }).action === 'revoke'));
    assert.ok(!JSON.stringify(tokenEvents).includes('ghs_scoped_readonly'), 'no token value in the audit log');
  });
});
