/**
 * Issue #669 — shared harness for the `/api/dev/*` + KG-admin auth tests.
 *
 * Assembles the SAME chain `src/index.ts` assembles, in the same order, for
 * the reason recorded at the top of `src/auth/publicPaths.ts`: epic #470's
 * runner router was mounted without a session guard and its e2e test built its
 * OWN bare `express()` app to prove it — so the test passed while the route
 * 401'd in production behind the blanket guard. A test app that omits the
 * guard proves nothing about a route whose reachability depends on it, and the
 * inverse is what #669 is about: a test app that omits the guard would also
 * fail to notice that the guard is missing.
 *
 * So:
 *   1. `express.json({ limit: '10mb' })` + `cookieParser()` — the same global
 *      parsers. The cookie parser is load-bearing: without it every request
 *      401s, and the negative assertions would pass for the wrong reason.
 *   2. `app.use('/api', requireAuth, <router>)` — the OB-106 line, which runs
 *      for EVERY `/api/*` request whichever router ultimately answers it.
 *   3. `mountKnowledgeGraphAdmin` / `mountDevGraph` — the SAME production
 *      functions from `src/routes/graphRouterMounts.ts`, not a re-implementation.
 *   4. `createRequireAuth({ publicPaths: publicPaths() })` — the SAME shared
 *      allowlist production runs.
 *
 * `withLegacyDevPublicPath` drives the negative half: put the pre-#669
 * `/^\/api\/dev/` entry back into the allowlist and the surface must go open
 * again. That is the mutation this suite exists to catch.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';

import { NoopAgentPrioritiesStore } from '@omadia/plugin-api';
import type { AgentPrioritiesStore } from '@omadia/plugin-api';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type {
  LastSweep,
  LifecycleService,
  LifecycleStats,
} from '@omadia/knowledge-graph-neon/dist/lifecycleService.js';

// The three sweep-stat shapes live in sibling modules (`decayJob`, `gc`,
// `accessTracker`) and are not re-exported from `lifecycleService`. Derived
// from the interface itself rather than reached for by deep path: the fake
// below then cannot drift from what the service actually promises.
type DecaySweepStats = Awaited<ReturnType<LifecycleService['runDecayNow']>>;
type GcSweepStats = Awaited<ReturnType<LifecycleService['runGcNow']>>;
type AccessTrackerFlushStats = Awaited<
  ReturnType<LifecycleService['runAccessFlushNow']>
>;

import { publicPaths, STATIC_PUBLIC_PATHS } from '../../src/auth/publicPaths.js';
import { createRequireAuth } from '../../src/auth/requireAuth.js';
import { SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { PluginCatalog } from '../../src/plugins/manifestLoader.js';
import {
  mountDevGraph,
  mountKnowledgeGraphAdmin,
} from '../../src/routes/graphRouterMounts.js';

/** The allowlist entry #669 deleted, restored verbatim for the negative case. */
export const LEGACY_DEV_PUBLIC_PATH = /^\/api\/dev(?:\/|$|\?)/;

const SESSION_KEY = new Uint8Array(64).fill(9);
const OPERATOR_EMAIL = 'operator@example.com';

/**
 * Re-exported so `devEndpointsAuth.e2e`'s six call sites keep their import,
 * while the behaviour lives in ONE place (#1024). The local copy this replaces
 * ignored `OMADIA_EXPECT_LOOPBACK`, so on a listener-denied runner the whole
 * auth e2e passed green without asserting a single 401.
 */
export { isSandboxListenDenied } from '../_helpers/listenLoopback.js';

/**
 * A `LifecycleService` that records every call.
 *
 * Declared `implements LifecycleService` rather than cast through
 * `as unknown as` on purpose: a cast would let a renamed or missing method
 * compile and then surface as a `500` inside a test that is asking about
 * `401` vs `200`, which reads as "the guard let it through" — the exact
 * confusion that makes an auth suite untrustworthy.
 */
export class RecordingLifecycleService implements LifecycleService {
  readonly calls: string[] = [];

  getStats(): Promise<LifecycleStats> {
    this.calls.push('getStats');
    return Promise.resolve({
      totalTurns: 3,
      byTier: { HOT: 1, WARM: 1, COLD: 1 },
      byEntryType: { memory: 3, process: 0, task: 0 },
      decayDistribution: { high: 1, upperMid: 1, lowerMid: 1, cold: 0 },
      topScopesByCount: [{ scope: 'demo', count: 3, chars: 300 }],
      quotas: { hotMaxEntries: 50, maxTotalChars: 100_000 },
    });
  }

  runDecayNow(): Promise<DecaySweepStats> {
    this.calls.push('runDecayNow');
    return Promise.resolve({
      decayUpdated: 0,
      hotToWarm: 0,
      warmToCold: 0,
      doneTasksDeleted: 0,
      durationMs: 1,
    });
  }

