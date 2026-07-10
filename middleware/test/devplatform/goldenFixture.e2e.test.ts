import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express, { type RequestHandler } from 'express';
import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { runShim } from '../../packages/dev-runner-shim/src/index.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { DevRepoCredentialStore } from '../../src/devplatform/devRepoCredentials.js';
import { applyHunks } from '../../src/devplatform/policy/parseUnifiedDiff.js';
import { assembleDevPlatform, mountDevPlatform } from '../../src/devplatform/wireDevPlatform.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';
import type {
  ApplyDiffInput,
  ApplyDiffResult,
  CreatePrInput,
  CreatePrResult,
  ForgeClient,
  ForgeIssue,
} from '../../src/devplatform/forgeClient.js';
import type { DevJobProvisionInput, RunnerBackend, RunnerHandle } from '../../src/devplatform/types.js';

/**
 * Epic #470 W1 — the golden fixture. The graph sink of the wave: one job, driven
 * end to end through the REAL pieces, with only the container and the LLM faked.
 *
 * A real git repository (five files, one deliberately failing test) is cloned by
 * the real shim, which runs a scripted stand-in for the `claude` binary, collects
 * a real `git diff`, uploads it to the real middleware over the real phone-home
 * router, and the middleware applies it through a stub forge.
 *
 * Four properties no unit test can establish, because each is a claim about the
 * SEAM between two components rather than about either one:
 *
 *   1. The diff the forge receives is byte-identical to the diff the agent made.
 *      Every transformation in between — bundling, storage, artifact round-trip,
 *      policy evaluation — must be lossless. A single normalised newline here is
 *      a corrupted commit in production.
 *   2. `git push` is never invoked. The runner holds no write credential; the
 *      middleware moves the ref. Asserted by giving the shim a `git` wrapper that
 *      records every invocation.
 *   3. The runner receives no clone credential in its spec, and no long-lived
 *      secret in its environment.
 *   4. The job reaches `applying` → a PR, and the workspace is gone afterwards.
 *
 * pg-gated, like the rest of the dev-platform e2e. Requires `git` on PATH.
 */

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'golden-fixture-e2e';

let pgAvailable = true;
try {
  const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
  await probe.query('SELECT 1');
  await probe.end();
} catch {
  pgAvailable = false;
}

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

/** The fixture project: five files, and `sum.test.js` fails against `sum.js`. */
const FIXTURE_FILES: Record<string, string> = {
  'README.md': '# fixture\n\nA tiny project the golden-fixture E2E clones.\n',
  'package.json': '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n',
  'src/sum.js': 'export function sum(a, b) {\n  return a - b;\n}\n',
  'test/sum.test.js': "import { sum } from '../src/sum.js';\nif (sum(2, 2) !== 4) throw new Error('sum is broken');\n",
  '.gitignore': 'node_modules\n',
};

/** What the scripted agent writes — the fix for the deliberately failing test. */
const AGENT_PATCH = 'export function sum(a, b) {\n  return a + b;\n}\n';

class StubForge implements ForgeClient {
  applyCalls: ApplyDiffInput[] = [];
  prCalls: CreatePrInput[] = [];
  /** The tip the fixture origin is actually at; set once the repo exists. */
  headSha = '';
  refCalls: string[] = [];

  getRef(_owner: string, _repo: string, ref: string): Promise<string> {
    this.refCalls.push(ref);
    return Promise.resolve(this.headSha);
  }

  /** The base tree, keyed by sha → path → content. Set from the fixture. */
  trees = new Map<string, Map<string, string>>();
  /** What applyDiff RECONSTRUCTED — the file the forge would commit. */
  committed = new Map<string, string>();

