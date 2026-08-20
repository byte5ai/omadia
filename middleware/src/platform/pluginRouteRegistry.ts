import {
  json as expressJson,
  raw as expressRaw,
  Router as createRouter,
} from 'express';
import type { Express, RequestHandler, Router } from 'express';

/**
 * Epic #470 C6 / G3 — `body: 'raw'` exposes the untouched request bytes here.
 *
 * The augmentation lives next to the only code that writes it, so the type
 * cannot be widened without seeing what fills it.
 */
declare module 'express-serve-static-core' {
  interface Request {
    /** Untouched request bytes. Present ONLY on routes registered with
     *  `body: 'raw'`; `undefined` for `'json'` and `'none'`. */
    rawBody?: Buffer;
  }
}

/**
 * Registry for plugin-contributed Express routers.
 *
 * A plugin's `activate()` calls `ctx.routes.register(prefix, router, options)`
 * which enqueues a mount action. The kernel flushes the queue once per boot —
 * after all plugins have activated and the main Express app has been
 * fully constructed — by calling `mountAll(app)`. Subsequent registrations
 * (hot-install, hot-reactivate after a draft → install round-trip)
 * mount immediately on the same `app` instance the boot flush latched
 * onto — without that, post-boot `register()` calls would push to
 * `entries[]` but never reach Express, returning silent 404s for the
 * plugin's admin UI / webhook routes.
 *
 * Deactivation is best-effort: Express does not expose a supported "remove
 * router" primitive, so the dispose handle flips a per-entry `disposed`
 * flag that makes the router a 404-pass-through. Plugins that rely on
 * hot-remove during reinstall should re-read the prefix → router mapping
 * on subsequent activates rather than expect the old router to be gone
 * from the stack.
 *
 * Design note: we accept `unknown` at the plugin-API boundary because
 * `@omadia/plugin-api` must not depend on Express. At mount time
 * the kernel narrows to the real Router shape — a type mismatch surfaces
 * here as a loud error, not as a silent no-op.
 *
 * ── Epic #470 C6 / G2 — the per-route stack, and why its order is the feature
 *
 * `register()` composes ONE chain per entry, at registration time, and freezes
 * it onto the entry:
 *
 *     [disposed guard] → [auth] → [body parser] → [plugin router]
 *
 * **The disposed guard runs first.** A deactivated plugin's prefix must stop
 * existing before anything else happens: no session verification, no body
 * buffering, no plugin code. The tempting alternative —
 * `app.use(prefix, auth, guardedRouter)` — puts authentication OUTSIDE the
 * guard, and then a deactivated plugin's route answers **401** to an anonymous
 * caller instead of 404. That is worse in three separate ways: it keeps
 * confirming a prefix that no longer has an owner, it spends a JWT
 * verification per request for a plugin that is gone, and it makes "is this
 * plugin still installed?" externally observable through the auth response.
 * `test/platform/pluginRouteAuthBody.test.ts` pins the order with a test whose
 * assertion flips to 401 the moment the two are swapped.
 *
 * **The auth middleware is bound once per entry, here.** It is not looked up
 * per request out of a mutable map keyed by prefix or source. So there is no
 * window in which a live route's auth posture can change underneath it, and no
 * shared structure a later registration (or a hostile plugin) can mutate.
 */