  runGcNow(): Promise<GcSweepStats> {
    this.calls.push('runGcNow');
    return Promise.resolve({
      scopesAffected: 0,
      evictedByCount: 0,
      evictedByChars: 0,
      durationMs: 1,
    });
  }

  runAccessFlushNow(): Promise<AccessTrackerFlushStats> {
    this.calls.push('runAccessFlushNow');
    return Promise.resolve({ flushed: 0, promotedColdToWarm: 0, durationMs: 1 });
  }

  lastDecay(): LastSweep<DecaySweepStats> | null {
    return null;
  }

  lastGc(): LastSweep<GcSweepStats> | null {
    return null;
  }

  lastAccessFlush(): LastSweep<AccessTrackerFlushStats> | null {
    return null;
  }
}

export interface DevEndpointsHarnessOptions {
  /** Mirrors `config.DEV_ENDPOINTS_ENABLED`. Default `true` — most cases are
   *  about the surface being guarded, not about it being absent. */
  readonly devEndpointsEnabled?: boolean;
  /** Mirrors `config.DEV_ENDPOINTS_LOOPBACK_ONLY`. Default `false`. */
  readonly loopbackOnly?: boolean;
  /** Publish `graphLifecycle@1`. Omitted ⇒ a `RecordingLifecycleService`;
   *  `null` ⇒ the service was never published (in-memory KG backend). */
  readonly lifecycle?: LifecycleService | null;
  /** Publish `agentPriorities@1`. Omitted ⇒ a `NoopAgentPrioritiesStore`;
   *  `null` ⇒ never published. */
  readonly priorities?: AgentPrioritiesStore | null;
  /** Restore the pre-#669 `/api/dev` allowlist entry — the negative case. */
  readonly withLegacyDevPublicPath?: boolean;
}

export interface DevEndpointsHarness {
  readonly baseUrl: string;
  readonly app: Express;
  readonly lifecycle: RecordingLifecycleService | undefined;
  /** A valid operator session cookie for the whitelisted email. */
  readonly cookie: string;
  /** `fetch` against the harness. Sends the session cookie only if asked. */
  request(
    path: string,
    opts?: { method?: string; authenticated?: boolean },
  ): Promise<Response>;
  close(): Promise<void>;
}

export async function startDevEndpointsHarness(
  opts: DevEndpointsHarnessOptions = {},
): Promise<DevEndpointsHarness> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));
  // index.ts:2435 — without it `req.cookies` is undefined and requireAuth 401s
  // every request, including a valid one. Omitting it here would make the
  // "401 without a session" assertions pass for the wrong reason.
  app.use(cookieParser());

  const allowlist = opts.withLegacyDevPublicPath
    ? [...STATIC_PUBLIC_PATHS, LEGACY_DEV_PUBLIC_PATH]
    : publicPaths();

  const requireAuth = createRequireAuth({
    signingKey: SESSION_KEY,
    whitelist: new EmailWhitelist(OPERATOR_EMAIL),
    publicPaths: allowlist,
  });

  // (2) The OB-106 line. The trailing router stands in for createChatRouter —
  // what matters is that the guard runs first for the whole `/api` prefix,
  // which is what makes an unmounted `/api/dev/memory/...` path answer 401
  // rather than 404.
  app.use('/api', requireAuth, express.Router());

  const lifecycle =
    opts.lifecycle === null ? undefined : (opts.lifecycle ?? new RecordingLifecycleService());
  const priorities =
    opts.priorities === null ? undefined : (opts.priorities ?? new NoopAgentPrioritiesStore());

  // (3) The production mount functions.
  mountKnowledgeGraphAdmin(app, requireAuth, {
    lifecycle,
    priorities,
    catalog: new PluginCatalog({ manifestDir: '/nonexistent-for-tests' }),
  });

  mountDevGraph(app, requireAuth, {
    graph: new InMemoryKnowledgeGraph(),
    enabled: opts.devEndpointsEnabled ?? true,
    loopbackOnly: opts.loopbackOnly ?? false,
    log: () => {},
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const token = await signSession(
    {
      sub: 'op1',
      email: OPERATOR_EMAIL,
      display_name: 'Operator',
      provider: 'local',
      role: 'admin',
    },
    SESSION_KEY,
  );
  const cookie = `${SESSION_COOKIE}=${token}`;

  return {
    baseUrl,
    app,
    lifecycle: lifecycle instanceof RecordingLifecycleService ? lifecycle : undefined,
    cookie,
    request: (path, o) =>
      fetch(`${baseUrl}${path}`, {
        method: o?.method ?? 'GET',
        headers: o?.authenticated ? { Cookie: cookie } : {},
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
