import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import express, { Router } from 'express';
import type { RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRequireAuth, SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { PluginRouteRegistry } from '../../src/platform/pluginRouteRegistry.js';
import { createPluginRawBodyMount } from '../../src/platform/pluginRawBodyMount.js';
import { PublicPathGrantRegistry } from '../../src/platform/publicPathGrants.js';
import { createPublicPathMount } from '../../src/platform/publicPathMount.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * Epic #470 C6 — `auth:` composed inside the disposed guard (G2) and a
 * route-local raw body ahead of the global JSON parser (G3).
 *
 * Like the C4 suite these tests build the PRODUCTION mount order, not a bare
 * `express()`. C4's comment says why and it applies verbatim here: this epic's
 * own runner router once passed an e2e test against a bare app while 401'ing
 * in production behind the blanket `/api` gate. A raw-body test that omits the
 * global `express.json` is the same class of non-test — the global parser IS
 * the thing that breaks raw bodies, so a suite without it proves nothing.
 */

const SIGNING_KEY = new Uint8Array(32).fill(11);
const OPERATOR = 'operator@example.com';
const WEBHOOK_SECRET = 'shhh-hmac-secret';

/** Prefixes. `/api/plugins/<id>/…` is the reserved plugin root C4 defines. */
const ADMIN_PREFIX = '/api/plugins/acme/admin';
const HOOK_PREFIX = '/api/plugins/acme/hooks';
const API_PUBLIC_PREFIX = '/api/plugins/acme/public';
const DIAGRAM_PUBLIC_PREFIX = '/diagrams/acme-pub';
const DIAGRAM_CUSTOM_PREFIX = '/diagrams/acme-hook';
const DIAGRAM_SESSION_PREFIX = '/diagrams/acme-session';

interface Harness {
  server: Server;
  baseUrl: string;
}

/**
 * The production topology, in order — every element of it load-bearing here:
 *
 *   [plugin raw-body mount] → express.json → cookieParser
 *     → [public-path mount] → requireAuth → plugin routers (boot flush)
 *
 * `swapGuardAndAuth` exists ONLY for the counter-proof in the last describe
 * block: it re-creates the pre-C6 composition (auth mounted OUTSIDE the
 * disposed guard) so the pinned-order assertion can be shown to fail.
 */
async function buildApp(opts: {
  routes: PluginRouteRegistry;
  grants: PublicPathGrantRegistry;
  sessionAuth: RequestHandler;
}): Promise<Harness> {
  const app = express();

  // C6/G3 — BEFORE the global JSON parser. This is the whole mechanism.
  app.use(createPluginRawBodyMount({ routes: opts.routes, logger: () => undefined }));

  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.use(
    createPublicPathMount({
      grants: opts.grants,
      routes: opts.routes,
      logger: () => undefined,
    }),
  );

  // The blanket OB-106 gate: it AUTHENTICATES `/api/*` and then lets routing
  // continue, which is what production does — `createChatRouter` behind it only
  // answers its own paths. Mounting a catch-all responder here instead would
  // swallow every plugin path before the boot flush below ever ran.
  app.use('/api', opts.sessionAuth);

  // Plugin routers mount LAST in production (boot flush).
  opts.routes.mountAll(app);

  // Whatever survived everything above. Stands in for "some other core router
  // answered", so a fallthrough is visible rather than a bare 404.
  app.use('/api', (_req, res) => {
    res.status(200).json({ reached: 'authenticated-stack' });
  });

  const server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(port)}` };
}

function kernelRequireAuth(): RequestHandler {
  return createRequireAuth({
    signingKey: SIGNING_KEY,
    whitelist: new EmailWhitelist(OPERATOR),
    publicPaths: publicPaths(),
  }) as unknown as RequestHandler;
}

function newRegistry(sessionAuth: RequestHandler): PluginRouteRegistry {
  return new PluginRouteRegistry({ sessionAuth: () => sessionAuth });
}

async function operatorCookie(): Promise<string> {
  const token = await signSession(
    {
      sub: 'op-1',
      email: OPERATOR,
      display_name: 'Op',
      provider: 'local',
      role: 'admin',
    },
    SIGNING_KEY,
  );
  return `${SESSION_COOKIE}=${token}`;
}

/** The webhook receiver a real plugin would write: HMAC over `req.rawBody`,
 *  compared with `timingSafeEqual`. Nothing here re-serialises `req.body`. */
function webhookRouter(seen: { body?: unknown }): Router {
  const r = Router();
  r.post('/webhook', (req, res) => {
    seen.body = req.body;
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw)) {
      res.status(500).json({ code: 'no_raw_body' });
      return;
    }
    const header = req.get('X-Hub-Signature-256') ?? '';
    const expected = Buffer.from(
      `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`,
    );
    const given = Buffer.from(header);
    const ok =
      given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      res.status(401).json({ code: 'bad_signature' });
      return;
    }
    res.status(200).json({ ok: true, bytes: raw.length });
  });
  return r;
}

/** A `body: 'json'` sibling under the same plugin — proves the raw slot is
 *  scoped to the prefix that asked for it and does not poison its neighbours. */
function jsonRouter(): Router {
  const r = Router();
  r.post('/echo', (req, res) => {
    res.status(200).json({ parsed: req.body, rawBodyPresent: req.rawBody !== undefined });
  });
  r.get('/ping', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return r;
}

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body)).digest('hex')}`;
}