/**
 * How a plugin route is authenticated.
 *
 *  - `'session'` (default) — the kernel composes the SAME `requireAuth` core
 *    mounts at `/api`, per route, inside the disposed guard. For a prefix under
 *    `/api` this is defence-in-depth (the blanket OB-106 gate already ran); for
 *    a prefix outside `/api` — `/diagrams`, `/documents`, `/p/...` — it is the
 *    only session gate there is, and before C6 those routers were unauthenticated
 *    unless they gated themselves.
 *
 *    CSRF posture: identical to core's, because it IS core's. Core protects
 *    mutating routes with a `SameSite=Lax` session cookie and no token layer
 *    (`routes/auth.ts`); a browser therefore never attaches the session to a
 *    cross-site POST. Giving plugin routes a *different* CSRF mechanism would
 *    mean two postures to keep in sync, which is how they drift apart.
 *
 *  - `'public'` — no kernel authentication; the route is reachable by anyone
 *    the C4/H1 grant machinery lets through. Only registerable beneath a prefix
 *    the plugin declared in `permissions.public_paths` (enforced in
 *    `pluginContext.ts`, which is the layer that knows the manifest).
 *
 *  - `'custom'` — same registration constraint as `'public'`; the difference is
 *    intent, and it is a documented one: the plugin asserts it authenticates
 *    every request itself (HMAC, bearer token, mTLS header). A webhook receiver
 *    verifying `X-Hub-Signature-256` over `req.rawBody` is the canonical case.
 *
 * There is deliberately no `'none'`. A plugin cannot self-declare its way out
 * of authentication: `'public'`/`'custom'` are only reachable through a
 * manifest declaration the operator consented to (`plan.md` §3 — "an
 * `auth: 'none'` option that a plugin can self-declare would be a security
 * regression").
 */
export type PluginRouteAuth = 'session' | 'public' | 'custom';

/**
 * How the request body reaches the plugin router.
 *
 *  - `'json'` (default) — parsed JSON at the same limit core's global parser
 *    uses. In production the global `express.json` has already run by the time
 *    the plugin router is reached, so the route-local parser is a pass-through;
 *    it exists so a router behaves identically when the registry is mounted on
 *    an app with no global parser (tests, embedded harnesses).
 *  - `'raw'` — untouched bytes as a `Buffer`, on `req.body` AND `req.rawBody`,
 *    at a 512 KB default limit. See {@link PLUGIN_RAW_BODY_LIMIT}. This is the
 *    ONLY mode that changes what happens before the global parser.
 *  - `'none'` — the kernel mounts no route-local parser and leaves the stream
 *    to the plugin (uploads, proxying, streaming).
 *
 *    **It does not un-mount core's global `express.json`.** A request with
 *    `Content-Type: application/json` under a `'none'` route has already been
 *    read and parsed upstream, exactly as it was before C6. `'none'` means
 *    "the kernel adds nothing here", not "nothing has touched this request".
 *    If you need the bytes as they arrived, `'raw'` is the mode that guarantees
 *    it — that is the whole reason it needs its own pre-parser mount.
 */
export type PluginRouteBody = 'json' | 'raw' | 'none';

export interface PluginRouteOptions {
  /** Default `'session'`. See {@link PluginRouteAuth}. */
  readonly auth?: PluginRouteAuth;
  /** Default `'json'`. See {@link PluginRouteBody}. */
  readonly body?: PluginRouteBody;
  /**
   * Express body-parser limit string (`'1mb'`, `'512kb'`). Defaults to
   * {@link CORE_JSON_BODY_LIMIT} for `'json'` and {@link PLUGIN_RAW_BODY_LIMIT}
   * for `'raw'`. Ignored for `'none'`.
   *
   * **Reach differs by mode, and the difference is not cosmetic.** On `'raw'`
   * this is the real, effective limit: the parse happens in the pre-`json`
   * mount, so nothing has read the stream first. On `'json'` core's global
   * parser has already run and already enforced its own 10 MB, so a larger
   * value here cannot raise the effective ceiling — the route-local parser
   * finds the body parsed and returns. Treat it as meaningful for `'raw'` and
   * as a standalone-mount convenience for `'json'`.
   */
  readonly bodyLimit?: string;
}

/** The limit core's global `express.json` uses (`index.ts`). Mirrored rather
 *  than imported: this module must not depend on the composition root. */
export const CORE_JSON_BODY_LIMIT = '10mb';

/**
 * Default limit for `body: 'raw'` — deliberately NOT the global 10 MB.
 *
 * A raw plugin route is buffered by `pluginRawBodyMount.ts` BEFORE any
 * authentication runs (it has to be: the global JSON parser would otherwise
 * drain the stream first — see that file). Anything buffered pre-auth is an
 * unauthenticated memory cost, so the default is the same 512 KB the
 * hand-rolled GitHub webhook receiver already chose for exactly this reason
 * (`plan.md` §3 G3). A plugin that genuinely needs more states it explicitly
 * via `bodyLimit`, where a reviewer can see it.
 */
