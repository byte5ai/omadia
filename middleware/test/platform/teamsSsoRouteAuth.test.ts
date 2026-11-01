import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express, { Router } from 'express';
import type { RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createRequireAuth,
  createSessionGate,
  SESSION_COOKIE,
} from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { createTeamsSsoGate } from '../../src/auth/teamsSsoGate.js';
import { createTeamsSsoVerifier } from '../../src/auth/teamsSsoVerifier.js';
import { PluginRouteRegistry } from '../../src/platform/pluginRouteRegistry.js';
import { PublicPathGrantRegistry } from '../../src/platform/publicPathGrants.js';
import { createPublicPathMount } from '../../src/platform/publicPathMount.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';
import {
  BOT_APP_ID,
  jwksDocument,
  mintTeamsToken,
  OTHER_TENANT,
  TENANT,
} from '../_helpers/teamsSsoTokens.js';

/**
 * #1620 — `auth: 'teams-sso'` through the PRODUCTION mount order (same
 * topology as `pluginRouteAuthBody.test.ts`, for the same reason: a bare
 * express() app once hid a production 401).
 *
 *   express.json → cookieParser → [public-path mount] → /api requireAuth
 *     → plugin routers (boot flush)
 */

const SIGNING_KEY = new Uint8Array(32).fill(7);
const OPERATOR = 'operator@example.com';
const PLUGIN = '@omadia/agent-hr-dash';
const SLUG = '/p/agent-hr-dash';
const TEAMS_PREFIX = `${SLUG}/teams`;
const DATA_PREFIX = `${TEAMS_PREFIX}/_data`;
const SECRET_ROW = 'Ada Lovelace — sick leave';

interface Harness {
  server: Server;
  baseUrl: string;
  refusals: string[];
}

function productionSessionGate(): RequestHandler {
  return createSessionGate({
    signingKey: SIGNING_KEY,
    whitelist: new EmailWhitelist(OPERATOR),
  }) as unknown as RequestHandler;
}

function kernelRequireAuth(): RequestHandler {
  return createRequireAuth({
    signingKey: SIGNING_KEY,
    whitelist: new EmailWhitelist(OPERATOR),
    publicPaths: publicPaths(),
  }) as unknown as RequestHandler;
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

/** Registry wired like `index.ts`: real session gate, real Teams SSO gate. */
function newRegistry(refusals: string[]): PluginRouteRegistry {
  const verifier = createTeamsSsoVerifier({
    audiences: () => [{ appId: BOT_APP_ID, tenantId: TENANT }],
    fetchJwks: async () => jwksDocument(),
  });
  const session = productionSessionGate();
  return new PluginRouteRegistry({
    sessionAuth: () => session,
    teamsSsoAuth: (source) =>
      createTeamsSsoGate(source, {
        verifier,
        onRefuse: (reason) => refusals.push(reason),
      }),
  });
}

/** The data a ui_route renders — what must never leave without auth. */
function dataRouter(): Router {
  const r = Router();
  r.get('/absences', (req, res) => {
    res.status(200).json({ rows: [SECRET_ROW], user: req.teamsSsoUser ?? null });
  });
  return r;
}

/** The data-free shell Builder codegen mounts as `auth: 'public'`. */
function shellRouter(): Router {
  const r = Router();
  r.get('/absences', (_req, res) => {
    res.status(200).type('html').send('<p id="omadia-status">Loading…</p>');
  });
  return r;
}

async function buildApp(opts: {
  routes: PluginRouteRegistry;
  grants: PublicPathGrantRegistry;
  refusals: string[];
}): Promise<Harness> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use(
    createPublicPathMount({
      grants: opts.grants,
      routes: opts.routes,
      logger: () => undefined,
    }),
  );
  app.use('/api', kernelRequireAuth());
  opts.routes.mountAll(app);
  const server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    refusals: opts.refusals,
  };
}

/**
 * The topology Builder codegen emits for one ui_route: the browser page
 * session-gated at `/p/<slug>`, the Teams shell `'public'` and the data
 * `'teams-sso'`, both under the one declared `/p/<slug>/teams`.
 */
async function builderTopology(granted: boolean): Promise<Harness> {
  const refusals: string[] = [];
  const routes = newRegistry(refusals);
  const grants = new PublicPathGrantRegistry();
  routes.register(SLUG, dataRouter(), PLUGIN, { auth: 'session' });
  routes.register(TEAMS_PREFIX, shellRouter(), PLUGIN, { auth: 'public' });
  routes.register(DATA_PREFIX, dataRouter(), PLUGIN, { auth: 'teams-sso' });
  grants.claim(PLUGIN, [TEAMS_PREFIX], {
    corePublicPaths: publicPaths(),
    ownRoutePrefixes: [SLUG, TEAMS_PREFIX, DATA_PREFIX],
    grantedPrefixes: new Set(granted ? [TEAMS_PREFIX] : []),
  });
  return buildApp({ routes, grants, refusals });
}

