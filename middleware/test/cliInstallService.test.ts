/**
 * Runtime CLI install (#309 extension, enabler for #294) — service + route.
 *
 * The npm runner and the detection snapshot are injected via the service's
 * test seams, so nothing here touches the network, npm, or the host's real
 * CLI installs (the detector tests deliberately do; these must not).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  startCliInstall,
  getCliInstallStatus,
  UnknownCliBackendError,
  CliInstallConflictError,
  InvalidCliVersionError,
  __setCliInstallRunner,
  __setCliInstallDetector,
  __resetCliInstallState,
} from '../src/platform/cliInstallService.js';
import {
  cliToolsDir,
  resolveCliBin,
  getInstallPackage,
  __resetCliBackendCache,
} from '../src/platform/cliBackendDetector.js';
import { createAdminCliBackendsRouter } from '../src/routes/adminCliBackends.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/** A detection snapshot with every backend absent (the fresh-container case). */
const NOTHING_INSTALLED = {
  backends: [
    {
      id: 'codex',
      label: 'Codex (OpenAI)',
      bin: 'codex',
      installed: false,
      loggedIn: 'no' as const,
      billing: 'needs-verification' as const,
      detail: 'x',
      installable: true,
    },
  ],
  cliToolsDir: cliToolsDir(),
  generatedAt: 0,
};

