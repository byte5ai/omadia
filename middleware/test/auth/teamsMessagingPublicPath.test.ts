/**
 * The Teams messaging webhook must reach its handler without a session — and
 * nothing else under `/api/teams` may.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT AN ENUMERATION OF REGEXES
 * ----------------------------------------------------------
 * Every provisioned Teams bot was silent in production. The chain was correct
 * end to end — app registration, catalog app, Teams channel, chat install,
 * endpoint URL — except for the last hop: channel-teams 0.20.0 moved the
 * webhook to `/api/teams/<botSlug>/messages`, `auth/publicPaths.ts` still
 * exempted only the legacy `/api/messages`, and so the blanket OB-106 `/api`
 * guard answered Teams `401 {"code":"auth.missing"}` before the bot handler
 * ran. Measured against production, `/api/messages` answered the Bot
 * Framework's own "Unauthorized Access. Request is not authorized" while every
 * `/api/teams/*` spelling answered the session guard's — the difference that
 * located the bug.
 *
 * So these tests assert REACHABILITY through the same chain `src/index.ts`
 * assembles, not the shape of an allowlist entry. A suite that checked that
 * `STATIC_PUBLIC_PATHS` contains some regex would have stayed green through the
 * entire outage: the regex it named was present and correct, and the routes it
 * did not cover were the broken ones.
 */

import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

import { publicPaths } from '../../src/auth/publicPaths.js';
import { createRequireAuth } from '../../src/auth/requireAuth.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { buildTeamsBotMessagingEndpoint } from '../../src/platform/teamsProvisionerService.js';
import {
  TEAMS_DEFAULT_MESSAGING_PATH,
  teamsBotMessagingPath,
} from '../../src/platform/teamsMessagingPath.js';

interface Probe {
  readonly status: number;
  readonly body: string;
}

describe('the Teams messaging webhook is reachable without a session', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let sandboxDeniedListen = false;

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    // Load-bearing: without it `req.cookies` is undefined and requireAuth 401s
    // everything, so the 401 assertions below would pass for the wrong reason.
    app.use(cookieParser());

    // The production shape, in order. `src/index.ts` mounts the blanket OB-106
    // guard at `/api` first; channel-teams' router arrives later, through
    // `channels/routeRegistry.ts#registerRouter`, which mounts straight onto
    // the app and adds NO auth of its own. The guard is therefore the only
    // thing standing in front of these routes — which is exactly why an
    // exemption, and nothing else, decides whether they are reachable.
    app.use(
      '/api',
      createRequireAuth({
        signingKey: new Uint8Array(64).fill(9),
        whitelist: new EmailWhitelist('operator@example.com'),
        publicPaths: publicPaths(),
      }),
      Router(),
    );

    // Stand-in for channel-teams' router: the three messaging routes it really
    // registers, plus siblings under the same `/api/teams` root. Answering 200
    // makes "the handler was reached" observable — in production this is where
    // `adapter.process` validates the Bot-issued JWT and answers its own 401 to
    // an anonymous caller.
    const reached = (_req: ExpressRequest, res: ExpressResponse): void => {
      res.status(200).json({ reached: true });
    };
    const pluginRouter = Router();
    pluginRouter.post('/messages', reached);
    pluginRouter.post('/teams/messages', reached);
    pluginRouter.post('/teams/:botSlug/messages', reached);
    // NOT messaging routes. Nothing mounts these today; they stand for the
    // sibling somebody adds under `/api/teams` next, and they must keep 401ing.
    pluginRouter.post('/teams/settings', reached);
    pluginRouter.post('/teams/:botSlug/admin', reached);
    pluginRouter.post('/teams/:botSlug/messages/history', reached);
    app.use('/api', pluginRouter);

    const created = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen(0, '127.0.0.1', () => {
          created.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      // Mirrors staticPublicPathsClosedSet.test.ts: some sandboxes refuse
      // loopback listeners, but skipping in CI would delete this whole suite
      // while the job stayed green — the failure mode that let the original bug
      // ship in the first place.
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') {
        if (process.env.CI) {
          throw new Error(
            'CI must allow a loopback listener for teamsMessagingPublicPath.test.ts. ' +
              'Without bind(127.0.0.1:0) both halves of this guard — the webhook ' +
              'being reachable and its siblings staying closed — would be skipped.',
            { cause: err },
          );
        }
        sandboxDeniedListen = true;
        return;
      }
      throw err;
    }
    server = created;
    baseUrl = `http://127.0.0.1:${String((created.address() as AddressInfo).port)}`;
  });

  after(async () => {
    const running = server;
    if (!running) return;
    await new Promise<void>((resolve) => {
      running.close(() => resolve());
    });
  });

  const post = async (path: string): Promise<Probe> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message' }),
    });
    return { status: res.status, body: await res.text() };
  };

  /**
   * Every spelling Teams may POST to: the legacy path, the default-bot alias,
   * and per-bot slugs across the provisioner's charset.
   */
  const MESSAGING_PATHS: readonly string[] = [
    '/api/messages',
    TEAMS_DEFAULT_MESSAGING_PATH,
    teamsBotMessagingPath('default'),
    teamsBotMessagingPath('hr-bot'),
    teamsBotMessagingPath('Agent_2.beta-1'),
  ];

  for (const path of MESSAGING_PATHS) {
    it(`reaches the bot handler for ${path} with no session`, async (t) => {
      if (sandboxDeniedListen) {
        t.skip('sandbox refuses loopback listeners');
        return;
      }
      const res = await post(path);
      assert.equal(
        res.status,
        200,
        `${path} must reach the Bot Framework adapter, which is what authenticates ` +
          'it (Teams sends a Bot-issued bearer token, never an operator session ' +
          `cookie). Got ${String(res.status)} ${res.body} — a 401 here is the ` +
          'session guard answering before routing, i.e. a silent bot.',
      );
    });
  }

  /**
   * The counter-check, and the reason the exemption names two URL shapes rather
   * than the `/api/teams` prefix. `publicPaths` is a pure BYPASS: a matching URL
   * skips the gate and travels on to whatever router answers it. A prefix entry
   * would hand every present and future sibling the same free pass.
   */
  const SESSION_REQUIRED_PATHS: readonly string[] = [
    '/api/teams/settings',
    '/api/teams/hr-bot/admin',
    '/api/teams/hr-bot/messages/history',
    '/api/teams',
    '/api/teams/hr-bot',
    // A slug outside the provisioner's charset never named a real bot.
    '/api/teams/-nope/messages',
    // Two segments where the route has one.
    '/api/teams/hr-bot/extra/messages',
  ];

  for (const path of SESSION_REQUIRED_PATHS) {
    it(`still 401s ${path} with no session`, async (t) => {
      if (sandboxDeniedListen) {
        t.skip('sandbox refuses loopback listeners');
        return;
      }
      const res = await post(path);
      assert.equal(
        res.status,
        401,
        `${path} is not a messaging webhook, so nothing about it self-authenticates. ` +
          'Exempting the /api/teams prefix rather than the two messaging shapes ' +
          `would open it. Got ${String(res.status)} ${res.body}.`,
      );
      const parsed: unknown = JSON.parse(res.body);
      assert.equal(
        (parsed as { code?: string }).code,
        'auth.missing',
        'the session guard, not a router, must be what answers',
      );
    });
  }
});

