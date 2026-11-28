/**
 * #2320 — `/api/v1/admin/sandboxes` against a real Express app with the
 * in-memory registry and a stubbed `docker` spawn.
 *
 * Pins: 503 without a registry; the dry run selects exactly what the reaper
 * would (never a persistent sandbox) and removes nothing; a sweep removes
 * idle containers and rows and is audited; a failed `docker rm` keeps the
 * row; a ref that is not a container name never reaches the CLI.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express, { type Express } from 'express';

import {
  InMemorySandboxRegistry,
  resolveAgentComputerProfile,
  type DockerExec,
  type DockerExecContext,
} from '@omadia/sandbox';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { createAdminSandboxesRouter, type AdminSandboxesRouteDeps } from '../src/routes/adminSandboxes.js';

const NOW = new Date('2026-11-28T12:00:00Z');
const HOUR = 60 * 60 * 1000;

async function seed(registry: InMemorySandboxRegistry): Promise<void> {
  const rows: Array<[string, string, number, boolean]> = [
    ['personal:idle', 'omadia-sbx-idle', 48, false],
    ['personal:fresh', 'omadia-sbx-fresh', 1, false],
    ['personal:kept', 'omadia-sbx-kept', 72, true],
    ['personal:evil', '--rm-everything', 72, false],
  ];
  for (const [scopeKey, sandboxRef, ageHours, persistent] of rows) {
    await registry.upsert({
      scopeKey,
      backend: 'docker',
      sandboxRef,
      profile: { ...resolveAgentComputerProfile(), persistent },
      now: new Date(NOW.getTime() - ageHours * HOUR),
    });
  }
}

function dockerStub(failFor: ReadonlySet<string> = new Set()) {
  const calls: DockerExecContext[] = [];
  const exec: DockerExec = async (ctx) => {
    calls.push(ctx);
    const ref = ctx.args[2] ?? '';
    const failed = failFor.has(ref);
    return { exitCode: failed ? 1 : 0, stdout: '', stderr: failed ? 'daemon error' : '', timedOut: false, outputTruncated: false };
  };
  return { exec, calls };
}

function buildApp(deps: AdminSandboxesRouteDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/sandboxes', createAdminSandboxesRouter({ now: () => NOW, ...deps }));
  return app;
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${String(port)}/api/v1/admin/sandboxes`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('#2320 admin sandboxes route', () => {
  it('answers 503 without a registry', async () => {
    await withServer(buildApp({}), async (base) => {
      const res = await fetch(base);
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as Record<string, unknown>)['code'], 'sandbox_admin.unavailable');
    });
  });

  it('lists sandboxes, most recently used first', async () => {
    const registry = new InMemorySandboxRegistry();
    await seed(registry);
    await withServer(buildApp({ registry }), async (base) => {
      const body = (await (await fetch(base)).json()) as { sandboxes: Array<Record<string, unknown>> };
      assert.deepEqual(
        body.sandboxes.map((s) => s['scope_key']),
        ['personal:fresh', 'personal:idle', 'personal:kept', 'personal:evil'],
      );
      assert.equal(body.sandboxes.find((s) => s['scope_key'] === 'personal:kept')?.['persistent'], true);
    });
  });

  it('dry run lists idle non-persistent sandboxes and touches nothing', async () => {
    const registry = new InMemorySandboxRegistry();
    await seed(registry);
    const docker = dockerStub();
    await withServer(buildApp({ registry, execDocker: docker.exec }), async (base) => {
      const res = await post(`${base}/reap`, { idleMinutes: 24 * 60, dryRun: true });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body['candidates'], ['personal:idle', 'personal:evil']);
    });
    assert.equal(docker.calls.length, 0);
    assert.equal((await registry.listAll()).length, 4);
  });

  it('a sweep removes idle containers, refuses a non-name ref, and is audited', async () => {
    const registry = new InMemorySandboxRegistry();
    await seed(registry);
    const docker = dockerStub();
    const audit: AuditEntryInput[] = [];
    const adminAudit = { record: async (e: AuditEntryInput) => void audit.push(e) };
    await withServer(buildApp({ registry, execDocker: docker.exec, adminAudit }), async (base) => {
      const res = await post(`${base}/reap`, { idleMinutes: 24 * 60 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body['reaped'], ['personal:idle']);
      assert.deepEqual(res.body['failed'], ['personal:evil']);
    });
    assert.deepEqual(docker.calls.map((c) => c.args), [['rm', '-f', 'omadia-sbx-idle']]);
    assert.equal(await registry.get('personal:idle'), undefined);
    assert.ok(await registry.get('personal:kept'), 'persistent sandboxes are never reaped');
    assert.deepEqual(audit.map((e) => e.action), ['sandbox.reap']);
  });

  it('400s an idle threshold outside the range', async () => {
    const registry = new InMemorySandboxRegistry();
    await withServer(buildApp({ registry }), async (base) => {
      for (const idleMinutes of [1, 1.5, '60', 999_999]) {
        const res = await post(`${base}/reap`, { idleMinutes });
        assert.equal(res.status, 400, `idleMinutes=${String(idleMinutes)}`);
      }
    });
  });

  it('tears down one sandbox; a failed docker rm keeps the row', async () => {
    const registry = new InMemorySandboxRegistry();
    await seed(registry);
    const docker = dockerStub(new Set(['omadia-sbx-fresh']));
    const audit: AuditEntryInput[] = [];
    const adminAudit = { record: async (e: AuditEntryInput) => void audit.push(e) };
    await withServer(buildApp({ registry, execDocker: docker.exec, adminAudit }), async (base) => {
      const ok = await post(`${base}/teardown`, { scopeKey: 'personal:kept' });
      assert.equal(ok.status, 200);
      const failed = await post(`${base}/teardown`, { scopeKey: 'personal:fresh' });
      assert.equal(failed.status, 502);
      const missing = await post(`${base}/teardown`, { scopeKey: 'personal:none' });
      assert.equal(missing.status, 404);
    });
    assert.equal(await registry.get('personal:kept'), undefined);
    assert.ok(await registry.get('personal:fresh'));
    assert.deepEqual(audit.map((e) => [e.action, e.target]), [['sandbox.teardown', 'sandbox:personal:kept']]);
  });
});