const UNAUTHORIZED_BODY = {
  code: 'auth.teams_sso_required',
  message: 'Microsoft Teams sign-in required',
};

async function getData(
  h: Harness,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${h.baseUrl}${DATA_PREFIX}/absences`, { headers });
}

describe("#1620 — auth:'teams-sso' plugin route", () => {
  it('valid Teams token → 200, and the handler sees the verified user', async () => {
    const h = await builderTopology(true);
    try {
      const res = await getData(h, { Authorization: `Bearer ${mintTeamsToken()}` });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), {
        rows: [SECRET_ROW],
        user: {
          oid: 'user-oid-1',
          tenantId: TENANT,
          appId: BOT_APP_ID,
          upn: 'ada@example.com',
        },
      });
    } finally {
      h.server.close();
    }
  });

  const past = Math.floor(Date.now() / 1000) - 3600;
  const refused: ReadonlyArray<readonly [string, () => string, string]> = [
    ['no token at all', () => '', 'no bearer token'],
    [
      'an expired token',
      () => mintTeamsToken({ claims: { exp: past, nbf: past - 600 } }),
      'token expired',
    ],
    [
      'a token from another tenant',
      () =>
        mintTeamsToken({
          claims: {
            tid: OTHER_TENANT,
            iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
          },
        }),
      'token tenant is not a configured bot tenant',
    ],
    [
      'a token for another audience',
      () => mintTeamsToken({ claims: { aud: 'api://evil.example.com/other-app' } }),
      'token audience is not a bot app',
    ],
    ['a forged signature', () => mintTeamsToken({ forged: true }), 'bad token signature'],
    [
      'an app-only token',
      () => mintTeamsToken({ claims: { scp: undefined, roles: ['Data.Read'] } }),
      'token is not a delegated user token',
    ],
  ];

  for (const [label, token, reason] of refused) {
    it(`${label} → 401 with the generic body, reason only in the server log`, async () => {
      const h = await builderTopology(true);
      try {
        const value = token();
        const res = await getData(h, value ? { Authorization: `Bearer ${value}` } : {});
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), UNAUTHORIZED_BODY);
        assert.ok(!text.includes(SECRET_ROW));
        assert.deepEqual(h.refusals, [reason]);
      } finally {
        h.server.close();
      }
    });
  }

  it('an operator session cookie alone does NOT open it (pure teams-sso)', async () => {
    const h = await builderTopology(true);
    try {
      const res = await getData(h, { Cookie: await operatorCookie() });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), UNAUTHORIZED_BODY);
    } finally {
      h.server.close();
    }
  });

  it('a session cookie next to a forged token is still refused', async () => {
    const h = await builderTopology(true);
    try {
      const res = await getData(h, {
        Cookie: await operatorCookie(),
        Authorization: `Bearer ${mintTeamsToken({ forged: true })}`,
      });
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it('without the operator grant even a valid token is not served', async () => {
    const h = await builderTopology(false);
    try {
      const res = await getData(h, { Authorization: `Bearer ${mintTeamsToken()}` });
      // Ungranted, the path falls through to the session-gated browser mount
      // at /p/<slug> — 401 without a session, never the data.
      assert.equal(res.status, 401);
      assert.ok(!(await res.text()).includes(SECRET_ROW));
    } finally {
      h.server.close();
    }
  });

  it('without the grant and without a session-gated sibling → 404', async () => {
    const refusals: string[] = [];
    const routes = newRegistry(refusals);
    const grants = new PublicPathGrantRegistry();
    routes.register(DATA_PREFIX, dataRouter(), PLUGIN, { auth: 'teams-sso' });
    grants.claim(PLUGIN, [DATA_PREFIX], {
      corePublicPaths: publicPaths(),
      ownRoutePrefixes: [DATA_PREFIX],
      grantedPrefixes: new Set(),
    });
    const h = await buildApp({ routes, grants, refusals });
    try {
      const res = await getData(h, { Authorization: `Bearer ${mintTeamsToken()}` });
      assert.equal(res.status, 404);
    } finally {
      h.server.close();
    }
  });

  it('revoking the grant stops serving it', async () => {
    const refusals: string[] = [];
    const routes = newRegistry(refusals);
    const grants = new PublicPathGrantRegistry();
    routes.register(DATA_PREFIX, dataRouter(), PLUGIN, { auth: 'teams-sso' });
    grants.claim(PLUGIN, [DATA_PREFIX], {
      corePublicPaths: publicPaths(),
      ownRoutePrefixes: [DATA_PREFIX],
      grantedPrefixes: new Set([DATA_PREFIX]),
    });
    const h = await buildApp({ routes, grants, refusals });
    try {
      const auth = { Authorization: `Bearer ${mintTeamsToken()}` };
      assert.equal((await getData(h, auth)).status, 200);
      grants.setGranted(PLUGIN, new Set());
      assert.equal((await getData(h, auth)).status, 404);
    } finally {
      h.server.close();
    }
  });

  it('a deactivated teams-sso route answers 404, not 401', async () => {
    const refusals: string[] = [];
    const routes = newRegistry(refusals);
    const grants = new PublicPathGrantRegistry();
    const dispose = routes.register(DATA_PREFIX, dataRouter(), PLUGIN, {
      auth: 'teams-sso',
    });
    grants.claim(PLUGIN, [DATA_PREFIX], {
      corePublicPaths: publicPaths(),
      ownRoutePrefixes: [DATA_PREFIX],
      grantedPrefixes: new Set([DATA_PREFIX]),
    });
    const h = await buildApp({ routes, grants, refusals });
    try {
      dispose();
      const res = await getData(h);
      assert.equal(res.status, 404);
      assert.deepEqual(refusals, []);
    } finally {
      h.server.close();
    }
  });

  it('is never mounted ambiently: no grant claim → never served', async () => {
    const refusals: string[] = [];
    const routes = newRegistry(refusals);
    routes.register(DATA_PREFIX, dataRouter(), PLUGIN, { auth: 'teams-sso' });
    const h = await buildApp({
      routes,
      grants: new PublicPathGrantRegistry(),
      refusals,
    });
    try {
      const res = await getData(h, { Authorization: `Bearer ${mintTeamsToken()}` });
      assert.equal(res.status, 404);
    } finally {
      h.server.close();
    }
  });

  it("registering auth:'teams-sso' on a kernel without a verifier throws", () => {
    const session = productionSessionGate();
    const routes = new PluginRouteRegistry({ sessionAuth: () => session });
    assert.throws(
      () => routes.register(DATA_PREFIX, dataRouter(), PLUGIN, { auth: 'teams-sso' }),
      /no Teams SSO verifier wired/,
    );
  });

  it('a request cannot smuggle its own teamsSsoUser past the gate', async () => {
    const refusals: string[] = [];
    const routes = newRegistry(refusals);
    const grants = new PublicPathGrantRegistry();
    routes.register(DATA_PREFIX, dataRouter(), PLUGIN, { auth: 'teams-sso' });
    grants.claim(PLUGIN, [DATA_PREFIX], {
      corePublicPaths: publicPaths(),
      ownRoutePrefixes: [DATA_PREFIX],
      grantedPrefixes: new Set([DATA_PREFIX]),
    });
    const app = express();
    // Some earlier middleware (or a bug) sets the property.
    app.use((req, _res, next) => {
      req.teamsSsoUser = { oid: 'attacker', tenantId: TENANT, appId: BOT_APP_ID };
      next();
    });
    app.use(createPublicPathMount({ grants, routes, logger: () => undefined }));
    const server = await listenLoopback(app);
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}${DATA_PREFIX}/absences`);
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });
});

