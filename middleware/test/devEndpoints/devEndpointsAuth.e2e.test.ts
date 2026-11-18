/**
 * Issue #669 — `/api/dev/*` used to mount with NO authentication whenever
 * `DEV_ENDPOINTS_ENABLED=true`, and the KG-Lifecycle / priorities operator
 * pages were trapped inside that same flag. Confirmed empirically against a
 * real deployment: uncredentialed `GET`s returned `200` with live payloads,
 * and three `POST`s were anonymous triggers for destructive knowledge-graph
 * maintenance sweeps.
 *
 * This suite states both halves of the fix as assertions:
 *
 *   A. Every route under `/api/dev` answers `401` without a session — one
 *      case per route, including all three destructive POSTs.
 *   B. The operator surfaces answer `200` with a session and `DEV_ENDPOINTS_ENABLED`
 *      OFF, which is the whole point of moving them: the admin page works
 *      without publishing anything.
 *
 * The negative control (`withLegacyDevPublicPath`) restores the deleted
 * allowlist entry and asserts the surface goes open again — so a future
 * re-add cannot pass this suite. `test/devEndpoints/mutation-check.sh` runs
 * the same idea against the real source file.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import {
  DEV_GRAPH_PATH,
  KG_LIFECYCLE_ADMIN_PATH,
  KG_PRIORITIES_ADMIN_PATH,
  PLUGIN_DOMAINS_ADMIN_PATH,
} from '../../src/routes/graphRouterMounts.js';
import {
  DEV_MEMORY_PATH,
  isSandboxListenDenied,
  startDevEndpointsHarness,
  type DevEndpointsHarness,
  type DevEndpointsHarnessOptions,
} from './harness.js';

/**
 * Every route the issue lists as exposed, by the path it answers on today.
 * The three `run-*` entries are the sharp end: unauthenticated triggers for
 * destructive sweeps. They are exercised here as `POST` with no credentials,
 * which is exactly the request the issue deliberately did NOT send at the
 * real deployment.
 */
const DEV_ROUTES: ReadonlyArray<{ method: string; path: string; note: string }> = [
  { method: 'GET', path: `${DEV_GRAPH_PATH}/stats`, note: 'graph node/edge counts' },
  { method: 'GET', path: `${DEV_GRAPH_PATH}/sessions`, note: 'session list' },
  { method: 'GET', path: `${DEV_GRAPH_PATH}/topics`, note: 'topic list' },
  { method: 'GET', path: `${DEV_GRAPH_PATH}/issues`, note: 'issue list' },
  {
    method: 'GET',
    path: `${DEV_GRAPH_PATH}/neighbors?nodeId=x`,
    note: 'arbitrary node expansion',
  },
  // The `/api/dev/memory/*` surface is contributed by the memory plugin at
  // runtime, so nothing is mounted here — which is the point. The blanket
  // `/api` guard must answer 401 BEFORE express reaches its 404, or the
  // plugin's routes would be open the moment the plugin registers them.
  { method: 'GET', path: '/api/dev/memory/entries', note: 'plugin-contributed memory browser' },
];

/** The destructive triggers, kept in their own list so they read as such. */
const DESTRUCTIVE_LIFECYCLE_ROUTES: readonly string[] = [
  'run-decay',
  'run-gc',
  'run-access-flush',
];

describe('#669 — /api/dev is authenticated', () => {
  let h: DevEndpointsHarness;
  let skip = false;

  before(async () => {
    try {
      h = await startDevEndpointsHarness({ devEndpointsEnabled: true });
    } catch (err) {
      if (isSandboxListenDenied(err)) {
        skip = true;
        return;
      }
      throw err;
    }
  });

  after(async () => {
    if (!skip) await h.close();
  });

  for (const route of DEV_ROUTES) {
    it(`${route.method} ${route.path} → 401 without a session (${route.note})`, async (t) => {
      if (skip) return t.skip('sandbox denies loopback listeners');
      const res = await h.request(route.path, { method: route.method });
      assert.equal(
        res.status,
        401,
        `${route.path} answered ${String(res.status)} — an anonymous caller must never reach it`,
      );
    });
  }

  it('serves the dev graph to an authenticated operator', async (t) => {
    if (skip) return t.skip('sandbox denies loopback listeners');
    const res = await h.request(`${DEV_GRAPH_PATH}/stats`, { authenticated: true });
    assert.equal(res.status, 200);
  });

  it('does not mount the dev graph at all when DEV_ENDPOINTS_ENABLED is off', async (t) => {
    if (skip) return t.skip('sandbox denies loopback listeners');
    const off = await startDevEndpointsHarness({ devEndpointsEnabled: false });
    try {
      // Authenticated, so a 401 here would be the guard rather than the mount.
      const res = await off.request(`${DEV_GRAPH_PATH}/stats`, { authenticated: true });
      assert.equal(res.status, 404);
    } finally {
      await off.close();
    }
  });
});