const CLAIM_CTX = {
  corePublicPaths: publicPaths(),
  ownRoutePrefixes: [ADMIN_PREFIX, HOOK_PREFIX],
};

function claimCtx(...ownRoutePrefixes: string[]) {
  return {
    corePublicPaths: publicPaths(),
    ownRoutePrefixes,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The exit condition: webhook HMAC works through the generic path.
// ───────────────────────────────────────────────────────────────────────────

describe("#470 C6 — auth:'custom' + body:'raw' webhook through the generic path", () => {
  async function setup(): Promise<{
    h: Harness;
    routes: PluginRouteRegistry;
    dispose: () => void;
    seen: { body?: unknown };
  }> {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    const seen: { body?: unknown } = {};
    const dispose = routes.register(HOOK_PREFIX, webhookRouter(seen), 'acme', {
      auth: 'custom',
      body: 'raw',
    });
    routes.register(ADMIN_PREFIX, jsonRouter(), 'acme');
    grants.claim('acme', [HOOK_PREFIX], {
      ...CLAIM_CTX,
      grantedPrefixes: new Set([HOOK_PREFIX]),
    });
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    return { h, routes, dispose, seen };
  }

  it('valid signature over the RAW bytes → 200', async () => {
    const { h, seen } = await setup();
    try {
      // Deliberately non-canonical JSON: whitespace and key order that a
      // parse→re-serialise round-trip would destroy. If the handler ever sees
      // anything but these exact bytes, the HMAC cannot match.
      const body = '{"zeta":1,   "alpha":"ä ö ü", "n":[1,2,3]}';
      const res = await fetch(`${h.baseUrl}${HOOK_PREFIX}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(body),
        },
        body,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true,
        bytes: Buffer.byteLength(body),
      });
      // The global express.json never got to replace the Buffer with an object.
      assert.ok(
        Buffer.isBuffer(seen.body),
        `req.body should be a Buffer, got ${typeof seen.body}`,
      );
    } finally {
      h.server.close();
    }
  });

  it('tampered body with the original signature → 401', async () => {
    const { h } = await setup();
    try {
      const signed = '{"zeta":1,   "alpha":"ä ö ü", "n":[1,2,3]}';
      const tampered = '{"zeta":9,   "alpha":"ä ö ü", "n":[1,2,3]}';
      const res = await fetch(`${h.baseUrl}${HOOK_PREFIX}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(signed),
        },
        body: tampered,
      });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { code: 'bad_signature' });
    } finally {
      h.server.close();
    }
  });

  it('after deactivate → 404, and the request does NOT fall through', async () => {
    const { h, dispose } = await setup();
    try {
      const body = '{"a":1}';
      dispose();
      const res = await fetch(`${h.baseUrl}${HOOK_PREFIX}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(body),
        },
        body,
      });
      assert.equal(res.status, 404);
      const payload = (await res.json()) as { code?: string };
      // C4's terminating mount answered — NOT the authenticated stack.
      assert.equal(payload.code, 'public_path.not_found');
    } finally {
      h.server.close();
    }
  });

  it("a body:'json' sibling route still receives parsed JSON", async () => {
    const { h } = await setup();
    try {
      const res = await fetch(`${h.baseUrl}${ADMIN_PREFIX}/echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: await operatorCookie(),
        },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        parsed: { hello: 'world' },
        rawBodyPresent: false,
      });
    } finally {
      h.server.close();
    }
  });

  it("a body:'json' child beneath a raw parent still receives parsed JSON", async () => {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    routes.register(HOOK_PREFIX, webhookRouter({}), 'acme', { body: 'raw' });
    routes.register(`${HOOK_PREFIX}/admin`, jsonRouter(), 'acme');
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      const res = await fetch(`${h.baseUrl}${HOOK_PREFIX}/admin/echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: await operatorCookie(),
        },
        body: JSON.stringify({ hello: 'child-route' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        parsed: { hello: 'child-route' },
        rawBodyPresent: false,
      });
    } finally {
      h.server.close();
    }
  });

  it('the raw slot buffers ONLY its own prefix — a core path is untouched', async () => {
    const { h } = await setup();
    try {
      // `/api/anything` is not a raw prefix: it must reach the authenticated
      // stack with normal JSON semantics, i.e. requireAuth 401s it.
      const res = await fetch(`${h.baseUrl}/api/somewhere-else`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"x":1}',
      });
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it("rejects body:'raw' at '/' because a one-segment claim is too broad", () => {
    const routes = newRegistry(kernelRequireAuth());
    assert.throws(
      () => routes.register('/', webhookRouter({}), 'evil', { body: 'raw' }),
      /'evil'.*'\/'.*body:'raw'.*one-segment claim is too broad/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G2 — the session gate, and the registration-time constraint on opting out.
// ───────────────────────────────────────────────────────────────────────────

describe("#470 C6 / G2 — auth:'session'", () => {
  async function setup(): Promise<{ h: Harness; dispose: () => void }> {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    const dispose = routes.register(ADMIN_PREFIX, jsonRouter(), 'acme');
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    return { h, dispose };
  }

  it('without a session → 401', async () => {
    const { h } = await setup();
    try {
      const res = await fetch(`${h.baseUrl}${ADMIN_PREFIX}/ping`);
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it('with a valid operator session → 200 from the plugin router', async () => {
    const { h } = await setup();
    try {
      const res = await fetch(`${h.baseUrl}${ADMIN_PREFIX}/ping`, {
        headers: { Cookie: await operatorCookie() },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      h.server.close();
    }
  });

  it('gates a prefix OUTSIDE /api, which the blanket mount never covered', async () => {
    // The point of G2 that is not defence-in-depth: `/diagrams`, `/documents`
    // and `/p/...` are outside the OB-106 `/api` gate entirely.
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    routes.register('/diagrams', jsonRouter(), 'acme');
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      assert.equal((await fetch(`${h.baseUrl}/diagrams/ping`)).status, 401);
      const ok = await fetch(`${h.baseUrl}/diagrams/ping`, {
        headers: { Cookie: await operatorCookie() },
      });
      assert.equal(ok.status, 200);
    } finally {
      h.server.close();
    }
  });

  it('registering auth:\'session\' before requireAuth exists throws, not serves', () => {
    const unwired = new PluginRouteRegistry({ sessionAuth: () => undefined });
    assert.throws(
      () => unwired.register(ADMIN_PREFIX, jsonRouter(), 'acme'),
      /no session middleware is available yet/,
    );
  });
});

describe("#470 C6 / G2 — consent stays load-bearing for auth:'public' and auth:'custom'", () => {
  it("auth:'public' under /api without a grant still answers 401", async () => {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    routes.register(API_PUBLIC_PREFIX, jsonRouter(), 'acme', { auth: 'public' });
    grants.claim('acme', [API_PUBLIC_PREFIX], {
      ...claimCtx(API_PUBLIC_PREFIX),
      grantedPrefixes: new Set(),
    });
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      const res = await fetch(`${h.baseUrl}${API_PUBLIC_PREFIX}/ping`);
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it("auth:'public' outside /api without a grant is not served", async () => {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    routes.register(DIAGRAM_PUBLIC_PREFIX, jsonRouter(), 'acme', { auth: 'public' });
    grants.claim('acme', [DIAGRAM_PUBLIC_PREFIX], {
      ...claimCtx(DIAGRAM_PUBLIC_PREFIX),
      grantedPrefixes: new Set(),
    });
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      const res = await fetch(`${h.baseUrl}${DIAGRAM_PUBLIC_PREFIX}/ping`);
      assert.equal(res.status, 404);
    } finally {
      h.server.close();
    }
  });

  it("revoking the grant stops serving an auth:'custom' route outside /api", async () => {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    routes.register(DIAGRAM_CUSTOM_PREFIX, jsonRouter(), 'acme', { auth: 'custom' });
    grants.claim('acme', [DIAGRAM_CUSTOM_PREFIX], {
      ...claimCtx(DIAGRAM_CUSTOM_PREFIX),
      grantedPrefixes: new Set([DIAGRAM_CUSTOM_PREFIX]),
    });
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      const before = await fetch(`${h.baseUrl}${DIAGRAM_CUSTOM_PREFIX}/ping`);
      assert.equal(before.status, 200);
      grants.setGranted('acme', new Set());
      const after = await fetch(`${h.baseUrl}${DIAGRAM_CUSTOM_PREFIX}/ping`);
      assert.equal(after.status, 404);
    } finally {
      h.server.close();
    }
  });

  it("a granted public prefix does NOT launder an auth:'session' route into a public one", async () => {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    routes.register(DIAGRAM_SESSION_PREFIX, jsonRouter(), 'acme');
    grants.claim('acme', [DIAGRAM_SESSION_PREFIX], {
      ...claimCtx(DIAGRAM_SESSION_PREFIX),
      grantedPrefixes: new Set([DIAGRAM_SESSION_PREFIX]),
    });
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      // This is the property that keeps a grant from laundering a
      // session-gated route into a public one.
      const anon = await fetch(`${h.baseUrl}${DIAGRAM_SESSION_PREFIX}/ping`);
      assert.equal(anon.status, 401);
      const session = await fetch(`${h.baseUrl}${DIAGRAM_SESSION_PREFIX}/ping`, {
        headers: { Cookie: await operatorCookie() },
      });
      assert.equal(session.status, 200);
    } finally {
      h.server.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE PINNED ORDER. Disposed guard BEFORE auth.
// ───────────────────────────────────────────────────────────────────────────

describe('#470 C6 / G2 — the disposed guard runs BEFORE auth (pinned order)', () => {
  it('a deactivated session route answers 404, never 401', async () => {
    const auth = kernelRequireAuth();
    const routes = newRegistry(auth);
    const grants = new PublicPathGrantRegistry();
    // Outside `/api` so the blanket gate cannot answer instead and mask the
    // property under test. This is the assertion that distinguishes the two
    // compositions: guard-first → 404 (the prefix is gone); auth-first → 401
    // (the prefix still challenges for a session it will never accept).
    const dispose = routes.register('/diagrams', jsonRouter(), 'acme');
    const h = await buildApp({ routes, grants, sessionAuth: auth });
    try {
      assert.equal((await fetch(`${h.baseUrl}/diagrams/ping`)).status, 401);
      dispose();
      const after = await fetch(`${h.baseUrl}/diagrams/ping`);
      assert.equal(
        after.status,
        404,
        'a deactivated plugin route must 404 before any auth logic runs',
      );
    } finally {
      h.server.close();
    }
  });

  /**
   * COUNTER-PROOF. Rebuild the pre-C6 composition by hand — auth mounted
   * OUTSIDE the guard — and show the assertion above flips to 401.
   *
   * A pinned-order test that cannot fail when the order is wrong is not
   * evidence that the order is right, which is the same standard C4 applied to
   * its `terminate: false` case.
   */
  it('COUNTER-PROOF: auth outside the guard makes the same request 401', async () => {
    const auth = kernelRequireAuth();
    const router = jsonRouter();
    let disposed = false;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    // The swapped order: auth first, disposed guard second.
    app.use('/diagrams', auth, (req, res, next) => {
      if (disposed) {
        next();
        return;
      }
      router(req, res, next);
    });
    const server = await listenLoopback(app);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    try {
      disposed = true;
      const res = await fetch(`${baseUrl}/diagrams/ping`);
      assert.equal(
        res.status,
        401,
        'with auth outside the guard a deactivated route still challenges — ' +
          'which is exactly what the pinned-order test above forbids',
      );
    } finally {
      server.close();
    }
  });
});
