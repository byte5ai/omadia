import { describe, it, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import { CLI_ENV_SCRUB_KEYS } from '../packages/harness-orchestrator/src/cliChatAgent.js';

import {
  detectCliBackends,
  cliBackendBin,
  cliToolsDir,
  scrubbedEnv,
  __resetCliBackendCache,
} from '../src/platform/cliBackendDetector.js';
import { createAdminCliBackendsRouter } from '../src/routes/adminCliBackends.js';
import { claudeCliAdapter } from '../src/platform/claudeCliAdapter.js';
import { resolveClaudeCliBin } from '../src/platform/cliBinary.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

describe('cliBackendDetector', () => {
  afterEach(() => {
    __resetCliBackendCache();
  });

  it('reports the three supported vendor CLIs with honest billing posture', async () => {
    const snap = await detectCliBackends({ force: true });
    const ids = snap.backends.map((b) => b.id).sort();
    assert.deepEqual(ids, ['claude', 'codex', 'gemini']);

    const claude = snap.backends.find((b) => b.id === 'claude');
    assert.ok(claude);
    // Claude is the only v1-recommended (subscription-billed) path.
    assert.equal(claude.billing, 'subscription');

    for (const id of ['codex', 'gemini']) {
      const b = snap.backends.find((x) => x.id === id);
      assert.ok(b);
      assert.equal(b.billing, 'needs-verification');
    }
  });

  it('every backend exposes a tri-state login and a human detail', async () => {
    const snap = await detectCliBackends({ force: true });
    for (const b of snap.backends) {
      assert.ok(['yes', 'no', 'unknown'].includes(b.loggedIn));
      assert.equal(typeof b.installed, 'boolean');
      assert.ok(b.detail.length > 0);
      // A CLI that is not installed must never claim a login.
      if (!b.installed) assert.equal(b.loggedIn, 'no');
    }
  });

  // OM-22 — "Erneut prüfen" appeared to do nothing. The report blamed a missing
  // spinner, but a busy state already existed and simply finishes in under
  // 100 ms on a local `--version` probe. The real defect: `generatedAt` was
  // already on the wire and had ZERO render sites, so a re-check whose result
  // was unchanged produced no observable change at all. It must therefore be
  // present on every snapshot — including one where nothing is installed, which
  // is exactly the case a self-hoster hits first.
  it('an installed:false snapshot still carries generatedAt', async () => {
    const before = Date.now();
    const snap = await detectCliBackends({ force: true });
    const after = Date.now();

    assert.equal(typeof snap.generatedAt, 'number');
    assert.ok(snap.generatedAt >= before && snap.generatedAt <= after);

    // The assertion is about the snapshot, not about this machine's tooling —
    // assert the invariant for whichever backends happen to be absent here.
    for (const b of snap.backends.filter((x) => !x.installed)) {
      assert.equal(b.loggedIn, 'no');
      assert.ok(snap.generatedAt > 0, `generatedAt missing while ${b.id} is absent`);
    }
  });

  it('includes the runtime install prefix in every snapshot', async () => {
    const snap = await detectCliBackends({ force: true });
    assert.equal(snap.cliToolsDir, cliToolsDir());
  });

  it('caches within the TTL and re-detects on force', async () => {
    const first = await detectCliBackends({ force: true });
    const cached = await detectCliBackends();
    assert.equal(first, cached, 'a non-forced call within TTL returns the cached snapshot');

    const forced = await detectCliBackends({ force: true });
    assert.notEqual(forced, cached, 'force bypasses the cache');
    assert.equal(forced.backends.length, 3);
  });

  it('scrubbedEnv strips the canonical credential and backend-switch key set', () => {
    const vars = Object.fromEntries(
      CLI_ENV_SCRUB_KEYS.map((key) => [key, `${key.toLowerCase()}-secret`]),
    );
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    try {
      const env = scrubbedEnv();
      for (const k of CLI_ENV_SCRUB_KEYS) assert.equal(env[k], undefined, `${k} must be scrubbed`);
      assert.equal(env['PATH'], process.env['PATH']); // non-credential vars preserved
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  });
});

describe('claudeCliAdapter (Shape-2)', () => {
  it('advertises tools:false but supports forced single-tool structured output', () => {
    const provider = claudeCliAdapter.build({ apiKey: 'no-key-required', id: 'claude-cli' });
    assert.equal(provider.capabilities.tools, false);
    assert.equal(provider.capabilities.forcedToolChoice, true);
  });

  it('fails closed on GENERAL (auto, non-forced) tool use', async () => {
    const provider = claudeCliAdapter.build({ apiKey: 'no-key-required', id: 'claude-cli' });
    await assert.rejects(
      provider.complete({
        model: 'sonnet-cli',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 100,
        tools: [{ name: 'do_thing', description: 'x', inputSchema: {} }],
        // no toolChoice → general tool use → rejected (forced single-tool only)
      }),
      /forced single-tool|general tool use/,
    );
  });

  /**
   * #1085 — the completion path (verifier claim extraction, evidence judge,
   * summaries, fact extraction) carried its own `const CLI_BIN = 'claude'` and
   * never asked the detector where the binary is, so it probed and spawned the
   * image binary while the admin UI reported the one in the runtime install
   * dir. It now shares `resolveClaudeCliBin()` with the other kernel-side
   * spawn sites (CLI sub-agents, the builder, the preview chat).
   */
  describe('binary resolution (#1085)', () => {
    let dir: string;
    let prevToolsDir: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'cli-tools-'));
      prevToolsDir = process.env['CLI_TOOLS_DIR'];
      process.env['CLI_TOOLS_DIR'] = dir;
    });

    afterEach(() => {
      if (prevToolsDir === undefined) delete process.env['CLI_TOOLS_DIR'];
      else process.env['CLI_TOOLS_DIR'] = prevToolsDir;
      rmSync(dir, { recursive: true, force: true });
    });

    it('uses the runtime install dir when a CLI is installed there, PATH otherwise', () => {
      // Nothing installed yet → the bare name, i.e. PATH, exactly as before.
      assert.equal(resolveClaudeCliBin(), 'claude');

      // An operator hits "Install now": npm writes <cliToolsDir>/bin/claude.
      // Resolution happens per call, so the very next completion picks it up
      // without a restart — a module-level constant would not.
      mkdirSync(path.join(dir, 'bin'), { recursive: true });
      writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });

      assert.equal(resolveClaudeCliBin(), path.join(dir, 'bin', 'claude'));
    });

    it('resolves through the same rule the detector and the install button use', () => {
      mkdirSync(path.join(dir, 'bin'), { recursive: true });
      writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });

      assert.equal(resolveClaudeCliBin(), path.join(cliToolsDir(), 'bin', 'claude'));
    });

    it('falls back to PATH when the install-dir binary is not executable', () => {
      // Before #1085 a broken install dir cost a stale version badge. Now
      // every chat turn and every completion resolves through here, so an
      // `npm install -g --prefix` that dies after writing the file but before
      // setting the exec bit would take chat down with EACCES on every spawn
      // — while a perfectly good binary sits on PATH one fallback away. An
      // existence check cannot tell the two apart; X_OK can.
      mkdirSync(path.join(dir, 'bin'), { recursive: true });
      writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o644 });

      assert.equal(resolveClaudeCliBin(), 'claude');
    });

    it('returns an absolute path even for a relative CLI_TOOLS_DIR', () => {
      // Every spawn site runs the CLI with `cwd` set to a fresh temp dir. A
      // relative candidate passes X_OK against the process cwd and then
      // ENOENTs at spawn — on every turn, with a working binary on PATH.
      mkdirSync(path.join(dir, 'bin'), { recursive: true });
      writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      process.env['CLI_TOOLS_DIR'] = path.relative(process.cwd(), dir);

      assert.equal(resolveClaudeCliBin(), path.join(dir, 'bin', 'claude'));
    });

    it('the completion adapter probes and spawns the resolved binary, not PATH', async () => {
      // Both fakes log `$0`; the PATH one answers differently and shadows any
      // real `claude` on this machine, so a regression to the bare name is
      // caught here and never reaches a logged-in CLI.
      const calls = path.join(dir, 'calls.log');
      const fake = (answer: string): string =>
        `#!/bin/sh\necho "$0" >> '${calls}'\n` +
        `if [ "$1" = "--version" ]; then echo "2.1.259 (Claude Code)"; exit 0; fi\n` +
        `cat > /dev/null\n` +
        `echo '{"type":"result","is_error":false,"result":"${answer}","usage":{"input_tokens":1,"output_tokens":1}}'\n`;
      const installed = path.join(dir, 'bin', 'claude');
      mkdirSync(path.join(dir, 'bin'), { recursive: true });
      writeFileSync(installed, fake('from-runtime-install'), { mode: 0o755 });
      const pathDir = mkdtempSync(path.join(tmpdir(), 'path-claude-'));
      writeFileSync(path.join(pathDir, 'claude'), fake('from-path'), { mode: 0o755 });
      const prevPath = process.env['PATH'];
      process.env['PATH'] = `${pathDir}${path.delimiter}${prevPath ?? ''}`;
      try {
        const provider = claudeCliAdapter.build({ apiKey: 'no-key-required', id: 'claude-cli' });
        const res = await provider.complete({
          model: 'sonnet-cli',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          maxTokens: 100,
        });

        assert.deepEqual(res.content, [{ type: 'text', text: 'from-runtime-install' }]);
        // One `--version` probe, one completion — both against the SAME path.
        assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [installed, installed]);
      } finally {
        if (prevPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = prevPath;
        rmSync(pathDir, { recursive: true, force: true });
      }
    });

    it('takes the binary name from the detector table, not a second literal', () => {
      // #1085 is a drift bug: the fix is worthless if the spawn path keeps its
      // own copy of the name. `cliBackendBin` reads CLI_BACKENDS — the same
      // table detection and `cliAuthService` resolve through — so a rename
      // moves login, detection and every spawn together or not at all.
      assert.equal(cliBackendBin('claude'), 'claude');
      assert.equal(cliBackendBin('codex'), 'codex');
      assert.equal(cliBackendBin('gemini'), 'gemini');
      // Unknown ids fall back to the id rather than throwing under a spawn.
      assert.equal(cliBackendBin('nope'), 'nope');
    });
  });
});

describe('adminCliBackends route', () => {
  let server: Server | undefined;

  afterEach(async () => {
    __resetCliBackendCache();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('GET / returns the detection snapshot as JSON', async () => {
    const app = express();
    app.use('/api/v1/admin/cli-backends', createAdminCliBackendsRouter());
    server = await listenLoopback(app);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/cli-backends`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      backends: Array<{ id: string }>;
      generatedAt: number;
    };
    assert.equal(body.backends.length, 3);
    assert.equal(typeof body.generatedAt, 'number');
  });

  it('POST /:id/login/code rejects a missing sessionId/code with 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/cli-backends', createAdminCliBackendsRouter());
    server = await listenLoopback(app);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/cli-backends/claude/login/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /:id/login/cancel always returns ok', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/cli-backends', createAdminCliBackendsRouter());
    server = await listenLoopback(app);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/cli-backends/claude/login/cancel`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
