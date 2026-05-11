import type { Express, RequestHandler, Router } from 'express';

/**
 * Registry for plugin-contributed Express routers.
 *
 * A plugin's `activate()` calls `ctx.routes.register(prefix, router)` which
 * enqueues a mount action. The kernel flushes the queue once per boot —
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
 */

interface RouteEntry {
  prefix: string;
  router: Router;
  disposed: boolean;
  source: string;
}

export class PluginRouteRegistry {
  private readonly entries: RouteEntry[] = [];
  private mounted = false;
  private app: Express | null = null;

  /**
   * Register a router at the given prefix. `source` is for diagnostics —
   * typically the plugin's agentId. Returns a dispose handle that neuters
   * the router (see class docstring).
   *
   * If the boot-time flush has already happened, the entry is mounted on
   * the latched `app` immediately so hot-install plugins do not 404.
   */
  register(prefix: string, router: unknown, source: string): () => void {
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
    const entry: RouteEntry = {
      prefix,
      router,
      disposed: false,
      source,
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
    const guardedRouter: RequestHandler = (req, res, next) => {
      if (entry.disposed) {
        next();
        return;
      }
      entry.router(req, res, next);
    };
    app.use(entry.prefix, guardedRouter);
  }

  /** Diagnostic: what routers are registered today. */
  list(): readonly { prefix: string; source: string; disposed: boolean }[] {
    return this.entries.map((e) => ({
      prefix: e.prefix,
      source: e.source,
      disposed: e.disposed,
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

function isExpressRouter(value: unknown): value is Router {
  // Express routers are callable (they are RequestHandler themselves) AND
  // expose a `use` method. Duck-typing is safer than instanceof because
  // downstream versions of express bundle their own Router prototype.
  return (
    typeof value === 'function' &&
    typeof (value as { use?: unknown }).use === 'function'
  );
}
