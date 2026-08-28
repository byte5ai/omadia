/**
 * Runtime CLI install (#309 extension, enabler for #294) — service + route.
 *
 * The npm runner and the detection snapshot are injected via the service's
 * test seams, so nothing here touches the network, npm, or the host's real
 * CLI installs (the detector tests deliberately do; these must not).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
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
