/**
 * Epic #470 W0 — gitOps contract (spec §5 steps 2 & 6). The unit's `verifiedBy`
 * test. It proves the credential and no-push guarantees with a recording fake
 * git, plus a bundle grep that no source path can ever invoke `git push`.
 *
 * A fake `git` (a small node script) records every invocation's argv, env, and
 * cwd, and — for `clone` — stats the credential-store file so the test can
 * assert its mode and that the token reached git ONLY through that file. The
 * fake reads a control file from `$HOME` to simulate a dirty/clean work tree.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloneAtBaseSha, collectDiff, REPO_DIRNAME, type GitOptions } from '../src/gitOps.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, '..', 'src');

const TOKEN = 'ghs_super_secret_read_only_token_ABC123';
const CLONE_URL = 'https://github.com/byte5ai/omadia.git';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

interface GitLogRecord {
  sub: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  credFile?: string;
  credFileMode?: string;
  credFileContent?: string;
}

/** The fake git, as a standalone CommonJS node script (its own `process`). */
function fakeGitSource(): string {
  return `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const home = process.env.HOME || process.cwd();
const logPath = path.join(home, '.fake-git-log.jsonl');
const ctlPath = path.join(home, '.fake-git-control.json');
let ctl = { dirty: false, diff: '', numstat: '' };
try { ctl = JSON.parse(fs.readFileSync(ctlPath, 'utf8')); } catch {}

// Subcommand = first non-flag token, skipping '-c <v>' and '-C <dir>'.
let sub = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-c' || a === '-C') { i++; continue; }
  if (a.startsWith('-')) continue;
  sub = a; break;
}

const rec = { sub, argv, env: { ...process.env }, cwd: process.cwd() };

if (sub === 'clone') {
  const cArg = argv.find((a) => a.includes('--file='));
  if (cArg) {
    const credFile = cArg.slice(cArg.indexOf('--file=') + '--file='.length);
    rec.credFile = credFile;
    try {
      const st = fs.statSync(credFile);
      rec.credFileMode = (st.mode & 0o777).toString(8);
      rec.credFileContent = fs.readFileSync(credFile, 'utf8');
    } catch {}
  }
  const dest = argv[argv.length - 1];
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  // A benign .git/config — the code must never inject the token here.
  fs.writeFileSync(path.join(dest, '.git', 'config'), '[core]\\n\\trepositoryformatversion = 0\\n');
  fs.writeFileSync(path.join(dest, 'README.md'), '# fixture\\n');
}
if (sub === 'status') {
  if (ctl.dirty) process.stdout.write(' M README.md\\n');
}
if (sub === 'diff') {
  if (argv.includes('--numstat')) process.stdout.write(ctl.numstat);
  else process.stdout.write(ctl.diff);
}
if (sub === 'push') {
  // A real fake would move a ref; this branch exists only so the test can prove
  // it is NEVER reached.
  process.stderr.write('fake-git: push was invoked\\n');
}

fs.appendFileSync(logPath, JSON.stringify(rec) + '\\n');
process.exit(0);
`;
}

let ws: string;
let gitBin: string;

async function writeControl(ctl: { dirty: boolean; diff?: string; numstat?: string }): Promise<void> {
  await writeFile(
    path.join(ws, '.fake-git-control.json'),
    JSON.stringify({ dirty: ctl.dirty, diff: ctl.diff ?? '', numstat: ctl.numstat ?? '' }),
  );
}

