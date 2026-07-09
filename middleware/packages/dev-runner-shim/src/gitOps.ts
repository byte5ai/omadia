/**
 * Epic #470 W0 — git operations for the runner shim (spec §5 steps 2 & 6).
 *
 * Two guarantees this module exists to hold, both regression-tested in
 * `test/gitOps.test.ts`:
 *
 *   1. The clone credential (a read-only, ≤15-min token) reaches git ONLY
 *      through a `git-credential-store` file created 0600 outside the work
 *      tree and deleted in a `finally`. It is never placed in the process
 *      environment, never on any git argv, and never written to `.git/config`
 *      (all config for the clone is passed with ephemeral `-c`, which git does
 *      not persist).
 *   2. There is NO push. The shim holds no write credential and moves no ref;
 *      it produces a diff and uploads it. `git push` appears in no code path
 *      here — asserted by a fake-git harness and by a bundle grep.
 *
 * Node builtins only. The git binary is injectable so a test can substitute a
 * recording fake.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Absolute path to the git binary. Overridable for the fake-git harness. */
  gitBin?: string;
  /** Directory the clone is created under (`spec` workspace). */
  workspace: string;
  /** Fetches the one-shot read-only clone token (calls GET /scm-token). */
  fetchToken: () => Promise<string>;
  /** Optional line sink for stderr/diagnostics. */
  logger?: (line: string) => void;
}

export interface CloneSource {
  cloneUrl: string;
  defaultBranch: string;
  baseSha: string;
}

/** Name of the checked-out work tree under `workspace`. */
export const REPO_DIRNAME = 'repo';

/**
 * A run of the git binary. The environment is constructed explicitly (allowlist,
 * NOT the parent env) so no ambient secret — least of all the clone token —
 * rides along, and so no global credential helper can interfere. The token is
 * never an argument here; callers pass a credential-store FILE path via `-c`.
 */