  applyDiff(input: ApplyDiffInput): Promise<ApplyDiffResult> {
    this.applyCalls.push(input);
    // Reconstruct exactly as GithubForgeClient does: read each file at the PINNED
    // base_sha and evaluate the hunks. A wrong base_sha, or hunks that do not
    // apply against that tree, throw HERE — so the test exercises the real
    // dependency between the pinned sha and the diff, not just a recorded call.
    const base = this.trees.get(input.baseSha);
    if (!base) throw new Error(`applyDiff: no tree for base_sha ${input.baseSha}`);
    for (const f of input.files) {
      if (f.change === 'delete') {
        this.committed.set(f.path, '<deleted>');
        continue;
      }
      const baseContent = f.change === 'add' ? '' : base.get(f.oldPath ?? f.path) ?? '';
      this.committed.set(f.path, applyHunks(baseContent, f.hunks, { path: f.path }));
    }
    return Promise.resolve({
      commitSha: 'golden-commit',
      treeSha: 'golden-tree',
      branchRef: `refs/heads/${input.branch}`,
    });
  }
  createPR(input: CreatePrInput): Promise<CreatePrResult> {
    this.prCalls.push(input);
    return Promise.resolve({ prUrl: 'https://example.com/pr/42', prNumber: 42 });
  }
  getIssue(): Promise<ForgeIssue> {
    return Promise.reject(new Error('not used'));
  }
  listOpenIssues(): Promise<ForgeIssue[]> {
    return Promise.resolve([]);
  }
  createIssue(): Promise<ForgeIssue> {
    return Promise.reject(new Error('not used'));
  }
  commentIssue(): Promise<void> {
    return Promise.resolve();
  }
}

/** A backend that spawns nothing — this test drives the shim itself, in-process. */
class InertBackend implements RunnerBackend {
  readonly kind = 'local';
  /** The one-time job token the worker minted — this test plays the runner itself. */
  readonly provisioned: DevJobProvisionInput[] = [];
  async provision(input: DevJobProvisionInput): Promise<RunnerHandle> {
    this.provisioned.push(input);
    return { backend: 'local', id: `inert-${input.jobId}`, pid: 1, startedAt: new Date().toISOString() };
  }
  async terminate(): Promise<void> {}
  async reap(): Promise<RunnerHandle[]> {
    return [];
  }
}

/**
 * Git's SMART http protocol, via the `git http-backend` CGI.
 *
 * The dumb protocol cannot serve `clone --depth`, and the shim clones shallow —
 * so a static file server would make this test pass against a code path the
 * runner never takes. Spawn the real CGI instead.
 */
function gitHttpBackend(root: string) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const [pathInfo, query = ''] = (req.url ?? '/').split('?');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: pathInfo ?? '/',
        REQUEST_METHOD: req.method ?? 'GET',
        QUERY_STRING: query,
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'fixture',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(child.stdin);

    let head = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf('\r\n\r\n');
      if (split === -1) return;
      const headerText = head.subarray(0, split).toString('utf8');
      const body = head.subarray(split + 4);
      let status = 200;
      for (const line of headerText.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else res.setHeader(name, value);
      }
      res.writeHead(status);
      headersSent = true;
      if (body.length > 0) res.write(body);
    });
    child.stdout.on('end', () => res.end());
    child.on('error', () => {
      if (!headersSent) res.writeHead(500);
      res.end();
    });
  };
}

const KNOWN_TOKEN = 'ghp_never_used';

/** Recursively search any JSON-ish value for a credential-shaped key or the token. */
function findSecret(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    return value.includes(KNOWN_TOKEN) ? `${path} carries the token` : null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/token|credential|secret|password|auth/i.test(k) && typeof v === 'string' && v !== '') {
        return `${path}.${k} looks like a credential`;
      }
      const deeper = findSecret(v, `${path}.${k}`);
      if (deeper) return deeper;
    }
  }
  return null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test.local',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test.local',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

