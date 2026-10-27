/**
 * Issue #1453 — the runtime API has to be able to say "this integration's
 * credentials are refused".
 *
 * Two seams, both reproduction steps from the issue:
 *   GET  /installed                → carries the pushed `action_status`, so an
 *                                    operator polling the API sees the problem
 *                                    without sending a chat message first.
 *   POST /installed/:id/verify     → re-runs the plugin's own credential check
 *                                    in place, so a key fixed upstream clears
 *                                    the badge without a reactivation.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PluginStatusRegistry } from '../src/platform/pluginStatusRegistry.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { ConnectionProbeOutcome } from '../src/plugins/connectionProbe.js';
import { createRuntimeRouter } from '../src/routes/runtime.js';

const PLUGIN_ID = '@omadia/integration-odoo';

interface Harness {
  readonly baseUrl: string;
  readonly statusRegistry: PluginStatusRegistry;
  readonly verifyCalls: string[];
  close(): Promise<void>;
}

async function makeHarness(
  opts: {
    readonly verify?: (id: string) => Promise<ConnectionProbeOutcome | undefined>;
    readonly status?: 'active' | 'errored';
  } = {},
): Promise<Harness> {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: PLUGIN_ID,
    installed_version: '0.2.1',
    installed_at: '2026-10-22T08:03:00.000Z',
    status: opts.status ?? 'active',
    config: {},
  });

  const statusRegistry = new PluginStatusRegistry();
  const verifyCalls: string[] = [];
  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      serviceRegistry: stubReg as never,
      turnHookRegistry: stubReg as never,
      backgroundJobRegistry: stubReg as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      pluginStatusRegistry: statusRegistry,
      verifyConnection: async (
        id: string,
      ): Promise<ConnectionProbeOutcome | undefined> => {
        verifyCalls.push(id);
        return opts.verify ? opts.verify(id) : { status: 'connected' };
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    statusRegistry,
    verifyCalls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('GET /installed — reported action status (#1453)', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('carries a reported error next to the registry status', async () => {
    h = await makeHarness();
    h.statusRegistry.set(PLUGIN_ID, {
      state: 'error',
      title: 'Nicht verbunden',
      checked_at: '2026-10-22T08:33:00.000Z',
    });

    const res = await fetch(`${h.baseUrl}/api/v1/admin/runtime/installed`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        status: string;
        last_activation_error: string | null;
        action_status: { state: string; title?: string; checked_at?: string } | null;
      }>;
    };
    const row = body.items.find((i) => i.id === PLUGIN_ID);
    assert.ok(row);
    // Unchanged: the plugin DID activate, so the registry still says active.
    assert.equal(row.status, 'active');
    assert.equal(row.last_activation_error, null);
    // New: and the API no longer stops there.
    assert.equal(row.action_status?.state, 'error');
    assert.equal(row.action_status?.title, 'Nicht verbunden');
    assert.equal(row.action_status?.checked_at, '2026-10-22T08:33:00.000Z');
  });

  it('reports null for a plugin that pushed no status', async () => {
    h = await makeHarness();

    const res = await fetch(`${h.baseUrl}/api/v1/admin/runtime/installed`);
    const body = (await res.json()) as {
      items: Array<{ id: string; action_status: unknown }>;
    };
    assert.equal(body.items.find((i) => i.id === PLUGIN_ID)?.action_status, null);
  });
});

describe('POST /installed/:id/verify (#1453)', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  async function post(baseUrl: string, id = PLUGIN_ID): Promise<Response> {
    return fetch(
      `${baseUrl}/api/v1/admin/runtime/installed/${encodeURIComponent(id)}/verify`,
      { method: 'POST' },
    );
  }

  it('re-runs the plugin probe and answers its verdict', async () => {
    h = await makeHarness({
      verify: async () => ({
        status: 'rejected',
        cause: 'protocol_auth_failure',
        title: 'Nicht verbunden',
        detail: 'Odoo hat den API-Key abgelehnt',
      }),
    });

    const res = await post(h.baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      title?: string;
      detail?: string;
    };
    assert.equal(body.status, 'rejected');
    assert.equal(body.title, 'Nicht verbunden');
    assert.equal(body.detail, 'Odoo hat den API-Key abgelehnt');
    assert.deepEqual(h.verifyCalls, [PLUGIN_ID]);
  });

  it('says a probe was inconclusive rather than calling it healthy', async () => {
    h = await makeHarness({
      verify: async () => ({ status: 'inconclusive', reason: 'timed_out' }),
    });

    const res = await post(h.baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; reason?: string };
    assert.equal(body.status, 'inconclusive');
    assert.equal(body.reason, 'timed_out');
  });

  it('reports `no_probe` for a plugin that declares no credential check', async () => {
    h = await makeHarness({ verify: async () => undefined });

    const res = await post(h.baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; reason?: string };
    assert.equal(body.status, 'inconclusive');
    assert.equal(
      body.reason,
      'no_probe',
      'never claim "connected" for a check that does not exist',
    );
  });

  it('404s an unknown plugin and 409s one that is not running', async () => {
    h = await makeHarness();
    const unknown = await post(h.baseUrl, '@omadia/not-installed');
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, 'runtime.not_installed');
    await h.close();

    h = await makeHarness({ status: 'errored' });
    const inactive = await post(h.baseUrl);
    assert.equal(inactive.status, 409);
    assert.equal(((await inactive.json()) as { code: string }).code, 'runtime.not_active');
    assert.deepEqual(h.verifyCalls, [], 'a plugin that never came up has nothing to probe');
  });
});