describe('#1620 — the Builder topology around a teams-sso route', () => {
  it('the Teams shell is served without auth and carries no data', async () => {
    const h = await builderTopology(true);
    try {
      const res = await fetch(`${h.baseUrl}${TEAMS_PREFIX}/absences`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('omadia-status'));
      assert.ok(!text.includes(SECRET_ROW));
    } finally {
      h.server.close();
    }
  });

  it('the browser page stays session-gated: anonymous → 401, operator → 200', async () => {
    const h = await builderTopology(true);
    try {
      const anonymous = await fetch(`${h.baseUrl}${SLUG}/absences`);
      assert.equal(anonymous.status, 401);
      const operator = await fetch(`${h.baseUrl}${SLUG}/absences`, {
        headers: { Cookie: await operatorCookie() },
      });
      assert.equal(operator.status, 200);
    } finally {
      h.server.close();
    }
  });

  it('a Teams token does not open the session-gated browser page', async () => {
    const h = await builderTopology(true);
    try {
      const res = await fetch(`${h.baseUrl}${SLUG}/absences`, {
        headers: { Authorization: `Bearer ${mintTeamsToken()}` },
      });
      assert.equal(res.status, 401);
    } finally {
      h.server.close();
    }
  });

  it('an unknown path under the granted Teams prefix → 404, no fallthrough', async () => {
    const h = await builderTopology(true);
    try {
      const res = await fetch(`${h.baseUrl}${TEAMS_PREFIX}/payroll`, {
        headers: { Cookie: await operatorCookie() },
      });
      assert.equal(res.status, 404);
    } finally {
      h.server.close();
    }
  });
});
