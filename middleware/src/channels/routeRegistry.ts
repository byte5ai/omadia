import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';

import type { HttpMethod } from '@omadia/channel-sdk';

/**
 * Per-channel Express route mount. Express itself has no clean way to
 * un-register middleware, so we use an indirection: every channel-owned route
 * is mounted ONCE at first registration and reads its handler from a mutable
 * per-route record plus a per-channel `active` flag. Deactivate flips the flag;
 * the handler short-circuits with 503 afterwards. Re-activation flips it back,
 * and a re-registration by the same channel (hot-reinstall) rebinds the handler
 * in place rather than mounting a second, shadowed route.
 *
 * When a future slice adds dynamic load/unload we can swap this out for a
 * mutable `app.use` router-swap variant.
 */

interface RouteMount {
  method: HttpMethod;
  path: string;
  channelId: string;
  handler: RequestHandler;
}

interface RouterMount {
  prefix: string;
  channelId: string;
  router: Router;
}

export class ExpressRouteRegistry {
  /** Keyed by `${method} ${path}` — the Express dispatch key. */
  private readonly routeMounts = new Map<string, RouteMount>();
  /** Keyed by mount prefix. */
  private readonly routerMounts = new Map<string, RouterMount>();
  private readonly activeByChannel = new Map<string, boolean>();

  constructor(private readonly app: Express) {}

  register(
    channelId: string,
    method: HttpMethod,
    path: string,
    handler: RequestHandler,
  ): void {
    const key = `${method} ${path}`;
    const existing = this.routeMounts.get(key);
    if (existing) {
      if (existing.channelId !== channelId) {
        throw new Error(
          `route '${key}' already owned by channel '${existing.channelId}'`,
        );
      }
      // Same channel re-registering (hot-reinstall): rebind in place.
      // Every hot-swap path (config reactivate, version upload) deactivates
      // then re-activates the channel, which re-runs the plugin's activate()
      // and lands here. The mounted wrapper reads `mount.handler` on each
      // dispatch, so overwriting it swaps the freshly-loaded module's handler
      // in — no second, shadowing app.<method>() mount (#395).
      existing.handler = handler;
      this.activeByChannel.set(channelId, true);
      console.log(`[channels] route rebound ${key} (channel=${channelId})`);
      return;
    }

    const mount: RouteMount = { method, path, channelId, handler };
    const wrapper: RequestHandler = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (!this.activeByChannel.get(mount.channelId)) {
        this.sendChannelInactive(res, mount.channelId);
        return;
      }
      void Promise.resolve(mount.handler(req, res, next)).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[channel:${mount.channelId}] unhandled route error on ${method} ${path}:`,
          message,
        );
        if (!res.headersSent) {
          res.status(500).json({
            code: 'channel.handler_failed',
            message,
          });
        }
      });
    };

    switch (method) {
      case 'GET':
        this.app.get(path, wrapper);
        break;
      case 'POST':
        this.app.post(path, wrapper);
        break;
      case 'PUT':
        this.app.put(path, wrapper);
        break;
      case 'DELETE':
        this.app.delete(path, wrapper);
        break;
      case 'PATCH':
        this.app.patch(path, wrapper);
        break;
    }

    this.routeMounts.set(key, mount);
    this.activeByChannel.set(channelId, true);
    console.log(
      `[channels] route registered ${method} ${path} (channel=${channelId})`,
    );
  }

  /**
   * Register a full Router under a prefix. Same active-flag gate — requests
   * under the prefix return 503 while the channel is inactive. Re-registration
   * by the same channel rebinds the router in place, mirroring {@link register}.
   */
  registerRouter(channelId: string, prefix: string, router: Router): void {
    const existing = this.routerMounts.get(prefix);
    if (existing) {
      if (existing.channelId !== channelId) {
        throw new Error(
          `router prefix '${prefix}' already owned by channel '${existing.channelId}'`,
        );
      }
      existing.router = router;
      this.activeByChannel.set(channelId, true);
      console.log(`[channels] router rebound at ${prefix} (channel=${channelId})`);
      return;
    }

    const mount: RouterMount = { prefix, channelId, router };
    this.app.use(
      prefix,
      (req: Request, res: Response, next: NextFunction) => {
        if (!this.activeByChannel.get(mount.channelId)) {
          this.sendChannelInactive(res, mount.channelId);
          return;
        }
        mount.router(req, res, next);
      },
    );
    this.routerMounts.set(prefix, mount);
    this.activeByChannel.set(channelId, true);
    console.log(
      `[channels] router registered at ${prefix} (channel=${channelId})`,
    );
  }

  /** Activate a channel's routes. Typically called right after register. */
  setActive(channelId: string, active: boolean): void {
    this.activeByChannel.set(channelId, active);
  }

  private sendChannelInactive(res: Response, channelId: string): void {
    res.status(503).json({
      code: 'channel.inactive',
      message: `channel '${channelId}' is currently deactivated`,
    });
  }

  /** Mark every route owned by this channel as inactive (returns 503). */
  deactivateChannel(channelId: string): void {
    this.activeByChannel.set(channelId, false);
    console.log(`[channels] routes deactivated (channel=${channelId})`);
  }

  /** For introspection / dev-tools. */
  describe(): Array<{ method: HttpMethod; path: string; channelId: string; active: boolean }> {
    return Array.from(this.routeMounts.values()).map((r) => ({
      method: r.method,
      path: r.path,
      channelId: r.channelId,
      active: this.activeByChannel.get(r.channelId) ?? false,
    }));
  }
}
