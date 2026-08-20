import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import { Router } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRequireAuth } from '../src/auth/requireAuth.js';
import { EmailWhitelist } from '../src/auth/whitelist.js';
import { publicPaths } from '../src/auth/publicPaths.js';
import type { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';
import {
  PublicPathClaimError,
  PublicPathGrantRegistry,
  validateDeclaredPublicPath,
} from '../src/platform/publicPathGrants.js';
import { createPublicPathMount } from '../src/platform/publicPathMount.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import type { PublicPathGrantStore } from '../src/platform/publicPathGrantStore.js';

/**
 * Epic #470 C4 / H1 — manifest-declared, operator-consented public paths.
 *
 * The tests below build the PRODUCTION mount order, not a bare `express()`.
 * That is the whole point: this epic's own runner router once passed an e2e
 * test against a bare app while 401'ing in production behind the blanket
 * `/api` gate (recorded in `auth/publicPaths.ts`). A test for an
 * authentication bypass that does not include the authentication is not a test.
 */

const SIGNING_KEY = new Uint8Array(32).fill(7);

interface Harness {
  server: Server;
  baseUrl: string;
  routes: PluginRouteRegistry;
  grants: PublicPathGrantRegistry;
}

/**
 * Production topology, in order:
 *   express.json → cookieParser → [public-path mount] → requireAuth → routers
 */
async function buildApp(opts: {
  routes: PluginRouteRegistry;
  grants: PublicPathGrantRegistry;
  terminate?: boolean;
}): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const mountOpts: Parameters<typeof createPublicPathMount>[0] = {
    grants: opts.grants,
    routes: opts.routes,
    ...(opts.terminate === undefined ? {} : { terminate: opts.terminate }),
    logger: () => undefined,
  };
  app.use(createPublicPathMount(mountOpts));

  const requireAuth = createRequireAuth({
    signingKey: SIGNING_KEY,
    whitelist: new EmailWhitelist('operator@example.com'),
    publicPaths: publicPaths(),
  });
  // The blanket OB-106 gate. Everything under /api that is not a static core
  // public path and was not answered by the mount above lands here.
  app.use('/api', requireAuth, (_req, res) => {
    res.status(200).json({ reached: 'authenticated-stack' });
  });

  // Plugin routers mount LAST in production (boot flush). Kept here so the
  // fallthrough counter-proof can show what the terminating mount prevents.
  opts.routes.mountAll(app);

  const server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    routes: opts.routes,
    grants: opts.grants,
  };
}

/** A plugin router that answers exactly one path under its prefix. */
function pluginRouter(): Router {
  const r = Router();
  r.get('/ping', (_req, res) => {
    res.status(200).json({ ok: true, from: 'plugin' });
  });
  return r;
}

const PREFIX = '/api/plugins/acme';
const CTX = {
  corePublicPaths: publicPaths(),
  ownRoutePrefixes: [PREFIX],
};

describe('#470 C4/H1 — public-path declaration validation', () => {
  it('accepts a well-formed prefix under the reserved plugin root', () => {
    const result = validateDeclaredPublicPath(PREFIX, CTX);
    assert.equal(result.ok, true);
  });

  it('rejects a path containing ".." traversal', () => {
    const result = validateDeclaredPublicPath('/api/plugins/../v1/admin', CTX);
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && /segments|unreserved/.test(result.reason),
      `unexpected reason: ${!result.ok ? result.reason : ''}`,
    );
  });

  it('rejects percent-encoded traversal — the raw path has no second form', () => {
    const result = validateDeclaredPublicPath('/api/plugins/%2e%2e/admin', CTX);
    assert.equal(result.ok, false);
  });

  it('rejects a wildcard, which would widen the grant beyond the prefix', () => {
    assert.equal(validateDeclaredPublicPath('/api/plugins/*', CTX).ok, false);
  });

  it('rejects a core-reserved root even though the operator could consent', () => {
    const result = validateDeclaredPublicPath('/api/v1/admin/settings', CTX);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes('core-reserved'));
  });

  it('rejects a prefix that is already a static core public path', () => {
    // `/p/<pluginId>` is a live entry in STATIC_PUBLIC_PATHS. Two mechanisms
    // claiming the same URL is exactly the ambiguity this rejects.
    const result = validateDeclaredPublicPath('/p/acme/dash', CTX);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes('static core public path'));
  });

  it('rejects a prefix outside both the reserved root and the plugin routes', () => {
    const result = validateDeclaredPublicPath('/api/v1/something-else', CTX);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes('/api/plugins/'));
  });

  it('accepts a prefix the plugin actually registers a router at', () => {
    // The rule that lets a plugin keep serving a historical wire path once
    // core stops exempting it statically — without core naming that path.
    const result = validateDeclaredPublicPath('/legacy/hook/inbound', {
      corePublicPaths: publicPaths(),
      ownRoutePrefixes: ['/legacy/hook'],
    });
    assert.equal(result.ok, true);
  });

  it('rejects a one-segment claim as too broad', () => {
    assert.equal(validateDeclaredPublicPath('/api', CTX).ok, false);
  });
});