/**
 * THE RATCHET.
 *
 * The outage was a drift between two things core owns alone: the URL core
 * PROVISIONS into the Azure bot registration, and the URL core EXEMPTS from the
 * session gate. The provisioner was taught the 0.20.0 path; the allowlist was
 * not. Both now derive from `platform/teamsMessagingPath.ts`, and this asserts
 * the property that makes the binding worth having — so a future change to the
 * provisioned path that the exemption does not cover goes red HERE, at the
 * commit that makes it, instead of in a field test weeks later.
 */
describe('every endpoint the provisioner hands Azure is exempt from the session gate', () => {
  const SLUGS: readonly string[] = [
    'default',
    'hr-bot',
    'messias',
    'Agent_2.beta-1',
    'a',
    'a'.repeat(64),
  ];

  for (const slug of SLUGS) {
    it(`admits the provisioned endpoint for slug '${slug}'`, () => {
      const endpoint = buildTeamsBotMessagingEndpoint(
        'https://mw.example.com',
        slug,
      );
      const { pathname } = new URL(endpoint);
      assert.equal(
        publicPaths().some((re) => re.test(pathname)),
        true,
        `the provisioner hands Azure ${endpoint}, so ${pathname} must skip the ` +
          'session gate — otherwise the bot it provisions can never answer. If ' +
          'this fails, the provisioned path and the exemption have drifted apart ' +
          'again (platform/teamsMessagingPath.ts binds them).',
      );
    });
  }

  it('admits the endpoint served behind a path-prefixed base URL', () => {
    const endpoint = buildTeamsBotMessagingEndpoint(
      'https://example.com/omadia/',
      'hr-bot',
    );
    assert.equal(
      new URL(endpoint).pathname,
      '/omadia/api/teams/hr-bot/messages',
    );
    // The exemption matches `req.originalUrl`, which is the path the reverse
    // proxy forwards after stripping its own prefix.
    assert.equal(
      publicPaths().some((re) => re.test('/api/teams/hr-bot/messages')),
      true,
    );
  });
});