export const PLUGIN_RAW_BODY_LIMIT = '512kb';

/** Late-bound accessor for the kernel's `requireAuth`. Late-bound because the
 *  registry is constructed long before the session signing key exists; called
 *  once per registration, never per request. */
export type SessionAuthResolver = () => RequestHandler | undefined;

export interface PluginRouteRegistryOptions {
  /**
   * REQUIRED. There is no "unwired" registry: a construction site that cannot
   * supply session authentication has to say so in code, by passing a resolver
   * that returns a handler it chose. Making this optional would create exactly
   * one silent failure mode — `auth: 'session'` degrading to no auth because
   * nobody wired it — and that is the failure mode this whole item exists to
   * remove.
   */
  readonly sessionAuth: SessionAuthResolver;
}

interface RouteEntry {
  prefix: string;
  router: Router;
  disposed: boolean;
  source: string;
  auth: PluginRouteAuth;
  body: PluginRouteBody;
  /** `[auth] → [body] → [router]`, composed once at registration. Never
   *  includes the disposed guard — that is always the caller's first step. */
  stack: RequestHandler;
  /** Present iff `body === 'raw'`. Handed to the pre-`express.json` mount. */
  rawParser: RequestHandler | null;
}

/** What the terminating public-path mount needs to hand a request to a plugin:
 *  the prefix the router was mounted at, plus a handler that runs it with real
 *  Express mount semantics. See {@link PluginRouteRegistry.resolvePublicDispatch}. */
export interface PluginRouteDispatch {
  readonly prefix: string;
  readonly source: string;
  /** Runs the plugin's router. Calls `next()` — and only `next()` — when the
   *  router did not handle the request, so the caller decides what "unhandled"
   *  means. The public-path mount decides it means 404, never fallthrough. */
  readonly handle: RequestHandler;
}

/** What `pluginRawBodyMount` needs: which prefix claimed the path, and the
 *  parser to run before the global JSON parser gets to it. */
export interface PluginRawBodyRoute {
  readonly prefix: string;
  readonly source: string;
  readonly parse: RequestHandler;
}

export class PluginRouteRegistry {
  private readonly entries: RouteEntry[] = [];
  private mounted = false;
  private app: Express | null = null;
  private readonly sessionAuth: SessionAuthResolver;
  /** Per-entry mini-app used by `resolvePublicDispatch`, built once and reused.
   *  Keyed on the entry object so a disposed entry's wrapper is collectable. */
  private readonly dispatchWrappers = new WeakMap<RouteEntry, RequestHandler>();

  constructor(opts: PluginRouteRegistryOptions) {
    this.sessionAuth = opts.sessionAuth;
  }

  /**
   * Register a router at the given prefix. `source` is for diagnostics —
   * typically the plugin's agentId. Returns a dispose handle that neuters
   * the router (see class docstring).
   *
   * If the boot-time flush has already happened, the entry is mounted on
   * the latched `app` immediately so hot-install plugins do not 404.
   *
   * Throws when `auth` resolves to `'session'` and the resolver has no handler
   * to give. That is a kernel wiring bug (registration running before
   * `createRequireAuth`), and it must be loud: the alternative is a route that
   * silently serves unauthenticated because the gate was not built yet.
   */
  register(
    prefix: string,
    router: unknown,
    source: string,
    options?: PluginRouteOptions,
  ): () => void {
    if (!isExpressRouter(router)) {
      throw new Error(
        `PluginRouteRegistry: '${source}' registered a non-Express router at '${prefix}' — got ${typeof router}`,
      );
    }
    if (!prefix.startsWith('/')) {
      throw new Error(
        `PluginRouteRegistry: '${source}' prefix must start with '/' (got '${prefix}')`,
      );
    }
    const auth: PluginRouteAuth = options?.auth ?? 'session';
    const body: PluginRouteBody = options?.body ?? 'json';

    let authHandler: RequestHandler | null = null;
    if (auth === 'session') {
      authHandler = this.sessionAuth() ?? null;
      if (!authHandler) {
        throw new Error(
          `PluginRouteRegistry: '${source}' registered '${prefix}' with auth:'session' but no session middleware is available yet — ` +
            'the kernel must build requireAuth before activating plugins',
        );
      }
    }

    const rawParser =
      body === 'raw'
        ? rawBodyCapture(options?.bodyLimit ?? PLUGIN_RAW_BODY_LIMIT)
        : null;
    const bodyHandler: RequestHandler | null =
      body === 'raw'
        ? rawParser
        : body === 'json'
          ? expressJson({ limit: options?.bodyLimit ?? CORE_JSON_BODY_LIMIT })
          : null;

    const stack = createRouter();
    if (authHandler) stack.use(authHandler);
    if (bodyHandler) stack.use(bodyHandler);
    stack.use(router);

    const entry: RouteEntry = {
      prefix,
      router,
      disposed: false,
      source,
      auth,
      body,
      stack: stack as unknown as RequestHandler,
      rawParser,
    };
    this.entries.push(entry);
    if (this.mounted && this.app) {
      this.mountEntry(this.app, entry);
    }
    return () => {
      entry.disposed = true;
    };
  }