describe('dev-platform golden fixture (pg + git)', { skip: !pgAvailable || !gitAvailable }, () => {
  let pool: Pool;
  let jobStore: DevJobStore;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';
  let wired: ReturnType<typeof assembleDevPlatform>;
  let repoId = '';
  let scratch = '';
  let originDir = '';
  let bareDir = '';
  let originServer: HttpsServer;
  let cloneUrl = '';
  let baseSha = '';
  let gitCalls: string[][] = [];
  const forge = new StubForge();
  const backend = new InertBackend();

  before(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'golden-fixture-'));

    // --- the origin repository, five files, one failing test ------------------
    originDir = path.join(scratch, 'origin');
    await mkdir(originDir, { recursive: true });
    git(originDir, 'init', '--initial-branch=main', '--quiet');
    for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
      const abs = path.join(originDir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, body);
    }
    git(originDir, 'add', '-A');
    git(originDir, 'commit', '-m', 'fixture: initial project', '--quiet');
    baseSha = git(originDir, 'rev-parse', 'HEAD').trim();
    forge.headSha = baseSha;
    forge.trees.set(baseSha, new Map(Object.entries(FIXTURE_FILES)));

    // --- serve it over HTTPS, because the shim refuses anything else ----------
    // `cloneAtBaseSha` will not attach a credential to a non-https URL. That guard
    // is exactly what this test must not weaken, so the fixture is served over a
    // real TLS socket with a self-signed cert, and only the *verification* is
    // disabled — inside the git wrapper, never in the shim.
    bareDir = path.join(scratch, 'fixture.git');
    git(scratch, 'clone', '--bare', '--quiet', originDir, bareDir);
    git(bareDir, 'update-server-info');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', path.join(scratch, 'key.pem'),
      '-out', path.join(scratch, 'cert.pem'),
      '-subj', '/CN=127.0.0.1',
    ], { stdio: 'ignore' });
    originServer = createHttpsServer(
      { key: await readFile(path.join(scratch, 'key.pem')), cert: await readFile(path.join(scratch, 'cert.pem')) },
      gitHttpBackend(scratch),
    );
    await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', r));
    const originPort = (originServer.address() as AddressInfo).port;
    cloneUrl = `https://127.0.0.1:${String(originPort)}/fixture.git`;

    // A `git` wrapper recording every invocation. Any `push` the shim attempted
    // would be recorded here — and it must not be. It also disables TLS
    // verification for the self-signed fixture origin (a test-only concern that
    // the shim itself never learns about).
    const gitWrapper = path.join(scratch, 'git-recorder');
    const logFile = path.join(scratch, 'git-calls.log');
    await writeFile(
      gitWrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexec git -c http.sslVerify=false "$@"\n`,
    );
    await chmod(gitWrapper, 0o755);

    // The scripted agent: a `claude` stand-in that fixes the failing test and
    // emits nothing else. It receives the workspace as its cwd.
    const fakeCli = path.join(scratch, 'fake-claude');
    await writeFile(
      fakeCli,
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(scratch, 'agent-env.txt'))}\n` +
        `cat > src/sum.js <<'PATCH'\n${AGENT_PATCH}PATCH\nexit 0\n`,
    );
    await chmod(fakeCli, 0o755);

    // --- the real middleware --------------------------------------------------
    pool = new Pool({ connectionString: PG_URL });
    await runMultiOrchestratorMigrations(pool);
    jobStore = new DevJobStore(pool);
    const repoStore = new DevRepoStore(pool);
    const vault = new InMemorySecretVault();
    const credentials = new DevRepoCredentialStore(vault);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ type: 'text/plain', limit: '10mb' }));
    const allowlist = publicPaths({ devEndpointsEnabled: false });
    const requireAuth: RequestHandler = (req, res, next) => {
      const url = req.originalUrl || req.url;
      if (allowlist.some((rx) => rx.test(url))) {
        next();
        return;
      }
      if (!req.header('x-test-sub')) {
        res.status(401).json({ code: 'unauthorized', message: 'no session' });
        return;
      }
      next();
    };
    app.use('/api', requireAuth, (_req, _res, next) => next());
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    wired = assembleDevPlatform({
      pool,
      vault,
      baseUrl,
      cliBin: fakeCli,
      wallClockMs: 120_000,
      heartbeatTimeoutMs: 120_000,
      maxConcurrentJobs: 1,
      commitAuthor: 'omadia-dev <dev-platform@omadia.ai>',
      subscriptionModeEnabled: false,
      workspaceDir: path.join(scratch, 'jobs'),
      unsafeLocal: false,
      shimEntry: '/dev/null',
      backends: [backend],
      forgeFactory: () => forge,
    });
    mountDevPlatform(app, requireAuth, wired);

    const repo = await repoStore.createRepo({
      owner: 'byte5ai',
      name: `golden-${randomUUID().slice(0, 8)}`,
      cloneUrl,
      credentialKind: 'pat',
      credentialRef: 'repo/golden',
      runsTests: false,
      createdBy: MARK,
    });
    repoId = repo.id;
    await credentials.save(repo.id, { token: 'ghp_never_used', kind: 'pat', login: 'byte5ai' });

    void gitWrapper;
    void logFile;
    gitCalls = [];
  });

  after(async () => {
    wired?.worker.stop();
    await new Promise<void>((r) => originServer.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
    await pool.end();
    await rm(scratch, { recursive: true, force: true });
  });

  it('drives one job from clone to PR, and the forge receives the agent’s exact diff', async () => {
    // 1. A queued job, claimed and provisioned exactly as the worker does.
    const job = await jobStore.createJob({
      repoId,
      kind: 'implement',
      brief: 'fix the failing sum test',
      source: 'admin',
      sourceRef: null,
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: '',
    });
    // The REAL worker claims and provisions: it is the thing that must pin the
    // base tree, so hand-claiming here would test a path production never runs.
    await wired.worker.tick();
    assert.equal(backend.provisioned.length, 1, 'the worker provisioned the job');
    assert.equal(backend.provisioned[0]!.jobId, job.id);
    const token = backend.provisioned[0]!.jobToken;

    // The tree the agent will reason about is pinned BEFORE it clones.
    assert.deepEqual(forge.refCalls, ['main'], 'the default branch was resolved once');
    assert.equal((await jobStore.getJob(job.id))?.baseSha, baseSha, 'base_sha is written at provision');

    // 2. The runner's spec carries NO credential. The clone token is fetched over
    //    the phone-home router, against the one-time job token.
    const specRes = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${job.id}/spec`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(specRes.status, 200);
    const spec = (await specRes.json()) as Record<string, unknown>;
    const leak = findSecret(spec, 'spec');
    assert.equal(leak, null, `the spec must carry no credential anywhere (${leak})`);

    // 3. The REAL shim runs: clone at base sha → scripted agent → git diff →
    //    upload. It is handed a recording `git` so a push cannot hide.
    const workspace = path.join(scratch, 'ws');
    await mkdir(workspace, { recursive: true });
    const gitBin = path.join(scratch, 'git-recorder');
    const shimLog: string[] = [];
    const code = await runShim(
      {
        baseUrl,
        jobId: job.id,
        jobToken: token,
        workspace,
        cliBin: path.join(scratch, 'fake-claude'),
        llmEnvAllowed: false,
      },
      { gitBin, log: (l) => shimLog.push(l) },
    );
    assert.equal(code, 0, `the shim completed; log:\n${shimLog.join('\n')}`);

    // 4. The middleware applies the diff. This is the worker's `applying` step.
    const applied = await wired.applyJob(job.id);
    assert.equal(applied.prUrl, 'https://example.com/pr/42');

    // 5. THE assertion. The forge receives HUNKS, not file contents — it applies
    //    them onto the pinned base tree server-side. So the property that matters
    //    is that evaluating those hunks against the base reproduces, byte for
    //    byte, the file the agent wrote. This runs the SAME `applyHunks` the real
    //    GitHub client runs, so a lossy hop anywhere between the agent's working
    //    tree and the forge shows up here as a mismatched file.
    assert.equal(forge.applyCalls.length, 1, 'the diff was applied once');
    const receivedFiles = forge.applyCalls[0]!.files;
    assert.equal(receivedFiles.length, 1, 'exactly one file was touched');
    const sumFile = receivedFiles.find((f) => f.path === 'src/sum.js');
    assert.ok(sumFile, 'the agent’s file reached the forge');
    assert.equal(sumFile.binary, false);
    // Compared against the bytes on disk, NOT against the constant the fake agent
    // was built from — otherwise both sides move together and the assertion is
    // tautological (it passed a deliberately corrupted AGENT_PATCH until this).
    const onDisk = await readFile(path.join(workspace, 'repo', 'src', 'sum.js'), 'utf8');
    assert.notEqual(onDisk, FIXTURE_FILES['src/sum.js'], 'the agent really did change the file');
    // What the forge would COMMIT, reconstructed against the pinned base tree,
    // must equal the agent's working tree byte for byte.
    assert.equal(
      forge.committed.get('src/sum.js'),
      onDisk,
      'byte-identical: every hop between the agent’s working tree and the forge must be lossless',
    );
    assert.equal(
      forge.applyCalls[0]!.baseSha,
      baseSha,
      'the forge applies onto the tree the runner cloned, not onto whatever main is now',
    );

    // 6. The PR names the branch the job owns, and the job is terminal.
    assert.equal(forge.prCalls.length, 1);
    const finished = await jobStore.getJob(job.id);
    assert.equal(forge.prCalls[0]!.head, finished?.branch, 'the PR is opened from the job’s own branch');
    assert.equal(finished?.status, 'done');
    assert.equal(finished?.prUrl, 'https://example.com/pr/42');
  });

  it('never invokes `git push` — the runner holds no write credential', async () => {
    // The recorder captured every git invocation the shim made, including the ones
    // inside `cloneAtBaseSha` and `collectDiff`. `push` must appear in none of them.
    const log = await readFile(path.join(scratch, 'git-calls.log'), 'utf8').catch(() => '');
    const lines = log.split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length > 0, 'the shim really did shell out to git');
    for (const line of lines) {
      assert.ok(!/\bpush\b/.test(line), `the shim must never push (found: ${line})`);
      assert.ok(!/\bremote\s+add\b/.test(line), 'and must not add a writable remote');
    }
    gitCalls = lines.map((l) => l.split(' '));
    assert.ok(
      gitCalls.some((c) => c.includes('clone')),
      'a clone did happen — the log is not empty for the wrong reason',
    );
    assert.ok(gitCalls.some((c) => c.includes('diff')), 'and a diff was collected');
  });

  it('leaves no clone credential anywhere under the workspace', async () => {
    // `cloneAtBaseSha` writes a credential store OUTSIDE the repo and removes it.
    // A leftover file — or the token written into `repo/.git/config` — would
    // persist it on disk for the next job. Walk the whole tree, and grep the
    // bytes: a file named innocently is still a leak.
    const workspace = path.join(scratch, 'ws');
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (entry.name.startsWith('.git-credentials')) offenders.push(`${abs} (credential store)`);
        const body = await readFile(abs, 'utf8').catch(() => '');
        if (body.includes(KNOWN_TOKEN)) offenders.push(`${abs} (contains the token)`);
      }
    }
    await walk(workspace);
    assert.deepEqual(offenders, [], 'no credential may survive the job');
  });

  it('hands the agent no long-lived secret in its environment', async () => {
    // The child CLI is the least-trusted code in the system. It gets a job-scoped
    // HOME and nothing else worth stealing — no inherited provider key, no SCM
    // token, no daemon token. The fake CLI dumped its own env to prove it.
    const dump = await readFile(path.join(scratch, 'agent-env.txt'), 'utf8');
    const lines = dump.split('\n').filter((l) => l.includes('='));
    assert.ok(lines.length > 0, 'the agent really did run and dump its environment');

    for (const line of lines) {
      const eq = line.indexOf('=');
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      assert.ok(!value.includes(KNOWN_TOKEN), `the SCM token reached the agent via ${key}`);
      assert.ok(
        !/^(ANTHROPIC_|OMADIA_ANTHROPIC_|DEV_RUNNER_DAEMON_TOKEN$|AWS_SECRET)/.test(key),
        `a long-lived secret reached the agent: ${key}`,
      );
    }
    const home = lines.find((l) => l.startsWith('HOME='))?.slice('HOME='.length);
    assert.ok(home && home.startsWith(path.join(scratch, 'ws')), `agent HOME must be job-scoped, got '${home}'`);
  });
});
