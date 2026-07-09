/**
 * Epic #470 W0 — shim lifecycle (spec §5). Covers the protocol-mismatch abort
 * (names BOTH versions) and the clean/dirty end-to-end paths, wiring a fake
 * HomeApi, a fake git, and a fake CLI. No network, no real git.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runShim } from '../src/index.js';
import type { HomeApi, ScmToken, HeartbeatReply } from '../src/homeClient.js';
import type { DevJobSpec, RunnerResult, SeqRunnerEvent, ShimEnv } from '../src/protocol.js';

function makeSpec(over: Partial<DevJobSpec> = {}): DevJobSpec {
  return {
    protocol: 1,
    jobId: 'job-1',
    provision: 3,
    kind: 'implement',
    brief: 'do the thing',
    repo: { cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main', baseSha: 'deadbeef' },
    branch: 'omadia/job-1',
    agent: { kind: 'claude-cli' },
    limits: { wallClockMs: 60_000 },
    capabilities: { installDeps: false, runTests: false },
    ...over,
  };
}

class FakeHome implements HomeApi {
  public results: RunnerResult[] = [];
  public diffs: string[] = [];
  public events: SeqRunnerEvent[] = [];
  public constructor(private readonly spec: DevJobSpec) {}
  fetchSpec(): Promise<DevJobSpec> {
    return Promise.resolve(this.spec);
  }
  fetchScmToken(): Promise<ScmToken> {
    return Promise.resolve({ token: 'tok', expiresAt: '2099-01-01T00:00:00Z' });
  }
  postEvents(_p: number, events: SeqRunnerEvent[]): Promise<number> {
    this.events.push(...events);
    return Promise.resolve(events.length);
  }
  heartbeat(): Promise<HeartbeatReply> {
    return Promise.resolve({ ok: true, cancelRequested: false });
  }
  postDiff(bundle: string): Promise<string> {
    this.diffs.push(bundle);
    return Promise.resolve('artifact-1');
  }
  postResult(result: RunnerResult): Promise<void> {
    this.results.push(result);
    return Promise.resolve();
  }
}

let ws: string;
let env: ShimEnv;
let gitBin: string;
let cliBin: string;

async function writeFakeGit(dirty: boolean): Promise<void> {
  gitBin = path.join(ws, 'git.cjs');
  const diff = dirty ? 'diff --git a/x b/x\\n+1\\n' : '';
  const numstat = dirty ? '1\\t0\\tx\\n' : '';
  await writeFile(
    gitBin,
    `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const argv = process.argv.slice(2);
let sub=''; for (let i=0;i<argv.length;i++){const a=argv[i]; if(a==='-c'||a==='-C'){i++;continue;} if(a.startsWith('-'))continue; sub=a; break;}
if (sub==='clone'){ const dest=argv[argv.length-1]; fs.mkdirSync(path.join(dest,'.git'),{recursive:true}); }
if (sub==='status' && ${dirty ? 'true' : 'false'}) process.stdout.write(' M x\\n');
if (sub==='diff'){ process.stdout.write(argv.includes('--numstat') ? '${numstat}' : '${diff}'); }
process.exit(0);
`,
  );
  await chmod(gitBin, 0o755);
}

async function writeFakeCli(): Promise<void> {
  cliBin = path.join(ws, 'claude.cjs');
  await writeFile(
    cliBin,
    `#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type:'system', subtype:'init', model:'m' })+'\\n');
  process.stdout.write(JSON.stringify({ type:'result', usage:{ input_tokens:1, output_tokens:1 } })+'\\n');
  process.exit(0);
});
`,
  );
  await chmod(cliBin, 0o755);
}

beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), 'dev-runner-shim-life-'));
  await writeFakeCli();
  env = { baseUrl: 'http://unused', jobId: 'job-1', jobToken: 'djr_x', workspace: ws, cliBin };
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('runShim — protocol gate', () => {
  it('aborts with BOTH versions named on a protocol mismatch', async () => {
    const home = new FakeHome(makeSpec({ protocol: 999 }));
    const code = await runShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 1);
    assert.equal(home.results.length, 1);
    assert.equal(home.results[0]?.outcome, 'failed');
    const msg = home.results[0]?.error ?? '';
    assert.match(msg, /v1\b/, 'shim version named');
    assert.match(msg, /v999\b/, 'middleware version named');
    assert.equal(home.diffs.length, 0, 'no clone/diff attempted on a skew');
  });
});

describe('runShim — end to end', () => {
  it('reports no_changes on a clean work tree', async () => {
    await writeFakeGit(false);
    const home = new FakeHome(makeSpec());
    const code = await runShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 0);
    assert.equal(home.results.at(-1)?.outcome, 'no_changes');
    assert.equal(home.diffs.length, 0);
  });

  it('uploads a diff and reports diff_ready on a dirty tree', async () => {
    await writeFakeGit(true);
    const home = new FakeHome(makeSpec());
    const code = await runShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 0);
    assert.equal(home.diffs.length, 1, 'diff uploaded');
    assert.match(home.diffs[0] ?? '', /===OMADIA-DEV-RUNNER-NUMSTAT-V1===/, 'bundle carries the numstat marker');
    const last = home.results.at(-1);
    assert.equal(last?.outcome, 'diff_ready');
    assert.equal(last?.diffArtifactId, 'artifact-1');
    // Events were streamed with a monotonic seq seeded per provision.
    assert.ok(home.events.length > 0, 'agent events streamed home');
    assert.equal(home.events[0]?.seq, 0);
  });
});
