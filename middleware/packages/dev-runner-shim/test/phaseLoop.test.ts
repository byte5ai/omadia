/**
 * Epic #470 W2 — the gated phase loop (spec §4). Fakes a scripted HomeApi
 * (each phase-result returns the next directive), a RECORDING fake git (every
 * subcommand logged; a `push` fails the test), and a fake CLI that writes each
 * phase's JSON artifact to OMADIA_PHASE_ARTIFACT and records its per-phase HOME.
 * No network, no real git, no real Claude.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, chmod, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPhasedShim } from '../src/phaseLoop.js';
import type { HomeApi, ScmToken, HeartbeatReply } from '../src/homeClient.js';
import type {
  DevJobSpec,
  PhaseDirective,
  PhaseResultBody,
  RunnerResult,
  SeqRunnerEvent,
  ShimEnv,
} from '../src/protocol.js';

function makeSpec(over: Partial<DevJobSpec> = {}): DevJobSpec {
  return {
    protocol: 1,
    jobId: 'job-1',
    provision: 1,
    kind: 'fix_issue',
    brief: 'BEGIN UNTRUSTED\nfix the bug\nEND UNTRUSTED',
    repo: { cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main', baseSha: 'deadbeef' },
    branch: 'omadia/job-1',
    agent: { kind: 'claude-cli' },
    limits: { wallClockMs: 60_000 },
    capabilities: { installDeps: false, runTests: false },
    ...over,
  };
}

/** A HomeApi that returns scripted directives in order and records phase results. */
class ScriptedHome implements HomeApi {
  public phaseResults: PhaseResultBody[] = [];
  public events: SeqRunnerEvent[] = [];
  public scmTokenCalls = 0;
  private directives: PhaseDirective[];
  public constructor(
    private readonly spec: DevJobSpec,
    directives: PhaseDirective[],
  ) {
    this.directives = [...directives];
  }
  fetchSpec(): Promise<DevJobSpec> {
    return Promise.resolve(this.spec);
  }
  fetchScmToken(): Promise<ScmToken> {
    this.scmTokenCalls++;
    return Promise.resolve({ token: 'tok', expiresAt: '2099-01-01T00:00:00Z' });
  }
  postEvents(_p: number, events: SeqRunnerEvent[]): Promise<number> {
    this.events.push(...events);
    return Promise.resolve(events.length);
  }
  heartbeat(): Promise<HeartbeatReply> {
    return Promise.resolve({ ok: true, cancelRequested: false });
  }
  postDiff(): Promise<string> {
    return Promise.resolve('artifact-diff');
  }
  postResult(_r: RunnerResult): Promise<void> {
    return Promise.resolve();
  }
  postPhaseResult(body: PhaseResultBody): Promise<PhaseDirective> {
    this.phaseResults.push(body);
    const next = this.directives.shift();
    if (!next) throw new Error(`no scripted directive for phase '${body.phase}'`);
    return Promise.resolve(next);
  }
}

let ws: string;
let env: ShimEnv;
let gitBin: string;
let cliBin: string;

/** Recording fake git: logs every subcommand to $HOME/git-calls.log (HOME is the
 *  workspace, per runGit's hermetic env), emits a canned diff, never pushes. */
async function writeRecordingGit(): Promise<void> {
  gitBin = path.join(ws, 'git.cjs');
  await writeFile(
    gitBin,
    `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const argv = process.argv.slice(2);
let sub=''; for (let i=0;i<argv.length;i++){const a=argv[i]; if(a==='-c'||a==='-C'){i++;continue;} if(a.startsWith('-'))continue; sub=a; break;}
try { fs.appendFileSync(path.join(process.env.HOME, 'git-calls.log'), sub+'\\n'); } catch {}
if (sub==='clone'){ const dest=argv[argv.length-1]; fs.mkdirSync(path.join(dest,'.git'),{recursive:true}); }
if (sub==='rev-parse'){ process.stdout.write('cafef00dcafef00dcafef00dcafef00dcafef00d\\n'); }
if (sub==='diff'){ process.stdout.write(argv.includes('--numstat') ? '2\\t0\\tsrc/x.ts\\n' : 'diff --git a/src/x.ts b/src/x.ts\\n+aa\\n+bb\\n'); }
process.exit(0);
`,
  );
  await chmod(gitBin, 0o755);
}