export async function runGit(opts: GitOptions, args: string[], cwd: string): Promise<GitRunResult> {
  const gitBin = opts.gitBin ?? 'git';
  const env: NodeJS.ProcessEnv = {
    // A minimal, hermetic env. No token, no inherited credential config.
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: opts.workspace,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LANG: 'C',
  };
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn(gitBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/**
 * Clone at the pinned `baseSha`, read-only, via a one-shot credential-store file
 * (0600, outside the work tree, deleted in `finally`). Returns the work-tree dir.
 */
export async function cloneAtBaseSha(opts: GitOptions, src: CloneSource): Promise<string> {
  // Refuse embedded credentials BEFORE fetching a token or touching git: a
  // `user:pass@` cloneUrl would put secret material on argv and persist it in
  // `.git/config`, bypassing the credential-store design entirely.
  assertNoUserinfo(src.cloneUrl);

  const repoDir = path.join(opts.workspace, REPO_DIRNAME);
  // The credential file lives OUTSIDE repoDir so it can never end up inside
  // `.git`, and carries a random suffix so two provisions never collide.
  const credFile = path.join(opts.workspace, `.git-credentials-${randomBytes(8).toString('hex')}`);

  const token = await opts.fetchToken();
  await writeCredentialStore(credFile, src.cloneUrl, token);

  try {
    const clone = await runGit(
      opts,
      [
        // Disable any inherited helper, then point at our store file. The value
        // after the second `-c` is `credential.helper=store --file=<path>`; git
        // parses it and runs `git-credential-store --file=<path>`. The PATH is
        // in argv, the token is not.
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=store --file=${credFile}`,
        '-c',
        'credential.useHttpPath=false',
        'clone',
        '--depth',
        '50',
        '--branch',
        src.defaultBranch,
        src.cloneUrl,
        repoDir,
      ],
      opts.workspace,
    );
    if (clone.code !== 0) {
      throw new Error(`git clone failed (${String(clone.code)}): ${lastLine(clone.stderr)}`);
    }

    if (src.baseSha) {
      const checkout = await runGit(opts, ['-C', repoDir, 'checkout', '--detach', src.baseSha], repoDir);
      if (checkout.code !== 0) {
        throw new Error(`git checkout ${short(src.baseSha)} failed (${String(checkout.code)}): ${lastLine(checkout.stderr)}`);
      }
    }
    return repoDir;
  } finally {
    // The token file is destroyed whether or not the clone succeeded.
    await rm(credFile, { force: true });
  }
}

export interface DiffResult {
  hasChanges: boolean;
  /** Present when `hasChanges`. `git diff --binary --cached`. */
  diff: string;
  /** Present when `hasChanges`. `git diff --numstat --cached`. */
  numstat: string;
}

/**
 * Stage everything and produce the diff + numstat (spec §5 step 6). NO push,
 * NO ref move. An empty work tree ⇒ `{ hasChanges: false }`.
 */
export async function collectDiff(opts: GitOptions, repoDir: string): Promise<DiffResult> {
  const status = await runGit(opts, ['-C', repoDir, 'status', '--porcelain'], repoDir);
  if (status.code !== 0) {
    throw new Error(`git status failed (${String(status.code)}): ${lastLine(status.stderr)}`);
  }
  if (status.stdout.trim().length === 0) {
    return { hasChanges: false, diff: '', numstat: '' };
  }

  const add = await runGit(opts, ['-C', repoDir, 'add', '-A'], repoDir);
  if (add.code !== 0) {
    throw new Error(`git add failed (${String(add.code)}): ${lastLine(add.stderr)}`);
  }
  const diff = await runGit(opts, ['-C', repoDir, 'diff', '--binary', '--cached'], repoDir);
  if (diff.code !== 0) {
    throw new Error(`git diff failed (${String(diff.code)}): ${lastLine(diff.stderr)}`);
  }
  const numstat = await runGit(opts, ['-C', repoDir, 'diff', '--numstat', '--cached'], repoDir);
  if (numstat.code !== 0) {
    throw new Error(`git diff --numstat failed (${String(numstat.code)}): ${lastLine(numstat.stderr)}`);
  }
  return { hasChanges: true, diff: diff.stdout, numstat: numstat.stdout };
}

/**
 * Write the `git-credential-store` file at mode 0600. Format is one line per
 * origin: `https://x-access-token:<token>@<host>`. The token is URL-encoded so a
 * `@`/`:`/`/` in it cannot break the line. `useHttpPath=false` (set on the git
 * command) makes git match on protocol+host alone.
 */
async function writeCredentialStore(credFile: string, cloneUrl: string, token: string): Promise<void> {
  let origin: URL;
  try {
    origin = new URL(cloneUrl);
  } catch {
    throw new Error('dev-runner-shim: clone URL is not a valid absolute URL');
  }
  if (origin.protocol !== 'https:') {
    // W0 is https-only (spec §2 `clone_url` comment); refuse anything else so a
    // token is never handed to an ssh/file/http endpoint.
    throw new Error(`dev-runner-shim: refusing to attach a credential to a ${origin.protocol} clone URL`);
  }
  const line = `https://x-access-token:${encodeURIComponent(token)}@${origin.host}\n`;
  // `mode` on writeFile is subject to umask; chmod pins it to exactly 0600.
  await writeFile(credFile, line, { mode: 0o600 });
  await chmod(credFile, 0o600);
}

/**
 * The clone credential travels ONLY via the credential-store file. A cloneUrl
 * carrying userinfo (`https://user:pass@host/…`) would leak whatever it embeds
 * onto git argv (world-readable via `ps`) and into `.git/config` — refuse it.
 */
function assertNoUserinfo(cloneUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new Error('dev-runner-shim: clone URL is not a valid absolute URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'dev-runner-shim: refusing a clone URL with embedded credentials (userinfo); ' +
        'the clone token travels only via the credential-store file',
    );
  }
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
