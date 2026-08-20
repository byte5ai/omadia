import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { PluginRouteRegistry } from './pluginRouteRegistry.js';
import type { PublicPathGrantRegistry } from './publicPathGrants.js';

/**
 * Epic #470 C4 / H1 — the terminating early mount.
 *
 * Mounted in `index.ts` BEFORE the blanket `app.use('/api', requireAuth, …)`
 * line. That position is the entire design:
 *
 *   request
 *     → [this mount]  granted prefix? → dispatch to the owning plugin, TERMINATE
 *                     otherwise       → next()
 *     → requireAuth   401 unless the URL is a static core public path
 *     → the authenticated router stack
 *
 * WHY IT TERMINATES
 * -----------------
 * If this mount called `next()` when the owning plugin's router did not handle
 * a path under its granted prefix, the request would carry on into the stack
 * with no session — and some other router, mounted now or added in two years
 * by someone who never read this file, would answer it. That is exactly the
 * hole a plain `publicPaths` entry leaves open: an exemption grants a URL, not
 * a router. So an unhandled path under a granted prefix is a 404 from here and
 * goes no further. The granted prefix is a closed world owned by one plugin.
 *
 * There is a test that proves this is load-bearing rather than decorative:
 * `terminate: false` reproduces the fallthrough, and the assertion flips.
 *
 * WHY IT IS FAIL-CLOSED
 * ---------------------
 * Every "I don't know" answer is `next()` — i.e. straight into `requireAuth`.
 * No grants loaded, registry unwired, plugin not activated, store unreachable:
 * all of them mean nothing matches, and the request is authenticated normally.
 * The only way to reach a plugin handler without a session is for all three
 * gates (declared, exclusively owned, operator-granted) to be satisfied at once
 * AND for the plugin to be live and actually serving that prefix.
 */

export interface PublicPathMountOptions {
  readonly grants: PublicPathGrantRegistry;
  readonly routes: PluginRouteRegistry;
  /**
   * Whether an unhandled path under a granted prefix terminates with 404.
   *
   * Defaults to `true` and production never passes anything else. It exists so
   * the counter-proof test can switch the guarantee OFF and demonstrate the
   * fallthrough it prevents — a test that cannot fail when the mechanism is
   * removed is not evidence that the mechanism works.
   */
  readonly terminate?: boolean;
  /** Injected for tests; defaults to `console.warn`. */
  readonly logger?: (message: string) => void;
}

/** Only these reach a plugin handler unauthenticated. Anything exotic (TRACE,
 *  CONNECT, arbitrary WebDAV verbs) goes to `requireAuth` instead — a grant is
 *  for a prefix, and widening it to every conceivable method for free is not
 *  what the operator consented to. */
const ALLOWED_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export function createPublicPathMount(
  opts: PublicPathMountOptions,
): RequestHandler {
  const terminate = opts.terminate !== false;
  const warn = opts.logger ?? ((message: string) => console.warn(message));

  return function publicPathMount(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // `req.path` excludes the query string and Express has already decoded it,
    // which is why the declaration validator forbids percent-encoding: there is
    // no second representation of the same path for a grant to disagree about.
    const match = opts.grants.resolve(req.path);
    if (!match) {
      next();
      return;
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      next();
      return;
    }

    const dispatch = opts.routes.resolvePublicDispatch(
      match.pluginId,
      req.path,
    );
    if (!dispatch) {
      // Granted, owned — and nothing live is serving it. The plugin is
      // deactivated, failed to activate, or never registered a router covering
      // its own declaration. Terminate: falling through here would hand an
      // unauthenticated request to whatever else happens to match.
      finish(req, res, next, terminate, warn, match.prefix, 'no_live_router');
      return;
    }

    dispatch.handle(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      finish(req, res, next, terminate, warn, match.prefix, 'unhandled');
    });
  };
}

function finish(
  req: Request,
  res: Response,
  next: NextFunction,
  terminate: boolean,
  warn: (message: string) => void,
  prefix: string,
  reason: 'no_live_router' | 'unhandled',
): void {
  if (!terminate) {
    // Counter-proof mode only. Never taken in production — see the
    // `terminate` option's doc comment.
    warn(
      `[public-paths] TERMINATION DISABLED — '${req.path}' falls through from granted prefix '${prefix}' (${reason})`,
    );
    next();
    return;
  }
  if (res.headersSent) return;
  res.status(404).json({
    code: 'public_path.not_found',
    message: `no handler for '${req.path}' under the public prefix '${prefix}'`,
  });
}
