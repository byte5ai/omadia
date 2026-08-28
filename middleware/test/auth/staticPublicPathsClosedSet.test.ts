import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express, { Router } from 'express';

import { publicPaths, STATIC_PUBLIC_PATHS } from '../../src/auth/publicPaths.js';
import { createRequireAuth } from '../../src/auth/requireAuth.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { CIMD_METADATA_PATH } from '../../src/services/mcpCimd.js';
import { PUBLIC_MCP_PATH } from '../../src/mcp/publicMcpPath.js';

/**
 * Epic #470 C12 — `STATIC_PUBLIC_PATHS` is a CLOSED set of CORE-owned entries.
 *
 * C12 deletes the last two entries core held on a plugin's behalf. Since C4 a
 * plugin declares its own public prefixes in `permissions.public_paths`, and
 * `validateDeclaredPublicPath` REJECTS a declaration that collides with a live
 * static exemption ("is already a static core public path … remove the core
 * exemption first, or drop the declaration"). So the deletion is not tidy-up:
 * it is the half of the handover that makes the plugin's grant validate at all.
 *
 * WHY THIS SUITE DOES NOT NAME THE TWO DELETED PATHS
 * -------------------------------------------------
 * Naming them would write a plugin's wire paths back into core — the exact
 * coupling this epic removed, and the thing the #470 decoupling ratchet counted
 * on its way to zero before it was retired at C14. A test that hardcodes a plugin's URLs
 * is a reference to that plugin whichever direction it asserts in, and it goes
 * stale-but-green the day the plugin renames them.
 *
 * Stated as a closed set the guard is also strictly stronger. Enumerating two
 * paths catches those two coming back. Pinning the WHOLE array catches any
 * unauthenticated surface being added — the two just deleted, and the next one
 * nobody has thought of yet.
 *
 * The 401 half is then a corollary rather than an enumeration: `requireAuth`
 * runs on the `/api` mount BEFORE routing, so every `/api/*` path the closed set
 * does not match answers 401 without a session — necessarily including the two
 * this commit removed.
 */

/**
 * Every entry core owns, identified by a path it exists to admit and the reason
 * that path may skip the session gate.
 *
 * Keyed on behaviour rather than on `String(regexp)` for two reasons. A source
 * snapshot goes red on a harmless reformat, which trains reviewers to re-bless
 * it without reading — and two of the entries are built from SHARED constants
 * (`CIMD_METADATA_PATH`, `PUBLIC_MCP_PATH`) precisely so no second copy of the
 * path exists; retyping their compiled source here would reintroduce the drift
 * those constants were introduced to prevent.
 */
const CORE_OWNED_EXEMPTIONS: ReadonlyArray<{
  readonly path: string;
  readonly why: string;
}> = [
  { path: '/api/v1/auth/login', why: 'operator sign-in — there is no session yet' },
  { path: '/api/v1/setup/status', why: 'first-run setup — there is no operator yet' },
  { path: '/api/auth/callback', why: 'legacy auth prefix' },
  {
    path: '/api/v1/install/oauth/callback',
    why: 'spec-005 kernel OAuth broker callback — self-secures on a signed, single-use state token',
  },
  {
    path: '/api/messages',
    why: 'Bot Framework webhook — the adapter validates the Bot-issued JWT in the handler',
  },
  {
    path: '/api/v1/operator/mcp-oauth/callback',
    why: 'epic #459 W9 MCP-server OAuth callback — same signed-state shape',
  },
  {
    path: CIMD_METADATA_PATH,
    why: 'MCP client-ID metadata document — an authorization server fetches it uncredentialed',
  },
  {
    path: '/p/example-plugin/index.html',
    why: 'plugin-served UI, iframed by Teams where only a Teams SSO token exists',
  },
  {
    path: '/api/public/v1/chat',
    why: 'public API channel ingress — requireApiKey is its authentication (#438)',
  },
  {
    path: PUBLIC_MCP_PATH,
    why: 'public stateless MCP endpoint — requireApiKey plus a key-binding row (#542)',
  },
];