function readLog(): GitLogRecord[] {
  const p = path.join(ws, '.fake-git-log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GitLogRecord);
}

function baseOpts(fetchToken: () => Promise<string> = async () => TOKEN): GitOptions {
  return { workspace: ws, gitBin, fetchToken, logger: () => {} };
}

/** Remove line and block comments so a grep sees executable code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), 'dev-runner-shim-git-'));
  gitBin = path.join(ws, 'fake-git.cjs');
  await writeFile(gitBin, fakeGitSource());
  await chmod(gitBin, 0o755);
  await writeControl({ dirty: false });
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('cloneAtBaseSha — credential handling', () => {
  it('clones at the pinned base sha with the documented shallow flags', async () => {
    const repoDir = await cloneAtBaseSha(baseOpts(), {
      cloneUrl: CLONE_URL,
      defaultBranch: 'main',
      baseSha: BASE_SHA,
    });
    assert.equal(repoDir, path.join(ws, REPO_DIRNAME));

    const clone = readLog().find((r) => r.sub === 'clone');
    assert.ok(clone, 'clone was invoked');
    assert.deepEqual(
      ['--depth', '50', '--branch', 'main'].filter((f) => clone.argv.includes(f)),
      ['--depth', '50', '--branch', 'main'],
    );
    assert.ok(clone.argv.includes(CLONE_URL), 'clone targets the clone URL');
    assert.ok(clone.argv.includes(repoDir), 'clone writes into repo/');

    const checkout = readLog().find((r) => r.sub === 'checkout');
    assert.ok(checkout, 'checkout was invoked');
    assert.ok(checkout.argv.includes('--detach'), 'checkout detaches');
    assert.ok(checkout.argv.includes(BASE_SHA), 'checkout targets the pinned base sha');
  });

  it('the credential file is 0600, carries the token, and is deleted afterwards', async () => {
    await cloneAtBaseSha(baseOpts(), { cloneUrl: CLONE_URL, defaultBranch: 'main', baseSha: BASE_SHA });
    const clone = readLog().find((r) => r.sub === 'clone');
    assert.ok(clone?.credFile, 'clone received a credential-store file path');
    // Positive control: the token DID reach git — through the file, and only there.
    assert.equal(clone.credFileMode, '600', 'credential file mode is exactly 0600');
    assert.match(clone.credFileContent ?? '', /x-access-token:/);
    assert.ok((clone.credFileContent ?? '').includes(TOKEN), 'credential file carried the token');
    // The file lives outside the work tree and is gone once the clone returns.
    assert.ok(!clone.credFile.startsWith(path.join(ws, REPO_DIRNAME)), 'cred file is outside repo/');
    assert.ok(!existsSync(clone.credFile), 'credential file was deleted');
  });

  it('the token appears in no argv and no env of any git invocation', async () => {
    await cloneAtBaseSha(baseOpts(), { cloneUrl: CLONE_URL, defaultBranch: 'main', baseSha: BASE_SHA });
    for (const rec of readLog()) {
      assert.ok(!JSON.stringify(rec.argv).includes(TOKEN), `token leaked into argv of '${rec.sub}'`);
      assert.ok(!JSON.stringify(rec.env).includes(TOKEN), `token leaked into env of '${rec.sub}'`);
    }
  });

  it('never writes the token into .git/config', async () => {
    const repoDir = await cloneAtBaseSha(baseOpts(), {
      cloneUrl: CLONE_URL,
      defaultBranch: 'main',
      baseSha: BASE_SHA,
    });
    const config = await readFile(path.join(repoDir, '.git', 'config'), 'utf8');
    assert.ok(!config.includes(TOKEN), 'token must never reach .git/config');
    assert.ok(!config.includes('x-access-token'), 'no credential material in .git/config');
  });

  it('deletes the credential file even when the clone fails', async () => {
    // A fake git that fails the clone. The finally-block must still unlink.
    const failing = path.join(ws, 'fail-git.cjs');
    await writeFile(failing, `#!${process.execPath}\nprocess.exit(1);\n`);
    await chmod(failing, 0o755);
    const opts: GitOptions = { ...baseOpts(), gitBin: failing };
    await assert.rejects(
      cloneAtBaseSha(opts, { cloneUrl: CLONE_URL, defaultBranch: 'main', baseSha: BASE_SHA }),
      /git clone failed/,
    );
    // No leftover .git-credentials-* file in the workspace.
    const leftovers = (await readdir(ws)).filter((f) => f.startsWith('.git-credentials-'));
    assert.deepEqual(leftovers, [], 'credential file must be unlinked on failure');
  });

  it('refuses to attach a credential to a non-https clone URL', async () => {
    await assert.rejects(
      cloneAtBaseSha(baseOpts(), { cloneUrl: 'git@github.com:byte5ai/omadia.git', defaultBranch: 'main', baseSha: '' }),
      /valid absolute URL|refusing to attach/,
    );
    await assert.rejects(
      cloneAtBaseSha(baseOpts(), { cloneUrl: 'http://github.com/o/r.git', defaultBranch: 'main', baseSha: '' }),
      /refusing to attach/,
    );
  });
});

describe('collectDiff — stage & diff, never push', () => {
  it('returns no changes on a clean work tree without staging', async () => {
    await writeControl({ dirty: false });
    const repoDir = path.join(ws, REPO_DIRNAME);
    await mkdir(repoDir, { recursive: true });
    const res = await collectDiff(baseOpts(), repoDir);
    assert.equal(res.hasChanges, false);
    assert.equal(res.diff, '');
    assert.equal(res.numstat, '');
    assert.equal(readLog().some((r) => r.sub === 'add'), false, 'no add on a clean tree');
  });

  it('stages and returns diff + numstat when dirty', async () => {
    await writeControl({
      dirty: true,
      diff: 'diff --git a/README.md b/README.md\n+hello\n',
      numstat: '1\t0\tREADME.md\n',
    });
    const repoDir = path.join(ws, REPO_DIRNAME);
    await mkdir(repoDir, { recursive: true });
    const res = await collectDiff(baseOpts(), repoDir);
    assert.equal(res.hasChanges, true);
    assert.match(res.diff, /diff --git a\/README\.md/);
    assert.equal(res.numstat, '1\t0\tREADME.md\n');
    const subs = readLog().map((r) => r.sub);
    assert.ok(subs.includes('add'), 'staged with add');
    assert.ok(subs.includes('diff'), 'produced a diff');
  });
});

describe('no push — the epic guarantee', () => {
  it('a full clone→diff cycle never invokes git push', async () => {
    await writeControl({ dirty: true, diff: 'diff --git a/x b/x\n', numstat: '0\t0\tx\n' });
    const repoDir = await cloneAtBaseSha(baseOpts(), {
      cloneUrl: CLONE_URL,
      defaultBranch: 'main',
      baseSha: BASE_SHA,
    });
    await collectDiff(baseOpts(), repoDir);
    assert.equal(readLog().some((r) => r.sub === 'push'), false, 'git push must never be invoked');
  });

  it('no source file in the shim bundle invokes git push', async () => {
    const files = (await readdir(SRC_DIR)).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length > 0, 'found source files to grep');
    for (const f of files) {
      const raw = await readFile(path.join(SRC_DIR, f), 'utf8');
      // Grep the EXECUTABLE code, not prose: a git subcommand is always passed
      // as a quoted string arg, and `Array.push(` uses no quotes. Strip comments
      // first so a doc-comment mentioning the guarantee cannot false-positive.
      const code = stripComments(raw);
      assert.equal(/['"]push['"]/.test(code), false, `${f} must not pass a quoted "push" git arg`);
    }
  });
});

describe('runGit — hermetic environment', () => {
  it('does not forward arbitrary parent env to git', async () => {
    process.env['SHIM_TEST_LEAK_CANARY'] = 'must-not-appear';
    try {
      await cloneAtBaseSha(baseOpts(), { cloneUrl: CLONE_URL, defaultBranch: 'main', baseSha: '' });
      const clone = readLog().find((r) => r.sub === 'clone');
      assert.ok(clone, 'clone ran');
      assert.equal(clone.env['SHIM_TEST_LEAK_CANARY'], undefined, 'parent env is not forwarded');
      assert.equal(clone.env['GIT_TERMINAL_PROMPT'], '0', 'prompts are disabled');
    } finally {
      delete process.env['SHIM_TEST_LEAK_CANARY'];
    }
  });
});
