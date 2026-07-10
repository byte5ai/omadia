import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  deriveJobPolicy,
  JobPolicyError,
  type DeriveJobPolicyConfig,
  type JobPolicyRepoInput,
} from '../../src/devplatform/deriveJobPolicy.js';
import { createDevRunnerRouter } from '../../src/routes/devRunnerApi.js';
import type { DevJobStatus, DevRepo } from '../../src/devplatform/types.js';
import { FakeStore, makeJob, auth, hasCredentialKey } from './devRunnerApi.harness.js';

/**
 * Epic #470 W1 — `deriveJobPolicy` (the single source of a job's effective
 * policy) and the DAEMON-authenticated internal job-policy endpoint. Proves:
 * env/image/allowlist are derived server-side from the dev_repos row; the
 * subscription branch; live-per-job reads; and — the S3 guarantee — that the
 * endpoint accepts the daemon token and REJECTS a per-job runner bearer. No DB.
 */

const CONFIG: DeriveJobPolicyConfig = {
  middlewareHost: 'middleware',
  baseAllowlist: ['registry.npmjs.org'],
  image: 'ghcr.io/byte5ai/omadia-dev-runner@sha256:deadbeef',
  llmProxyBaseUrl: 'http://middleware:8080/api/v1/dev-runner/llm',
};

const DAEMON_TOKEN = 'daemon-secret-token-0123456789abcdef-32+chars';

function repoInput(o: Partial<JobPolicyRepoInput> = {}): JobPolicyRepoInput {
  return { cloneUrl: 'https://github.com/o/r.git', egressAllowlist: [], ...o };
}

// ---------------------------------------------------------------------------
// Pure helper.
// ---------------------------------------------------------------------------