  /**
   * Mount all registered routers on the given app. Idempotent: a second
   * call against the same app is a no-op (the entries from boot-time
   * remain, and any post-boot `register()` calls have already been
   * mounted via the live-mount path). A second call against a DIFFERENT
   * app re-mounts everything — useful for integration tests that swap
   * the app instance between cases.
   */
  mountAll(app: Express): void {
    if (this.mounted && this.app === app) return;
    this.mounted = true;
    this.app = app;
    for (const entry of this.entries) {
      this.mountEntry(app, entry);
    }
  }

  private mountEntry(app: Express, entry: RouteEntry): void {
    app.use(entry.prefix, guarded(entry));
  }

  /**
   * Epic #470 C4 / H1 — resolve the live router that owns `path` for `source`.
   *
   * Returns `null` when the plugin registered nothing covering that path, or
   * when the entry it did register has since been disposed. Both cases mean
   * the same thing to the caller: nobody is entitled to answer this request
   * without a session.
   *
   * The returned `handle` wraps the entry in a one-line Express `Router`
   * mounted at the entry's own prefix. That is deliberate rather than manual
   * `req.url` surgery: `req.baseUrl`/`req.url`/`req.params` rewriting and its
   * restoration on `next()` are subtle, Express already implements them
   * correctly, and a plugin router must see exactly the same request it sees
   * through the ordinary boot-time mount — otherwise the "public" path and the
   * authenticated path diverge, which is precisely the drift this whole
   * mechanism exists to prevent.
   *
   * C6: it dispatches into the entry's composed stack, not the bare router, for
   * the same reason. A route that asked for `auth: 'session'` keeps its session
   * gate even when reached through a granted public prefix, and a route that
   * asked for `body: 'raw'` keeps its raw parser. One code path, one behaviour.
   *
   * The disposed check lives INSIDE the wrapper, not just at resolve time, so
   * a plugin deactivated between resolution and dispatch still stops serving.
   */
  resolvePublicDispatch(
    source: string,
    path: string,
  ): PluginRouteDispatch | null {
    const entry = this.bestLiveEntry(path, (e) => e.source === source);
    if (!entry) return null;

    let handle = this.dispatchWrappers.get(entry);
    if (!handle) {
      const wrapper = createRouter();
      wrapper.use(entry.prefix, guarded(entry));
      handle = wrapper as unknown as RequestHandler;
      this.dispatchWrappers.set(entry, handle);
    }
    return { prefix: entry.prefix, source: entry.source, handle };
  }

  /**
   * Epic #470 C6 / G3 — the live `body: 'raw'` route owning `path`, if any.
   *
   * Read by `pluginRawBodyMount.ts`, which sits ahead of the global
   * `express.json`. Resolution is per request rather than snapshotted at boot
   * because plugins install, activate and deactivate at runtime: a snapshot
   * would keep buffering for a plugin that is gone and miss one that just
   * arrived. Disposed entries never match.
   */
  resolveRawBodyRoute(path: string): PluginRawBodyRoute | null {
    const entry = this.bestLiveEntry(path, (e) => e.rawParser !== null);
    if (!entry?.rawParser) return null;
    return {
      prefix: entry.prefix,
      source: entry.source,
      parse: entry.rawParser,
    };
  }