describe('#470 C4/H1 — exclusive prefix ownership', () => {
  let grants: PublicPathGrantRegistry;
  beforeEach(() => {
    grants = new PublicPathGrantRegistry();
  });

  it('lets the first plugin claim a prefix', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    assert.equal(grants.list().length, 1);
  });

  it('fails the SECOND plugin declaring the same prefix, naming the owner', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    let caught: unknown;
    try {
      grants.claim('evilcorp', [PREFIX], {
        ...CTX,
        grantedPrefixes: new Set(),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof PublicPathClaimError,
      'second claim must throw PublicPathClaimError',
    );
    assert.equal(caught.conflictsWith, 'acme');
    assert.equal(caught.pluginId, 'evilcorp');
    // The message must name BOTH sides — an operator reading a boot log needs
    // to know who lost and who already held it.
    assert.ok(caught.message.includes('acme'));
    assert.ok(caught.message.includes('evilcorp'));
    // First-come wins: the incumbent still owns it.
    assert.deepEqual(
      grants.list().map((c) => c.pluginId),
      ['acme'],
    );
  });

  it('fails a plugin claiming a prefix NESTED under another plugin', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    assert.throws(
      () =>
        grants.claim('evilcorp', [`${PREFIX}/sub`], {
          corePublicPaths: publicPaths(),
          ownRoutePrefixes: [`${PREFIX}/sub`],
          grantedPrefixes: new Set(),
        }),
      PublicPathClaimError,
    );
  });

  it('rolls back partial claims when a later entry in the same call fails', () => {
    assert.throws(
      () =>
        grants.claim('acme', [PREFIX, '/api/v1/admin/oops'], {
          ...CTX,
          grantedPrefixes: new Set(),
        }),
      PublicPathClaimError,
    );
    // The valid first entry must NOT be left squatting.
    assert.equal(grants.list().length, 0);
  });

  it('is idempotent for the same plugin re-activating', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    assert.equal(grants.list().length, 1);
  });

  it('frees the prefix for another plugin once released', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    assert.equal(grants.releaseBySource('acme'), 1);
    grants.claim('other', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    assert.deepEqual(
      grants.list().map((c) => c.pluginId),
      ['other'],
    );
  });

  it('resolves ONLY granted prefixes — a claim alone is not consent', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    assert.equal(grants.resolve(`${PREFIX}/ping`), null);
    grants.setGranted('acme', new Set([PREFIX]));
    assert.deepEqual(grants.resolve(`${PREFIX}/ping`), {
      pluginId: 'acme',
      prefix: PREFIX,
    });
  });

  it('will not let consent invent ownership of an undeclared prefix', () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    grants.setGranted('acme', new Set(['/api/plugins/never-declared']));
    assert.equal(grants.resolve('/api/plugins/never-declared/x'), null);
  });

  it('does not match a sibling prefix that merely shares a string prefix', () => {
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    // `/api/plugins/acme-evil` starts with `/api/plugins/acme` as a STRING but
    // is a different path segment.
    assert.equal(grants.resolve('/api/plugins/acme-evil/ping'), null);
  });
});

