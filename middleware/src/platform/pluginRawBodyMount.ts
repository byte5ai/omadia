import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { PluginRouteRegistry } from './pluginRouteRegistry.js';

/**
 * Epic #470 C6 / G3 — the pre-`express.json` slot for plugin raw-body routes.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * A route-local `express.raw()` composed into the plugin's own stack is the
 * right *shape* (`plan.md` §3 G3: "a route-local raw parser at the plugin's
 * own prefix"), but on its own it does not work, and the reason is one line of
 * body-parser: every parser bails out early when `req._body` is already set.
 *
 * Core's global `express.json({ limit: '10mb' })` is mounted in `index.ts`
 * before every plugin-reachable mount — including the C4/H1 public-path mount,
 * which sits *after* `express.json` and `cookieParser` on purpose so plugin
 * handlers see the same parsed request they see through the ordinary boot
 * flush. A GitHub webhook arrives as `Content-Type: application/json`, so the
 * global parser matches it, reads the stream to completion, sets `req.body` to
 * the parsed OBJECT and marks `req._body = true`. The route-local
 * `express.raw()` then runs, sees the marker, and returns immediately. The
 * plugin gets an object where it needed bytes, and every HMAC fails — or,
 * worse, silently passes against a re-serialised body that is not what was
 * signed.
 *
 * So the raw parse has to happen BEFORE the global JSON parser. This mount is
 * that slot, and it is the whole interaction with global body parsing:
 *
 *     request
 *       → [this mount]   raw-registered prefix? parse to Buffer, then next()
 *       → express.json   sees req._body, passes through untouched
 *       → cookieParser
 *       → public-path mount / requireAuth / the plugin's own stack
 *
 * Two things it deliberately is NOT:
 *
 *   * **Not `express.json`'s `verify` hook.** `verify` only fires when the JSON
 *     parser's own `type` matcher accepts the request, so it never sees a
 *     webhook posted as `application/x-www-form-urlencoded`; widening the
 *     global matcher to compensate would force non-JSON traffic through the
 *     JSON parser AND raise the raw route's deliberate 512 KB limit to the
 *     global 10 MB on an unauthenticated, internet-facing endpoint
 *     (`plan.md` §3 G3).
 *   * **Not a route.** It never answers, never 404s, never authenticates. It
 *     parses and calls `next()`. Routing, termination and authentication stay
 *     exactly where C4 put them.
 *
 * OWNERSHIP FIRST, THEN RAWNESS
 * -----------------------------
 * `resolveRawBodyRoute` resolves the LONGEST live prefix covering the path and
 * only then asks whether that winner is raw. It deliberately does not pick the
 * longest *raw* prefix: a shorter raw entry beating a longer `'json'` entry
 * would buffer a path the raw route does not own, and the json router would
 * receive a `Buffer` where it asked for a parsed object — silently, because
 * body-parser's `_body` marker makes every later parser a no-op. The rule is
 * "the parser that runs here belongs to the router that will answer".
 *
 * THE COST, STATED PLAINLY
 * ------------------------
 * This runs before authentication, because it has to. A raw route therefore
 * buffers up to its limit for an anonymous caller before anyone checks who
 * they are. Four things bound that cost, and all four are load-bearing:
 *
 *   * the default limit is 512 KB, not the global 10 MB
 *     (`PLUGIN_RAW_BODY_LIMIT`);
 *   * only prefixes a live plugin explicitly registered as `body: 'raw'` match,
 *     and a disposed entry stops matching immediately;
 *   * `body: 'raw'` is only registerable beneath a prefix the plugin declared
 *     in `permissions.public_paths` (`pluginContext.ts`) — the same
 *     operator-visible gate `auth: 'public' | 'custom'` goes through, because a
 *     global pre-auth parser is just as much a boundary decision as opting out
 *     of the session gate. C4's declaration schema forbids one-segment paths,
 *     core-reserved roots and core-`publicPaths` collisions, so no plugin can
 *     claim a prefix broad enough to buffer core's own traffic;
 *   * the registry keeps a floor of its own (`>= 2` path segments) so a call
 *     site that bypasses the manifest layer still cannot register `/` as raw.
 *
 * Nothing here widens what is *reachable*: an unauthenticated request to a raw
 * route still meets the public-path mount and `requireAuth` afterwards exactly
 * as it would without this mount.
 */

export interface PluginRawBodyMountOptions {
  readonly routes: PluginRouteRegistry;
  /** Injected for tests; defaults to `console.warn`. */
  readonly logger?: (message: string) => void;
}

export function createPluginRawBodyMount(
  opts: PluginRawBodyMountOptions,
): RequestHandler {
  const warn = opts.logger ?? ((message: string) => console.warn(message));

  return function pluginRawBodyMount(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // `req.path` is already decoded and query-free, the same value the grant
    // machinery matches on — one representation of a path across both, so a
    // raw route and its grant can never disagree about which URL they mean.
    const route = opts.routes.resolveRawBodyRoute(req.path);
    if (!route) {
      next();
      return;
    }
    route.parse(req, res, (err?: unknown) => {
      if (err) {
        // A limit overflow or a broken stream. Hand it to the error pipeline
        // rather than swallowing it: the plugin must never receive a truncated
        // buffer and compute an HMAC over it.
        warn(
          `[plugin-raw-body] '${req.path}' (${route.source} → ${route.prefix}) failed to buffer: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        next(err);
        return;
      }
      next();
    });
  };
}