  /** Longest live prefix covering `path` that also satisfies `predicate`.
   *  Longest wins — a plugin registering both `/api/plugins/x` and
   *  `/api/plugins/x/hooks` must get the more specific router. */
  private bestLiveEntry(
    path: string,
    predicate: (entry: RouteEntry) => boolean,
  ): RouteEntry | null {
    let best: RouteEntry | null = null;
    for (const entry of this.entries) {
      if (entry.disposed) continue;
      if (!predicate(entry)) continue;
      if (!isUnderPrefix(path, entry.prefix)) continue;
      if (best === null || entry.prefix.length > best.prefix.length) {
        best = entry;
      }
    }
    return best;
  }

  /** Diagnostic: what routers are registered today. */
  list(): readonly {
    prefix: string;
    source: string;
    disposed: boolean;
    auth: PluginRouteAuth;
    body: PluginRouteBody;
  }[] {
    return this.entries.map((e) => ({
      prefix: e.prefix,
      source: e.source,
      disposed: e.disposed,
      auth: e.auth,
      body: e.body,
    }));
  }

  /**
   * Mark every still-active entry whose `source` matches as disposed.
   * Returns the count of entries flipped (0 when nothing matched or all
   * were already disposed). Idempotent: a second call with the same
   * source is a no-op.
   *
   * Used by the kernel on plugin deactivate as a fail-safe — plugins
   * whose `close()` body forgets to call the per-route dispose handle
   * would otherwise leave their old router in the Express stack and,
   * because Express matches first-mount-wins, serve stale responses
   * after a hot-upgrade.
   */
  disposeBySource(source: string): number {
    let count = 0;
    for (const entry of this.entries) {
      if (entry.source === source && !entry.disposed) {
        entry.disposed = true;
        count += 1;
      }
    }
    return count;
  }
}

/**
 * THE ORDER THAT MATTERS. Disposed check first, composed stack second.
 *
 * Every path into a plugin router — the boot-time mount, the hot-install
 * mount, and the C4 public dispatch — goes through this one function, so
 * "deactivated means gone before auth" is a property of the registry, not a
 * property each call site has to remember.
 */
function guarded(entry: RouteEntry): RequestHandler {
  return (req, res, next) => {
    if (entry.disposed) {
      next();
      return;
    }
    entry.stack(req, res, next);
  };
}

/**
 * `express.raw()` with a wildcard content-type matcher, plus the `req.rawBody`
 * alias.
 *
 * The matcher accepts ANY content type on purpose: a webhook sender chooses its
 * own `Content-Type` (GitHub sends `application/json`, others send
 * `application/x-www-form-urlencoded` or nothing at all) and an HMAC is
 * computed over bytes, not over a media type. Matching on type here would make
 * signature verification silently content-type dependent.
 *
 * Idempotent: when `pluginRawBodyMount` already parsed the body ahead of the
 * global JSON parser, body-parser short-circuits on its own `_body` marker and
 * `req.body` is already the Buffer this sets `rawBody` from.
 */
function rawBodyCapture(limit: string): RequestHandler {
  const parse = expressRaw({ type: '*/*', limit });
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
      }
      next();
    });
  };
}

/** `child` is `parent`, or sits beneath it on a segment boundary. Duplicated
 *  deliberately from `publicPathGrants.ts` rather than imported: this registry
 *  is a generic Express concern and must not depend on the grant machinery. */
function isUnderPrefix(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSlash = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(withSlash);
}

function isExpressRouter(value: unknown): value is Router {
  // Express routers are callable (they are RequestHandler themselves) AND
  // expose a `use` method. Duck-typing is safer than instanceof because
  // downstream versions of express bundle their own Router prototype.
  return (
    typeof value === 'function' &&
    typeof (value as { use?: unknown }).use === 'function'
  );
}