/** Fake CLI: derives its phase from OMADIA_PHASE_ARTIFACT's basename, writes the
 *  matching JSON artifact, and records its HOME so the test can prove a fresh
 *  session per phase. Implement (no artifact env) just edits the tree. */
async function writeFakeCli(): Promise<void> {
  cliBin = path.join(ws, 'claude.cjs');
  await writeFile(
    cliBin,
    `#!${process.execPath}
const fs = require('fs'); const path = require('path');
process.stdin.resume(); process.stdin.on('end', () => {
  const artifact = process.env.OMADIA_PHASE_ARTIFACT;
  try { fs.writeFileSync(path.join(process.env.HOME, 'ran.json'), JSON.stringify({ home: process.env.HOME, artifact: artifact || null })); } catch {}
  if (artifact) {
    const m = /artifact-(.+?)-\\d+\\.json$/.exec(path.basename(artifact));
    const phase = m ? m[1] : '';
    let body = '{}';
    if (phase==='analyze') body = JSON.stringify({ affectedAreas:['src/x.ts'], reproduction:'run it', constraints:[], projectType:'node-npm', testCommand:'npm test' });
    else if (phase==='plan') body = JSON.stringify({ filesToTouch:['src/x.ts'], approach:'do it', testStrategy:'npm test' });
    else if (phase==='clarify') body = JSON.stringify([]);
    else if (phase==='review') body = JSON.stringify({ verdict:'approve', summary:'lgtm', findings:[] });
    try { fs.writeFileSync(artifact, body); } catch {}
  } else {
    // implement: touch a file so the (faked) diff is meaningful.
    try { fs.writeFileSync(path.join(process.cwd(), 'IMPLEMENTED.txt'), 'x'); } catch {}
  }
  process.stdout.write(JSON.stringify({ type:'system', subtype:'init', model:'m' })+'\\n');
  process.stdout.write(JSON.stringify({ type:'result', usage:{ input_tokens:1, output_tokens:1 } })+'\\n');
  process.exit(0);
});
`,
  );
  await chmod(cliBin, 0o755);
}

async function listSessionHomes(): Promise<string[]> {
  try {
    return (await readdir(path.join(ws, 'home'))).sort();
  } catch {
    return [];
  }
}

async function gitCalls(): Promise<string[]> {
  try {
    return (await readFile(path.join(ws, 'git-calls.log'), 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), 'dev-runner-shim-phase-'));
  await writeFakeCli();
  await writeRecordingGit();
  env = {
    baseUrl: 'http://unused',
    jobId: 'job-1',
    jobToken: 'djr_x',
    workspace: ws,
    cliBin,
    llmEnvAllowed: false,
    pipelineMode: 'gated',
  };
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('runPhasedShim — provision A (analyze → plan → clarify → park)', () => {
  it('runs the three phases as fresh sessions, posts each artifact, and exits 0 on park', async () => {
    const home = new ScriptedHome(makeSpec(), [
      { directive: 'next', phase: 'plan' },
      { directive: 'next', phase: 'clarify' },
      { directive: 'park' },
    ]);
    const code = await runPhasedShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 0, 'park exits 0');

    // Right phase order + artifacts.
    assert.deepEqual(home.phaseResults.map((r) => r.phase), ['analyze', 'plan', 'clarify']);
    assert.equal(home.phaseResults[0]?.artifact?.kind, 'analysis');
    assert.equal(home.phaseResults[1]?.artifact?.kind, 'plan');
    assert.equal(home.phaseResults[2]?.artifact?.kind, 'questions');
    assert.deepEqual(home.phaseResults[2]?.questions, [], 'clarify surfaced an (empty) questions array');
    assert.ok(home.phaseResults.every((r) => r.ok), 'every phase reported ok');

    // Fresh session per phase: three distinct HOME dirs, none shared.
    const homes = await listSessionHomes();
    assert.equal(homes.length, 3, 'one fresh HOME per phase');
    assert.equal(new Set(homes).size, 3, 'the phase HOMEs are all distinct');
    assert.deepEqual(homes, ['analyze-0', 'clarify-2', 'plan-1'].sort());

    // Nothing was ever pushed.
    const calls = await gitCalls();
    assert.ok(calls.includes('clone'), 'a clone happened');
    assert.ok(!calls.includes('push'), 'git push was never invoked');
  });
});