async function waitForTerminal(cliId: string): Promise<ReturnType<typeof getCliInstallStatus>> {
  for (let i = 0; i < 100; i++) {
    const s = getCliInstallStatus(cliId);
    if (s.status === 'succeeded' || s.status === 'failed') return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  return getCliInstallStatus(cliId);
}

/** Run `body` with a known PATH so the searched-PATH detail is assertable. */
async function withPath(pathValue: string, body: () => Promise<void>): Promise<void> {
  const previousPath = process.env['PATH'];
  process.env['PATH'] = pathValue;
  try {
    await body();
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
  }
}

/**
 * A Node spawn failure. THE SHAPES HERE ARE MEASURED, NOT ASSUMED.
 *
 * On Node v22.23.2, spawning bare `npm` off a doctored PATH:
 *
 * | scenario           | delivery      | code    | syscall      | path    |
 * |--------------------|---------------|---------|--------------|---------|
 * | 0-byte `+x` npm    | SYNC throw    | ENOEXEC | `spawn`      | absent  |
 * | npm without `+x`   | callback      | EACCES  | `spawn npm`  | `'npm'` |
 * | npm is a directory | callback      | EACCES  | `spawn npm`  | `'npm'` |
 * | no npm at all      | callback      | ENOENT  | `spawn npm`  | `'npm'` |
 *
 * Two things follow, and an earlier version of this file got both wrong:
 * ENOEXEC never carries `path`, and the failures that DO carry it carry the
 * spawnfile as passed — the bare string `'npm'`, which names no file. So a
 * fixture inventing an absolute `err.path` models a case this runner cannot
 * produce, and it hid a real defect: the detail degraded to `npm file: npm`
 * in exactly the common case while the rare one kept working.
 */
function spawnError(errno: string, extra: Readonly<Record<string, string>> = {}): Error {
  return Object.assign(new Error(`spawn npm ${errno}`), {
    code: errno,
    syscall: 'spawn npm',
    ...extra,
  });
}

/** The measured ENOEXEC shape: thrown synchronously, `spawn`, no `path`. */
function enoexecError(): Error {
  return Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC', syscall: 'spawn' });
}

/**
 * Run `body` with a real (broken) `npm` file on the PATH, so the resolution
 * that names the offending file has something truthful to find.
 */
async function withFakeNpm(body: (npmFile: string) => Promise<void>): Promise<void> {
  const binDir = mkdtempSync(path.join(tmpdir(), 'fake-npm-bin-'));
  const npmFile = path.join(binDir, 'npm');
  writeFileSync(npmFile, '');
  chmodSync(npmFile, 0o755);
  try {
    await withPath(binDir, () => body(npmFile));
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('cliInstallService', () => {
  let dir: string;
  let prevToolsDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cli-tools-'));
    prevToolsDir = process.env['CLI_TOOLS_DIR'];
    process.env['CLI_TOOLS_DIR'] = dir;
    __setCliInstallDetector(async () => NOTHING_INSTALLED);
  });

  afterEach(() => {
    __setCliInstallRunner(undefined);
    __setCliInstallDetector(undefined);
    __resetCliInstallState();
    __resetCliBackendCache();
    if (prevToolsDir === undefined) delete process.env['CLI_TOOLS_DIR'];
    else process.env['CLI_TOOLS_DIR'] = prevToolsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an id outside the allowlist — nothing user-controlled reaches npm', async () => {
    await assert.rejects(
      () => startCliInstall('lodash; curl evil'),
      UnknownCliBackendError,
    );
  });

  it('rejects a non-semver version so it can never appear in the argv', async () => {
    for (const bad of ['latest', '1.2', '1.2.3 --registry=http://evil', '$(reboot)', '1.2.3;x']) {
      await assert.rejects(() => startCliInstall('codex', bad), InvalidCliVersionError);
    }
  });

  it('short-circuits when detection says the backend is already installed', async () => {
    __setCliInstallDetector(async () => ({
      ...NOTHING_INSTALLED,
      backends: [{ ...NOTHING_INSTALLED.backends[0]!, installed: true }],
    }));
    let ran = false;
    __setCliInstallRunner(async () => {
      ran = true;
      return { ok: true, output: '' };
    });
    const res = await startCliInstall('codex');
    assert.deepEqual(res, { started: false, alreadyInstalled: true });
    assert.equal(ran, false);
  });

  it('runs npm with the allowlisted package, the tools prefix, and the pinned version', async () => {
    let seenArgs: readonly string[] = [];
    __setCliInstallRunner(async (args) => {
      seenArgs = args;
      return { ok: true, output: 'added 1 package' };
    });
    const res = await startCliInstall('codex', '1.2.3');
    assert.deepEqual(res, { started: true, alreadyInstalled: false });
    const done = await waitForTerminal('codex');
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(seenArgs, ['install', '-g', '--prefix', dir, '@openai/codex@1.2.3']);
  });

  it('a failed npm run with log output reports npm_failed and preserves the log-tail message', async () => {
    __setCliInstallRunner(async () => ({ ok: false, output: 'npm ERR! EAI_AGAIN registry' }));
    await startCliInstall('codex', '1.2.3');
    const done = await waitForTerminal('codex');
    assert.equal(done.status, 'failed');
    assert.equal(done.code, 'cli_install.npm_failed');
    assert.equal(done.error, 'npm install failed — see the log tail.');
    assert.match(done.logTail ?? '', /EAI_AGAIN/);
    // The searched-PATH hint belongs to the no-output branch only — here the
    // log tail already carries npm's own diagnosis (#925).
    assert.doesNotMatch(done.error ?? '', /Searched PATH:/);
  });

  it('a failed npm run with no output reports no_output and names the PATH npm was searched on', async () => {
    // A no-output failure is npm-not-found; the PATH the child was actually
    // handed is the whole diagnosis, so it must reach the UI detail (#925).
    await withPath('/sentinel/bin:/sentinel/sbin', async () => {
      let seenPath: string | undefined;
      __setCliInstallRunner(async (_args, env) => {
        seenPath = env['PATH'];
        return { ok: false, output: '' };
      });
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.status, 'failed');
      assert.equal(done.code, 'cli_install.no_output');
      assert.ok(
        done.error?.startsWith(
          'npm install failed — no output at all; npm was most likely not found.',
        ),
        done.error ?? '(no error)',
      );
      assert.match(done.error ?? '', /Searched PATH:/);
      assert.equal(seenPath, '/sentinel/bin:/sentinel/sbin');
      assert.ok(done.error?.includes(seenPath ?? '<unset>'), done.error ?? '(no error)');
      assert.equal(done.logTail, undefined);
    });
  });

  it('bounds the searched-PATH line instead of emitting an over-long PATH in full', async () => {
    const longPath = Array.from({ length: 200 }, (_, i) => `/very/long/dir/number-${i}`).join(':');
    await withPath(longPath, async () => {
      __setCliInstallRunner(async () => ({ ok: false, output: '' }));
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.code, 'cli_install.no_output');
      const searchedLine = (done.error ?? '')
        .split('\n')
        .find((line) => line.startsWith('Searched PATH:'));
      assert.ok(searchedLine, done.error ?? '(no error)');
      assert.ok(longPath.length > 1000, 'fixture PATH must exceed the cap to be a real test');
      assert.ok(searchedLine.length < 600, `searched-PATH line unbounded: ${searchedLine.length}`);
    });
  });

  it('a spawn ENOEXEC reports spawn_failed and names the file, with no log tail', async () => {
    // The reporter's own case: a 0-byte npm-cli.js with the execute bit set.
    // Node throws this one synchronously and attaches no `path`, so the file
    // can only come from resolving the handed PATH (#933, OM-68).
    await withFakeNpm(async (npmFile) => {
      __setCliInstallRunner(async () => {
        throw enoexecError();
      });
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.status, 'failed');
      assert.equal(done.code, 'cli_install.spawn_failed');
      assert.match(done.error ?? '', /ENOEXEC/);
      assert.match(done.error ?? '', /npm never ran/);
      assert.ok(
        done.error?.includes(npmFile),
        `spawn detail did not name the resolved npm file: ${done.error ?? '(no error)'}`,
      );
      // npm never ran, so the copy must not point at log details.
      assert.equal(done.logTail, undefined);
    });
  });

  it('names a real file when err.path is the bare spawnfile, not the string "npm"', async () => {
    // REGRESSION GUARD. Node sets `err.path` to the command as passed, so the
    // EACCES/ENOENT shapes carry `'npm'`. Trusting it made the detail read
    // `npm file: npm`, naming nothing — while the help copy promises the file
    // IS named. The absolute-path fixtures this suite used to rely on could
    // never have caught it, because this runner cannot produce them.
    await withFakeNpm(async (npmFile) => {
      __setCliInstallRunner(async () => {
        throw spawnError('EACCES', { path: 'npm' });
      });
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.code, 'cli_install.spawn_failed');
      assert.ok(
        done.error?.includes(npmFile),
        `bare err.path was trusted over PATH resolution: ${done.error ?? '(no error)'}`,
      );
      assert.doesNotMatch(done.error ?? '', /npm file: npm$/m);
    });
  });

  it('uses err.path verbatim when it does name a real path', async () => {
    // The other side of the same rule: a runner that spawns an absolute path
    // gets a usable `err.path`, and then no PATH resolution is needed.
    __setCliInstallRunner(async () => {
      throw spawnError('EACCES', { path: '/opt/broken/bin/npm' });
    });
    await startCliInstall('codex', '1.2.3');
    const done = await waitForTerminal('codex');
    assert.equal(done.code, 'cli_install.spawn_failed');
    assert.match(done.error ?? '', /npm file: \/opt\/broken\/bin\/npm/);
  });

  it('a spawn ENOENT stays on no_output — there is no file to call unrunnable', async () => {
    // The split is the whole point: telling an operator who has no npm that
    // "the npm file found is not executable" is the same class of untrue
    // message this issue was filed about. ENOENT belongs to the PATH story.
    await withPath('/sentinel/bin', async () => {
      __setCliInstallRunner(async () => {
        throw spawnError('ENOENT', { path: 'npm' });
      });
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.code, 'cli_install.no_output');
      assert.match(done.error ?? '', /Searched PATH: \/sentinel\/bin/);
      // A proven absence must not hedge with "most likely".
      assert.match(done.error ?? '', /was not found on the PATH/);
      assert.doesNotMatch(done.error ?? '', /most likely/);
    });
  });

  it('classifies a spawn failure the runner resolves rather than throws', async () => {
    // The default npmRunner resolves with ok:false and hands the raw error up;
    // it must classify the same as the throwing shape above.
    await withFakeNpm(async (npmFile) => {
      __setCliInstallRunner(async () => ({
        ok: false,
        output: '',
        failure: spawnError('EACCES', { path: 'npm' }),
      }));
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.code, 'cli_install.spawn_failed');
      assert.match(done.error ?? '', /EACCES/);
      assert.ok(done.error?.includes(npmFile), done.error ?? '(no error)');
    });
  });

  it('a resolved ENOENT carrying stderr still reports no_output, not npm_failed', async () => {
    // Asymmetry guard. The resolve path used to reach no_output only because
    // npmRunner's output happens to trim to empty; any stderr alongside a
    // spawn ENOENT would have fallen through to npm_failed and claimed npm ran.
    await withPath('/sentinel/bin', async () => {
      __setCliInstallRunner(async () => ({
        ok: false,
        output: 'some wrapper noise on stderr',
        failure: spawnError('ENOENT', { path: 'npm' }),
      }));
      await startCliInstall('codex', '1.2.3');
      const done = await waitForTerminal('codex');
      assert.equal(done.code, 'cli_install.no_output');
      assert.match(done.error ?? '', /was not found on the PATH/);
    });
  });

  it('leaves a non-spawn thrown error on npm_failed', async () => {
    // Regression guard on the path this change must NOT alter.
    __setCliInstallRunner(async () => {
      throw new Error('runner exploded');
    });
    await startCliInstall('codex', '1.2.3');
    const done = await waitForTerminal('codex');
    assert.equal(done.code, 'cli_install.npm_failed');
    assert.equal(done.error, 'runner exploded');
  });

  it('does not call an unrelated fs errno a spawn failure', async () => {
    // Same errno, different syscall: an EACCES from an `open` inside a runner
    // is not "npm is not executable", and must not borrow that copy.
    __setCliInstallRunner(async () => {
      throw Object.assign(new Error('EACCES: permission denied, open ...'), {
        code: 'EACCES',
        syscall: 'open',
      });
    });
    await startCliInstall('codex', '1.2.3');
    const done = await waitForTerminal('codex');
    assert.equal(done.code, 'cli_install.npm_failed');
  });

  it('a real npm exit code is a number, so it can never look like a spawn errno', async () => {
    // execFile puts the child's exit status on `code` as a NUMBER; only spawn
    // failures use the string errno. The string guard is what keeps a genuine
    // `npm install` failure off the spawn path.
    __setCliInstallRunner(async () => ({
      ok: false,
      output: 'npm ERR! code E404',
      failure: Object.assign(new Error('Command failed: npm install'), { code: 3 }),
    }));
    await startCliInstall('codex', '1.2.3');
    const done = await waitForTerminal('codex');
    assert.equal(done.code, 'cli_install.npm_failed');
    assert.match(done.logTail ?? '', /E404/);
  });

  it('reserves the single-flight slot across the idempotency probe (no TOCTOU race)', async () => {
    // Two concurrent VERSIONLESS starts: the second must conflict even while
    // the first is still awaiting detection — otherwise both would run
    // `npm install -g` into the same prefix.
    let releaseDetect!: () => void;
    const detectGate = new Promise<void>((r) => {
      releaseDetect = r;
    });
    __setCliInstallDetector(async () => {
      await detectGate;
      return NOTHING_INSTALLED;
    });
    __setCliInstallRunner(async () => ({ ok: true, output: '' }));

    const first = startCliInstall('codex');
    await assert.rejects(() => startCliInstall('codex'), CliInstallConflictError);
    releaseDetect();
    assert.deepEqual(await first, { started: true, alreadyInstalled: false });
    const done = await waitForTerminal('codex');
    assert.equal(done.status, 'succeeded');
  });

  it('releases the single-flight slot when the backend turns out to be installed', async () => {
    __setCliInstallDetector(async () => ({
      ...NOTHING_INSTALLED,
      backends: [{ ...NOTHING_INSTALLED.backends[0]!, installed: true }],
    }));
    const res = await startCliInstall('codex');
    assert.deepEqual(res, { started: false, alreadyInstalled: true });
    // Slot must be free again — a follow-up (versioned) install may start.
    __setCliInstallRunner(async () => ({ ok: true, output: '' }));
    const second = await startCliInstall('codex', '1.2.3');
    assert.deepEqual(second, { started: true, alreadyInstalled: false });
  });

  it('is single-flight: a second start while one runs is a conflict', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    __setCliInstallRunner(async () => {
      await gate;
      return { ok: true, output: '' };
    });
    await startCliInstall('codex', '1.2.3');
    await assert.rejects(() => startCliInstall('codex', '1.2.3'), CliInstallConflictError);
    release();
    const done = await waitForTerminal('codex');
    assert.equal(done.status, 'succeeded');
  });

  it('status for a backend with no job is idle', () => {
    assert.deepEqual(getCliInstallStatus('claude'), { cliId: 'claude', status: 'idle' });
  });

  it('resolveCliBin prefers the tools dir over PATH only when the binary exists there', () => {
    // Nothing installed in the fresh temp dir → bare name (PATH resolution).
    assert.equal(resolveCliBin('codex'), 'codex');
    assert.equal(cliToolsDir(), dir);
  });

  it('every detector backend with an install package is exposed to the service', () => {
    assert.equal(getInstallPackage('claude'), '@anthropic-ai/claude-code');
    assert.equal(getInstallPackage('codex'), '@openai/codex');
    assert.equal(getInstallPackage('gemini'), '@google/gemini-cli');
    assert.equal(getInstallPackage('nope'), undefined);
  });
});