describe('deriveJobPolicy — pure derivation', () => {
  it('api_key job: LLM-proxy base url, no subscription flags, no Anthropic hosts', () => {
    const p = deriveJobPolicy(repoInput(), { authMode: 'api_key' }, CONFIG);
    assert.equal(p.image, CONFIG.image);
    assert.deepEqual(p.env, { ANTHROPIC_BASE_URL: CONFIG.llmProxyBaseUrl });
    // middleware host + github forge hosts + base allowlist; no repo entries.
    assert.deepEqual(p.egressAllowlist, [
      'middleware',
      'github.com',
      'codeload.github.com',
      'registry.npmjs.org',
    ]);
    assert.ok(!p.egressAllowlist.includes('api.anthropic.com'));
  });

  it('subscription job: direct Anthropic hosts + off-switch env, and NO base url', () => {
    const p = deriveJobPolicy(repoInput(), { authMode: 'subscription' }, CONFIG);
    assert.deepEqual(p.env, {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    });
    assert.ok(!('ANTHROPIC_BASE_URL' in p.env), 'subscription jobs get no LLM-proxy base url');
    for (const h of ['api.anthropic.com', 'claude.ai', 'platform.claude.com']) {
      assert.ok(p.egressAllowlist.includes(h), `allowlist includes ${h}`);
    }
  });

  it('folds in dev_repos.egress_allowlist and dedupes (middleware host listed once)', () => {
    const p = deriveJobPolicy(
      repoInput({ egressAllowlist: ['artifactory.internal', 'middleware', 'registry.npmjs.org'] }),
      { authMode: 'api_key' },
      CONFIG,
    );
    assert.ok(p.egressAllowlist.includes('artifactory.internal'));
    assert.equal(
      p.egressAllowlist.filter((h) => h === 'middleware').length,
      1,
      'middleware host appears exactly once despite the duplicate in the repo row',
    );
    assert.equal(p.egressAllowlist.filter((h) => h === 'registry.npmjs.org').length, 1);
  });

  it('a non-github forge yields just its own host (no codeload)', () => {
    const p = deriveJobPolicy(
      repoInput({ cloneUrl: 'https://gitlab.example.com/o/r.git' }),
      { authMode: 'api_key' },
      CONFIG,
    );
    assert.ok(p.egressAllowlist.includes('gitlab.example.com'));
    assert.ok(!p.egressAllowlist.includes('codeload.github.com'));
  });

  it('the derived env NEVER carries a secret', () => {
    for (const authMode of ['api_key', 'subscription'] as const) {
      const p = deriveJobPolicy(repoInput(), { authMode }, CONFIG);
      const keys = Object.keys(p.env).map((k) => k.toUpperCase());
      const joined = JSON.stringify(p.env).toUpperCase();
      for (const forbidden of ['API_KEY', 'X-API-KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'DAEMON_TOKEN', 'VAULT']) {
        assert.ok(!keys.includes(forbidden), `env has no ${forbidden} key`);
      }
      // No Vault path (`@omadia/...` / `core:...`) and no daemon token leaked.
      assert.ok(!joined.includes('VAULT'), 'env value mentions no vault');
      assert.ok(!joined.includes(DAEMON_TOKEN.toUpperCase()), 'env value never contains the daemon token');
    }
  });

  it('throws JobPolicyError on an unparseable clone_url', () => {
    assert.throws(
      () => deriveJobPolicy(repoInput({ cloneUrl: 'not a url' }), { authMode: 'api_key' }, CONFIG),
      JobPolicyError,
    );
  });

  it('SSRF: refuses a clone_url that would allowlist an internal/metadata host', () => {
    for (const cloneUrl of [
      'https://github.com@169.254.169.254/x', // userinfo confusion → metadata IP
      'https://169.254.169.254/o/r.git', // cloud-metadata literal
      'https://10.0.0.5/o/r.git', // RFC1918 literal
      'https://foo.internal/o/r.git', // internal name
      'http://github.com/o/r.git', // non-https
    ]) {
      assert.throws(
        () => deriveJobPolicy(repoInput({ cloneUrl }), { authMode: 'api_key' }, CONFIG),
        JobPolicyError,
        `clone_url ${cloneUrl} must be refused`,
      );
    }
  });

  it('egress: drops malformed / IP-literal entries, keeps operator-chosen names', () => {
    const p = deriveJobPolicy(
      repoInput({
        egressAllowlist: [
          '*',
          'http://evil.example',
          'host:443',
          '10.0.0.0/8',
          '169.254.169.254',
          'bad host',
          'artifactory.internal', // operator-chosen internal NAME is kept
          'good.example.com',
        ],
      }),
      { authMode: 'api_key' },
      CONFIG,
    );
    for (const rejected of ['*', 'http://evil.example', 'host:443', '10.0.0.0/8', '169.254.169.254', 'bad host']) {
      assert.ok(!p.egressAllowlist.includes(rejected), `${rejected} must be dropped`);
    }
    // No entry retains a scheme, port, path, or wildcard character.
    assert.ok(!p.egressAllowlist.some((h) => /[/:*@?# ]/.test(h)), 'every surviving entry is a bare hostname');
    assert.ok(p.egressAllowlist.includes('artifactory.internal'), 'operator internal name kept');
    assert.ok(p.egressAllowlist.includes('good.example.com'));
  });
});

// ---------------------------------------------------------------------------
// Internal endpoint — GET /internal/job-policy/:jobId (daemon-token auth).
// ---------------------------------------------------------------------------

interface PolicyApp {
  server: Server;
  baseUrl: string;
  store: FakeStore;
  repo: { value: Pick<DevRepo, 'cloneUrl' | 'defaultBranch' | 'runsTests' | 'egressAllowlist'> | null };
  close(): Promise<void>;
}

async function makePolicyApp(
  opts: { daemonToken?: string; jobPolicyConfig?: DeriveJobPolicyConfig } = {
    daemonToken: DAEMON_TOKEN,
    jobPolicyConfig: CONFIG,
  },
): Promise<PolicyApp> {
  const store = new FakeStore();
  const repo: PolicyApp['repo'] = {
    value: { cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main', runsTests: false, egressAllowlist: [] },
  };
  const router = createDevRunnerRouter({
    store,
    repos: { getRepo: async () => repo.value },
    scmTokens: { resolve: async () => undefined },
    finalizeDevJob: async (_jobId: string, _status: DevJobStatus) => null,
    ...(opts.daemonToken !== undefined ? { daemonToken: opts.daemonToken } : {}),
    ...(opts.jobPolicyConfig !== undefined ? { jobPolicyConfig: opts.jobPolicyConfig } : {}),
  });
  const app = express();
  app.use('/api/v1/dev-runner', router);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/dev-runner`,
    store,
    repo,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function daemonAuth(token = DAEMON_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('devRunnerApi — internal job-policy endpoint', () => {
  let app: PolicyApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('daemon token → 200 with server-derived image, env, and egress allowlist', async () => {
    app = await makePolicyApp();
    app.store.add(makeJob({ id: 'job-1', repoId: 'repo-1', authMode: 'api_key' }));
    app.repo.value = {
      cloneUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      runsTests: false,
      egressAllowlist: ['artifactory.internal'],
    };
    const res = await fetch(`${app.baseUrl}/internal/job-policy/job-1`, { headers: daemonAuth() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      jobId: string;
      image: string;
      env: Record<string, string>;
      egressAllowlist: string[];
    };
    assert.equal(body.jobId, 'job-1');
    assert.equal(body.image, CONFIG.image);
    assert.deepEqual(body.env, { ANTHROPIC_BASE_URL: CONFIG.llmProxyBaseUrl });
    assert.ok(body.egressAllowlist.includes('artifactory.internal'), 'repo allowlist entry is present');
    assert.ok(body.egressAllowlist.includes('middleware'));
    assert.equal(hasCredentialKey(body.env), false, 'policy env carries no credential-like key');
  });

  it('REJECTS a per-job djr_ runner bearer (S3: no runner may read a policy)', async () => {
    app = await makePolicyApp();
    // The job's own valid runner token — accepted on /jobs/:id/*, forbidden here.
    app.store.add(makeJob({ id: 'job-1' }), 'djr_valid-token');
    const res = await fetch(`${app.baseUrl}/internal/job-policy/job-1`, {
      headers: auth('djr_valid-token'),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.unauthorized');
  });

  it('401 with no bearer, 401 with a wrong daemon token', async () => {
    app = await makePolicyApp();
    app.store.add(makeJob({ id: 'job-1' }));
    const noBearer = await fetch(`${app.baseUrl}/internal/job-policy/job-1`);
    assert.equal(noBearer.status, 401);
    const wrong = await fetch(`${app.baseUrl}/internal/job-policy/job-1`, {
      headers: daemonAuth('daemon-secret-token-WRONG-0000000000000000000'),
    });
    assert.equal(wrong.status, 401);
  });

  it('404 for an unknown job (the daemon is already authenticated)', async () => {
    app = await makePolicyApp();
    const res = await fetch(`${app.baseUrl}/internal/job-policy/nope`, { headers: daemonAuth() });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.job_not_found');
  });

  it('503 when the daemon token / policy config is not wired', async () => {
    app = await makePolicyApp({});
    app.store.add(makeJob({ id: 'job-1' }));
    const res = await fetch(`${app.baseUrl}/internal/job-policy/job-1`, { headers: daemonAuth() });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.daemon_not_configured');
  });

  it('reads the repo row LIVE — an added host takes effect on the next job, no restart', async () => {
    app = await makePolicyApp();
    app.store.add(makeJob({ id: 'job-1' }));
    app.repo.value = {
      cloneUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      runsTests: false,
      egressAllowlist: [],
    };
    const before = (await (
      await fetch(`${app.baseUrl}/internal/job-policy/job-1`, { headers: daemonAuth() })
    ).json()) as { egressAllowlist: string[] };
    assert.ok(!before.egressAllowlist.includes('new-host.internal'));

    // Operator adds a host to the dev_repos row — no router rebuild, no restart.
    app.repo.value = { ...app.repo.value, egressAllowlist: ['new-host.internal'] };
    const after = (await (
      await fetch(`${app.baseUrl}/internal/job-policy/job-1`, { headers: daemonAuth() })
    ).json()) as { egressAllowlist: string[] };
    assert.ok(after.egressAllowlist.includes('new-host.internal'), 'the newly added host appears on the next job');
  });
});