describe('#470 C4/H1 — terminating early mount (production order)', () => {
  let routes: PluginRouteRegistry;
  let grants: PublicPathGrantRegistry;
  let dispose: () => void;

  beforeEach(() => {
    routes = newTestRouteRegistry();
    grants = new PublicPathGrantRegistry();
    dispose = routes.register(PREFIX, pluginRouter(), 'acme');
  });

  it('GRANTED: an unauthenticated GET reaches the plugin handler', async () => {
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    const h = await buildApp({ routes, grants });
    try {
      const res = await fetch(`${h.baseUrl}${PREFIX}/ping`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, from: 'plugin' });
    } finally {
      h.server.close();
    }
  });

  it('DECLARED BUT NOT GRANTED: requireAuth 401s — consent is load-bearing', async () => {
    grants.claim('acme', [PREFIX], { ...CTX, grantedPrefixes: new Set() });
    const h = await buildApp({ routes, grants });
    try {
      const res = await fetch(`${h.baseUrl}${PREFIX}/ping`);
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it('NOT DECLARED AT ALL: requireAuth 401s (fail-closed baseline)', async () => {
    const h = await buildApp({ routes, grants });
    try {
      const res = await fetch(`${h.baseUrl}${PREFIX}/ping`);
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it('TERMINATION: an unhandled path under a granted prefix is 404, NOT fallthrough', async () => {
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    const h = await buildApp({ routes, grants });
    try {
      const res = await fetch(`${h.baseUrl}${PREFIX}/not-a-route`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'public_path.not_found');
    } finally {
      h.server.close();
    }
  });

  it('AFTER DEACTIVATE: the granted prefix 404s instead of serving', async () => {
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    const h = await buildApp({ routes, grants });
    try {
      assert.equal((await fetch(`${h.baseUrl}${PREFIX}/ping`)).status, 200);
      dispose();
      const res = await fetch(`${h.baseUrl}${PREFIX}/ping`);
      assert.equal(res.status, 404);
    } finally {
      h.server.close();
    }
  });

  it('AFTER disposeBySource: same, via the kernel deactivate fail-safe', async () => {
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    const h = await buildApp({ routes, grants });
    try {
      assert.equal(routes.disposeBySource('acme'), 1);
      assert.equal((await fetch(`${h.baseUrl}${PREFIX}/ping`)).status, 404);
    } finally {
      h.server.close();
    }
  });

  it('POST to a granted GET-only route terminates 404 rather than falling through', async () => {
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    const h = await buildApp({ routes, grants });
    try {
      const res = await fetch(`${h.baseUrl}${PREFIX}/ping`, { method: 'POST' });
      assert.equal(res.status, 404);
    } finally {
      h.server.close();
    }
  });

  it('a static core public path still works — the mount does not shadow it', async () => {
    const h = await buildApp({ routes, grants });
    try {
      // `/api/v1/auth/...` is a STATIC_PUBLIC_PATHS entry: it must pass
      // requireAuth and reach the authenticated-stack sentinel unauthenticated.
      const res = await fetch(`${h.baseUrl}/api/v1/auth/login-providers`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { reached: 'authenticated-stack' });
    } finally {
      h.server.close();
    }
  });
});

describe('#470 C4/H1 — COUNTER-PROOF: termination is load-bearing', () => {
  /**
   * Same fixture as the TERMINATION test above, with `terminate: false`.
   *
   * If termination were decorative, this would still 404 and the assertion
   * below would fail. It does not: the request falls out of the mount, meets
   * `requireAuth`, and — because it is under `/api` with no session — 401s.
   * On a deployment where the plugin's granted prefix happened to sit under a
   * core static exemption, or where any later router matched, that same
   * fallthrough would have been served with NO authentication at all.
   *
   * This is the difference between "the plugin owns this prefix" and "this URL
   * skips auth", and it is why `auth/publicPaths.ts` stays a frozen literal.
   */
  it('with termination OFF the unhandled path escapes the mount', async () => {
    const routes = newTestRouteRegistry();
    const grants = new PublicPathGrantRegistry();
    routes.register(PREFIX, pluginRouter(), 'acme');
    grants.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });

    const withTermination = await buildApp({ routes, grants });
    let terminated: number;
    try {
      terminated = (await fetch(`${withTermination.baseUrl}${PREFIX}/nope`))
        .status;
    } finally {
      withTermination.server.close();
    }

    const routes2 = newTestRouteRegistry();
    const grants2 = new PublicPathGrantRegistry();
    routes2.register(PREFIX, pluginRouter(), 'acme');
    grants2.claim('acme', [PREFIX], {
      ...CTX,
      grantedPrefixes: new Set([PREFIX]),
    });
    const without = await buildApp({
      routes: routes2,
      grants: grants2,
      terminate: false,
    });
    let fellThrough: number;
    try {
      fellThrough = (await fetch(`${without.baseUrl}${PREFIX}/nope`)).status;
    } finally {
      without.server.close();
    }

    assert.equal(terminated, 404, 'termination ON must answer 404');
    assert.notEqual(
      fellThrough,
      404,
      'termination OFF must NOT 404 — otherwise this test proves nothing',
    );
    assert.equal(
      fellThrough,
      401,
      'termination OFF lets the request escape into the authenticated stack',
    );
  });
});


// ── Consent writes: the registry is the authority, not the table ───────────
//
// `PUT /installed/:id/public-paths` writes rows AND updates the in-memory
// `PublicPathGrantRegistry`. Only the registry is consulted per request, so a
// half-applied update that leaves the registry more permissive than the table
// is a prefix still answering without a session. These tests drive the real
// endpoint and then probe the real public surface, sharing ONE registry
// instance between the two mounts exactly as the process does.

const ACME = 'de.byte5.agent.acme';
const P_ONE = '/api/plugins/acme/one';
const P_TWO = '/api/plugins/acme/two';

interface StoreState {
  rows: Set<string>;
  /** Reject `grant()` for this path, simulating a write that dies partway. */
  failGrantFor?: string;
  /** Reject `listForPlugin()` from this call number on (1-based), so the
   *  error-path re-read can be failed without failing the first read. */
  failListFromCall?: number;
  listCalls: number;
}

function stubStore(state: StoreState): PublicPathGrantStore {
  return {
    listForPlugin: () => {
      state.listCalls += 1;
      if (
        state.failListFromCall !== undefined &&
        state.listCalls >= state.failListFromCall
      ) {
        return Promise.reject(new Error('grant table unreadable'));
      }
      return Promise.resolve(new Set(state.rows));
    },
    listAll: () => Promise.resolve([]),
    grant: (_id: string, path: string) => {
      if (state.failGrantFor === path) {
        return Promise.reject(new Error(`grant write failed for ${path}`));
      }
      state.rows.add(path);
      return Promise.resolve();
    },
    revoke: (_id: string, path: string) =>
      Promise.resolve(state.rows.delete(path)),
    revokeAllForPlugin: () => Promise.resolve(0),
  };
}

interface ConsentHarness {
  publicUrl: string;
  consentUrl: string;
  close(): void;
}

async function makeConsentHarness(opts: {
  granted: readonly string[];
  store: PublicPathGrantStore;
}): Promise<ConsentHarness> {
  const routes = newTestRouteRegistry();
  routes.register(P_ONE, pluginRouter(), ACME);
  routes.register(P_TWO, pluginRouter(), ACME);

  const grants = new PublicPathGrantRegistry();
  grants.claim(ACME, [P_ONE, P_TWO], {
    corePublicPaths: publicPaths(),
    ownRoutePrefixes: [P_ONE, P_TWO],
    grantedPrefixes: new Set(opts.granted),
  });

  const pub = await buildApp({ routes, grants });

  const installed = new InMemoryInstalledRegistry();
  await installed.register({
    id: ACME,
    installed_version: '0.1.0',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {},
  });
  const entry = {
    plugin: {
      id: ACME,
      name: 'Acme',
      version: '0.1.0',
      permissions_summary: { public_paths: [P_ONE, P_TWO] },
    },
    manifest: {},
    source_path: '<test>',
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined =>
      id === ACME ? entry : undefined,
  } as unknown as PluginCatalog;
  const stub = { names: () => [], counts: () => ({}) };

  const consentApp = express();
  consentApp.use(express.json());
  consentApp.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: installed,
      serviceRegistry: stub as never,
      turnHookRegistry: stub as never,
      backgroundJobRegistry: stub as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      catalog,
      publicPathGrantStore: opts.store,
      // THE SAME registry the public mount above reads.
      publicPathGrants: grants,
    }),
  );
  const consentServer = await listenLoopback(consentApp);
  const { port } = consentServer.address() as AddressInfo;

  return {
    publicUrl: pub.baseUrl,
    consentUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/runtime/installed/${ACME}/public-paths`,
    close: () => {
      pub.server.close();
      consentServer.close();
    },
  };
}

function putPaths(url: string, paths: readonly string[]): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
}

describe('#470 C4/H1 — consent writes close the live surface', () => {
  it('closes a revoked prefix even when a later grant write fails', async () => {
    // Both consented. The operator drops P_ONE and keeps P_TWO — and the
    // re-grant of P_TWO dies after P_ONE's row is already gone.
    const state: StoreState = {
      rows: new Set([P_ONE, P_TWO]),
      failGrantFor: P_TWO,
      listCalls: 0,
    };
    const h = await makeConsentHarness({
      granted: [P_ONE, P_TWO],
      store: stubStore(state),
    });
    try {
      const before = await fetch(`${h.publicUrl}${P_ONE}/ping`);
      assert.equal(before.status, 200, 'precondition: P_ONE served publicly');

      const res = await putPaths(h.consentUrl, [P_TWO]);
      assert.equal(res.status, 500, 'the failed write must surface as a 500');

      // The whole point. Before the fix the registry still carried
      // granted=true for P_ONE, so this answered 200 from the plugin with no
      // session — a revoked prefix serving unauthenticated until restart.
      const after = await fetch(`${h.publicUrl}${P_ONE}/ping`);
      assert.equal(
        after.status,
        401,
        'a revoked prefix must stop serving even when the update failed',
      );
    } finally {
      h.close();
    }
  });

  it('applies a successful consent update to the live surface', async () => {
    const state: StoreState = {
      rows: new Set([P_ONE, P_TWO]),
      listCalls: 0,
    };
    const h = await makeConsentHarness({
      granted: [P_ONE, P_TWO],
      store: stubStore(state),
    });
    try {
      const res = await putPaths(h.consentUrl, [P_TWO]);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()) as unknown, {
        id: ACME,
        paths: [P_TWO],
      });

      assert.equal(
        (await fetch(`${h.publicUrl}${P_ONE}/ping`)).status,
        401,
        'the revoked prefix is closed',
      );
      assert.equal(
        (await fetch(`${h.publicUrl}${P_TWO}/ping`)).status,
        200,
        'the still-consented prefix keeps serving',
      );
      assert.deepEqual([...state.rows], [P_TWO], 'the table agrees');
    } finally {
      h.close();
    }
  });

  it('grants nothing when the error-path re-read also fails', async () => {
    // The write fails AND the registry cannot be re-synced from the table.
    // With no trustworthy answer available the only safe state is "nothing is
    // public" — never "keep whatever was there".
    const state: StoreState = {
      rows: new Set([P_ONE, P_TWO]),
      failGrantFor: P_TWO,
      failListFromCall: 2,
      listCalls: 0,
    };
    const h = await makeConsentHarness({
      granted: [P_ONE, P_TWO],
      store: stubStore(state),
    });
    try {
      const res = await putPaths(h.consentUrl, [P_TWO]);
      assert.equal(res.status, 500);

      assert.equal(
        (await fetch(`${h.publicUrl}${P_ONE}/ping`)).status,
        401,
        'revoked prefix closed',
      );
      assert.equal(
        (await fetch(`${h.publicUrl}${P_TWO}/ping`)).status,
        401,
        'unreadable consent must close every prefix, not preserve the old set',
      );
    } finally {
      h.close();
    }
  });
});