describe('adminCliBackends install routes', () => {
  let server: Server | undefined;
  let dir: string;
  let prevToolsDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cli-tools-'));
    prevToolsDir = process.env['CLI_TOOLS_DIR'];
    process.env['CLI_TOOLS_DIR'] = dir;
    __setCliInstallDetector(async () => NOTHING_INSTALLED);
  });

  afterEach(async () => {
    __setCliInstallRunner(undefined);
    __setCliInstallDetector(undefined);
    __resetCliInstallState();
    __resetCliBackendCache();
    if (prevToolsDir === undefined) delete process.env['CLI_TOOLS_DIR'];
    else process.env['CLI_TOOLS_DIR'] = prevToolsDir;
    rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function startServer(): Promise<number> {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/cli-backends', createAdminCliBackendsRouter());
    server = await listenLoopback(app);
    return (server.address() as AddressInfo).port;
  }

  it('POST /:id/install accepts with 202 and the status endpoint reaches succeeded', async () => {
    __setCliInstallRunner(async () => ({ ok: true, output: 'added 1 package' }));
    const port = await startServer();

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/cli-backends/codex/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: 'started' });

    await waitForTerminal('codex');
    const status = await fetch(
      `http://127.0.0.1:${port}/api/v1/admin/cli-backends/codex/install/status`,
    );
    assert.equal(status.status, 200);
    const body = (await status.json()) as { status: string };
    assert.equal(body.status, 'succeeded');
  });

  it('POST /:id/install with a running job answers 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    __setCliInstallRunner(async () => {
      await gate;
      return { ok: true, output: '' };
    });
    const port = await startServer();
    const url = `http://127.0.0.1:${port}/api/v1/admin/cli-backends/codex/install`;

    const first = await fetch(url, { method: 'POST' });
    assert.equal(first.status, 202);
    const second = await fetch(url, { method: 'POST' });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string };
    assert.equal(body.error, 'install_in_progress');
    release();
  });

  it('POST /:id/install rejects unknown ids and malformed versions with 400', async () => {
    const port = await startServer();
    const unknown = await fetch(
      `http://127.0.0.1:${port}/api/v1/admin/cli-backends/definitely-not-a-cli/install`,
      { method: 'POST' },
    );
    assert.equal(unknown.status, 400);

    const badVersion = await fetch(
      `http://127.0.0.1:${port}/api/v1/admin/cli-backends/codex/install`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 'latest && curl evil' }),
      },
    );
    assert.equal(badVersion.status, 400);
  });
});