describe('runPhasedShim — a failed directive exits non-zero after posting', () => {
  it('posts the phase result, then exits 1 on {directive:failed}', async () => {
    const home = new ScriptedHome(makeSpec(), [{ directive: 'failed', reason: 'analysis rejected' }]);
    const code = await runPhasedShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 1, 'failed exits non-zero');
    assert.equal(home.phaseResults.length, 1, 'the phase result was posted before exiting');
    assert.equal(home.phaseResults[0]?.phase, 'analyze');
    const calls = await gitCalls();
    assert.ok(!calls.includes('push'), 'git push was never invoked');
  });
});

describe('runPhasedShim — provision B (implement → review → done)', () => {
  it('uploads the diff, posts the verdict, never pushes, and exits 0 on done', async () => {
    const spec = makeSpec({
      provision: 2,
      phaseContext: { phase: 'implement', plan: '{"approach":"do it"}', answers: [], attempt: 0 },
    });
    const home = new ScriptedHome(spec, [
      { directive: 'next', phase: 'review' },
      { directive: 'done' },
    ]);
    const code = await runPhasedShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 0, 'done exits 0');

    assert.deepEqual(home.phaseResults.map((r) => r.phase), ['implement', 'review']);
    const impl = home.phaseResults[0];
    assert.equal(impl?.artifact?.kind, 'diff', 'implement uploaded a diff artifact');
    assert.match(impl?.artifact?.content ?? '', /diff --git/, 'the diff content is present');
    assert.ok(impl?.headSha, 'implement reported a headSha');
    assert.ok(impl?.diffstat, 'implement reported a diffstat');

    const review = home.phaseResults[1];
    assert.equal(review?.artifact?.kind, 'review_verdict');
    assert.deepEqual(review?.verdict, { verdict: 'approve', summary: 'lgtm', findings: [] });

    const calls = await gitCalls();
    assert.ok(!calls.includes('push'), 'git push was never invoked');
    assert.ok(calls.includes('rev-parse'), 'headSha was read via rev-parse');
  });
});

describe('runPhasedShim — bootstrap runs as a command, not a CLI session', () => {
  it('executes the bootstrap command, posts a bootstrap_report, and starts no agent session', async () => {
    const marker = path.join(ws, 'bootstrap-ran');
    const spec = makeSpec({
      phaseContext: { phase: 'bootstrap' },
      bootstrap: { command: `touch ${marker}`, timeoutMs: 30_000 },
    });
    const home = new ScriptedHome(spec, [{ directive: 'done' }]);
    const code = await runPhasedShim(env, { home, gitBin, log: () => {} });
    assert.equal(code, 0);

    const boot = home.phaseResults[0];
    assert.equal(boot?.phase, 'bootstrap');
    assert.equal(boot?.ok, true);
    assert.equal(boot?.artifact?.kind, 'bootstrap_report');
    assert.match(boot?.artifact?.content ?? '', /"exitCode":0/, 'the report records exit 0');

    // The command actually ran, and NO claude session HOME was created for it.
    const ran = await readFile(marker, 'utf8').then(() => true).catch(() => false);
    assert.ok(ran, 'the bootstrap command executed on the job volume');
    const homes = await listSessionHomes();
    assert.deepEqual(homes, [], 'bootstrap starts no agent session');
  });
});
