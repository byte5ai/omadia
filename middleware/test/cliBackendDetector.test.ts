import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { CLI_ENV_SCRUB_KEYS } from '../packages/harness-orchestrator/src/cliChatAgent.js';

import {
  detectCliBackends,
  scrubbedEnv,
  __resetCliBackendCache,
} from '../src/platform/cliBackendDetector.js';
import { createAdminCliBackendsRouter } from '../src/routes/adminCliBackends.js';
import { claudeCliAdapter } from '../src/platform/claudeCliAdapter.js';

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

describe('claudeCliAdapter (Shape-2, tool-less)', () => {
  it('advertises tools:false and fails closed when a request carries tools', async () => {
    const provider = claudeCliAdapter.build({ apiKey: 'no-key-required', id: 'claude-cli' });
    assert.equal(provider.capabilities.tools, false);
    await assert.rejects(
      provider.complete({
        model: 'sonnet-cli',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 100,
        tools: [{ name: 'do_thing', description: 'x', inputSchema: {} }],
      }),
      /tool-less/,
    );
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
    server = app.listen(0);
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
    server = app.listen(0);
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
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/cli-backends/claude/login/cancel`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