describe('publicPaths — the static allowlist is a closed, core-owned set (#470 C12)', () => {
  it('holds exactly one entry per core-owned exemption, and no others', () => {
    /**
     * The load-bearing direction. An entry that admits none of the paths above
     * is an unauthenticated surface nobody in this file can account for —
     * which is exactly what restoring either deleted entry looks like.
     */
    const unaccounted = STATIC_PUBLIC_PATHS.filter(
      (re) => !CORE_OWNED_EXEMPTIONS.some((e) => re.test(e.path)),
    ).map((re) => String(re));

    assert.deepEqual(
      unaccounted,
      [],
      'Each entry here is an unauthenticated-until-the-handler-says-otherwise ' +
        'surface, so each one needs a named owner in CORE_OWNED_EXEMPTIONS. A ' +
        'plugin that needs a public path declares it in permissions.public_paths ' +
        'and the operator consents (platform/publicPathGrants.ts) — core does not ' +
        'carry it. Adding an entry means adding a row above and saying why.',
    );

    // The other direction: no exemption listed above has silently lost its entry.
    for (const { path, why } of CORE_OWNED_EXEMPTIONS) {
      assert.equal(
        STATIC_PUBLIC_PATHS.some((re) => re.test(path)),
        true,
        `${path} must stay exempt — ${why}`,
      );
    }

    // Belt and braces: one entry per row, so a duplicate or a widened regex
    // cannot hide behind a row that already accounts for something else.
    assert.equal(
      STATIC_PUBLIC_PATHS.length,
      CORE_OWNED_EXEMPTIONS.length,
      'one entry per documented exemption',
    );
  });

  it('is what the production accessor returns', () => {
    assert.deepEqual([...publicPaths()], [...STATIC_PUBLIC_PATHS]);
  });

  it('takes no configuration that could re-open a path (#669)', () => {
    assert.equal(publicPaths.length, 0);
  });
});

/**
 * The 401 half, against the SAME chain `src/index.ts` assembles — the reason
 * recorded at the top of `src/auth/publicPaths.ts`: a test app that omits the
 * blanket `/api` guard proves nothing about a route whose reachability depends
 * on that guard.
 */
describe('publicPaths — a path off the closed set 401s before routing (#470 C12)', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let sandboxDeniedListen = false;

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    // Load-bearing: without it `req.cookies` is undefined and requireAuth 401s
    // everything, so the assertions below would pass for the wrong reason.
    app.use(cookieParser());
    app.use(
      '/api',
      createRequireAuth({
        signingKey: new Uint8Array(64).fill(9),
        whitelist: new EmailWhitelist('operator@example.com'),
        publicPaths: publicPaths(),
      }),
      // Nothing is mounted underneath, deliberately: the guard must answer
      // before express reaches its own 404, which is what makes the exemption —
      // not the mount — the thing that decides reachability.
      Router(),
    );

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
      // Some sandboxes refuse loopback listeners. Locally we self-skip so the
      // rest of the file still runs, but in CI that would silently delete the
      // entire 401 half of this closed-set guard while the job stayed green.
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') {
        if (process.env.CI) {
          throw new Error(
            'CI must allow a loopback listener for staticPublicPathsClosedSet.test.ts. ' +
              'Without bind(127.0.0.1:0) the five unauthenticated 401 assertions ' +
              'would be skipped, which would hide a regression in the closed public-path set.',
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

  /**
   * Shapes an unauthenticated, non-operator caller arrives with: a process
   * holding a bearer token, a provider finishing a redirect, a plugin's own
   * namespaced route. None is matched by the closed set, so each must 401 —
   * and so must anything else off that list, which is the property C12 relies
   * on now that core exempts nothing on a plugin's behalf.
   */
  const OFF_LIST: readonly string[] = [
    '/api/v1/plugin-owned/ping',
    '/api/v1/plugin-owned/llm/v1/messages',
    '/api/v1/plugin-owned/vcs-app/callback?code=abc&state=xyz',
    '/api/plugins/example/webhook',
  ];

  for (const path of OFF_LIST) {
    it(`401s ${path} with no session`, async (t) => {
      if (sandboxDeniedListen) {
        t.skip('sandbox refuses loopback listeners');
        return;
      }
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(
        res.status,
        401,
        `${path} is not on the closed allowlist, so it must never reach a router ` +
          'unauthenticated. An operator-consented grant (platform/publicPathMount.ts) ' +
          'is the only way to make it public, and that mount terminates in the ' +
          'owning plugin instead of passing the request on.',
      );
    });
  }

  it('answers 401 rather than 404 — the guard runs before routing', async (t) => {
    if (sandboxDeniedListen) {
      t.skip('sandbox refuses loopback listeners');
      return;
    }
    const res = await fetch(`${baseUrl}/api/v1/nothing-is-mounted-here`);
    assert.equal(
      res.status,
      401,
      'a 404 would mean the guard is deciding after routing, and an unmounted ' +
        'path would then be open the moment anything mounts under it',
    );
  });
});