describe('#669 — the destructive lifecycle sweeps are not anonymous triggers', () => {
  let h: DevEndpointsHarness;
  let skip = false;

  before(async () => {
    try {
      h = await startDevEndpointsHarness();
    } catch (err) {
      if (isSandboxListenDenied(err)) {
        skip = true;
        return;
      }
      throw err;
    }
  });

  after(async () => {
    if (!skip) await h.close();
  });

  for (const sweep of DESTRUCTIVE_LIFECYCLE_ROUTES) {
    it(`POST ${KG_LIFECYCLE_ADMIN_PATH}/${sweep} → 401 without a session`, async (t) => {
      if (skip) return t.skip('sandbox denies loopback listeners');
      const res = await h.request(`${KG_LIFECYCLE_ADMIN_PATH}/${sweep}`, {
        method: 'POST',
      });
      assert.equal(res.status, 401);
    });
  }

  /**
   * The status code alone can be produced by a route that ran and then failed.
   * This asserts the service was never touched — the sweep did not happen.
   */
  it('never reaches the lifecycle service on an unauthenticated POST', async (t) => {
    if (skip) return t.skip('sandbox denies loopback listeners');
    assert.ok(h.lifecycle, 'harness must publish a recording lifecycle service');
    h.lifecycle.calls.length = 0;
    for (const sweep of DESTRUCTIVE_LIFECYCLE_ROUTES) {
      await h.request(`${KG_LIFECYCLE_ADMIN_PATH}/${sweep}`, { method: 'POST' });
    }
    assert.deepEqual(
      h.lifecycle.calls,
      [],
      'a destructive sweep ran for a caller with no credentials',
    );
  });

  it('runs the sweep for an authenticated operator', async (t) => {
    if (skip) return t.skip('sandbox denies loopback listeners');
    assert.ok(h.lifecycle);
    h.lifecycle.calls.length = 0;
    const res = await h.request(`${KG_LIFECYCLE_ADMIN_PATH}/run-decay`, {
      method: 'POST',
      authenticated: true,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(h.lifecycle.calls, ['runDecayNow']);
  });
});

describe('#669 — the operator surfaces no longer need DEV_ENDPOINTS_ENABLED', () => {
  let h: DevEndpointsHarness;
  let skip = false;

  before(async () => {
    try {
      // The state an operator is actually in: the dev flag OFF, the KG plugin
      // installed and healthy. Before #669 this combination made the admin
      // page unreachable and blame the database.
      h = await startDevEndpointsHarness({ devEndpointsEnabled: false });
    } catch (err) {
      if (isSandboxListenDenied(err)) {
        skip = true;
        return;
      }
      throw err;
    }
  });

  after(async () => {
    if (!skip) await h.close();
  });

  const ADMIN_ROUTES: readonly string[] = [
    `${KG_LIFECYCLE_ADMIN_PATH}/stats`,
    `${KG_LIFECYCLE_ADMIN_PATH}/last-runs`,
    `${KG_PRIORITIES_ADMIN_PATH}/orchestrator-default`,
    PLUGIN_DOMAINS_ADMIN_PATH,
  ];

  for (const path of ADMIN_ROUTES) {
    it(`GET ${path} → 200 for an operator with the dev flag OFF`, async (t) => {
      if (skip) return t.skip('sandbox denies loopback listeners');
      const res = await h.request(path, { authenticated: true });
      assert.equal(
        res.status,
        200,
        `${path} answered ${String(res.status)} — the admin page must work without the dev flag`,
      );
    });

    it(`GET ${path} → 401 without a session`, async (t) => {
      if (skip) return t.skip('sandbox denies loopback listeners');
      const res = await h.request(path);
      assert.equal(res.status, 401);
    });
  }

  it('leaves the lifecycle routes unmounted when graphLifecycle@1 was never published', async (t) => {
    if (skip) return t.skip('sandbox denies loopback listeners');
    // The in-memory KG backend. This — not the dev flag — is what the admin
    // page's empty state describes after #669.
    const noKg = await startDevEndpointsHarness({
      devEndpointsEnabled: false,
      lifecycle: null,
    });
    try {
      const res = await noKg.request(`${KG_LIFECYCLE_ADMIN_PATH}/stats`, {
        authenticated: true,
      });
      assert.equal(res.status, 404);
    } finally {
      await noKg.close();
    }
  });
});

/**
 * The negative control. Restoring the pre-#669 allowlist entry must make the
 * surface anonymous again — otherwise the assertions above are passing for
 * some unrelated reason and the allowlist edit is not what closed the hole.
 */
describe('#669 — the removed publicPaths entry is what closes the hole', () => {
  it('goes open again when the legacy /api/dev allowlist entry is restored', async (t) => {
    let h: DevEndpointsHarness;
    try {
      h = await startDevEndpointsHarness({ withLegacyDevPublicPath: true });
    } catch (err) {
      if (isSandboxListenDenied(err)) return t.skip('sandbox denies loopback listeners');
      throw err;
    }
    try {
      const res = await h.request(`${DEV_GRAPH_PATH}/stats`);
      assert.equal(
        res.status,
        200,
        'restoring the entry must reopen the surface — if it does not, these tests prove nothing',
      );
    } finally {
      await h.close();
    }
  });

  it('does not reopen the moved admin surfaces (they are outside /api/dev)', async (t) => {
    let h: DevEndpointsHarness;
    try {
      h = await startDevEndpointsHarness({ withLegacyDevPublicPath: true });
    } catch (err) {
      if (isSandboxListenDenied(err)) return t.skip('sandbox denies loopback listeners');
      throw err;
    }
    try {
      const res = await h.request(`${KG_LIFECYCLE_ADMIN_PATH}/stats`);
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });
});

describe('#669 — DEV_ENDPOINTS_LOOPBACK_ONLY', () => {
  it('serves an authenticated operator over loopback when enabled', async (t) => {
    let h: DevEndpointsHarness;
    try {
      h = await startDevEndpointsHarness({ loopbackOnly: true });
    } catch (err) {
      if (isSandboxListenDenied(err)) return t.skip('sandbox denies loopback listeners');
      throw err;
    }
    try {
      // The harness listens on 127.0.0.1, so the request IS loopback.
      const res = await h.request(`${DEV_GRAPH_PATH}/stats`, { authenticated: true });
      assert.equal(res.status, 200);
    } finally {
      await h.close();
    }
  });
});

/**
 * Issue #1350 — the guard covered `/api/dev/graph` only, so the memory browser
 * (a plugin route under `/api/dev/memory`) served the whole `/memories` tree to
 * a non-loopback session while the boot log said "loopback-only".
 */
describe('#1350 — DEV_ENDPOINTS_LOOPBACK_ONLY covers every /api/dev route', () => {
  /** A Docker bridge peer — what the middleware container sees from the host. */
  const BRIDGE_PEER = '172.18.0.1';

  async function withHarness(
    t: { skip: (msg: string) => void },
    opts: DevEndpointsHarnessOptions,
    body: (h: DevEndpointsHarness) => Promise<void>,
  ): Promise<void> {
    let h: DevEndpointsHarness;
    try {
      h = await startDevEndpointsHarness({ withDevMemoryPluginRoute: true, ...opts });
    } catch (err) {
      if (isSandboxListenDenied(err)) {
        t.skip('sandbox denies loopback listeners');
        return;
      }
      throw err;
    }
    try {
      await body(h);
    } finally {
      await h.close();
    }
  }

  const GUARDED_PATHS = [
    `${DEV_GRAPH_PATH}/stats`,
    `${DEV_MEMORY_PATH}/list?path=/memories`,
    `${DEV_MEMORY_PATH}/file?path=/memories/chat-sessions/s1.json`,
  ];

  for (const path of GUARDED_PATHS) {
    it(`refuses a non-loopback session on ${path} with 403`, async (t) => {
      await withHarness(t, { loopbackOnly: true, remoteAddress: BRIDGE_PEER }, async (h) => {
        const res = await h.request(path, { authenticated: true });
        assert.equal(res.status, 403);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, 'dev.loopback_only');
      });
    });
  }

  it('serves the memory browser to a loopback session when enabled', async (t) => {
    await withHarness(t, { loopbackOnly: true }, async (h) => {
      const res = await h.request(`${DEV_MEMORY_PATH}/list?path=/memories`, {
        authenticated: true,
      });
      assert.equal(res.status, 200);
    });
  });

  it('serves the memory browser to a non-loopback session when the flag is off', async (t) => {
    await withHarness(t, { loopbackOnly: false, remoteAddress: BRIDGE_PEER }, async (h) => {
      const res = await h.request(`${DEV_MEMORY_PATH}/list?path=/memories`, {
        authenticated: true,
      });
      assert.equal(res.status, 200);
    });
  });

  it('still answers 401 before 403 for a non-loopback request without a session', async (t) => {
    await withHarness(t, { loopbackOnly: true, remoteAddress: BRIDGE_PEER }, async (h) => {
      const res = await h.request(`${DEV_MEMORY_PATH}/list?path=/memories`);
      assert.equal(res.status, 401);
    });
  });
});
