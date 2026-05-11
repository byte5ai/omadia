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
 * un-register middleware, so we use an indirection: every channel-owned
 * route is mounted ONCE at registration time and reads a per-channel
 * `active` flag from this registry. Deactivate flips the flag; the handler
 * short-circuits with 503 afterwards. Re-activation flips it back.
 *
 * Not the prettiest pattern, but it avoids restarting the HTTP server and
 * keeps behaviour observable in logs. When Slice 2.5 adds dynamic load/
 * unload we can swap this out for a mutable `app.use` router-swap variant.
 */

interface RegisteredRoute {
  method: HttpMethod;
  path: string;
  channelId: string;
  handler: RequestHandler;
}

export class ExpressRouteRegistry {
  private readonly routes: RegisteredRoute[] = [];
  private readonly activeByChannel = new Map<string, boolean>();

  constructor(private readonly app: Express) {}

  register(
    channelId: string,
    method: HttpMethod,
    path: string,
    handler: RequestHandler,
  ): void {
    const wrapper: RequestHandler = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (!this.activeByChannel.get(channelId)) {
        res.status(503).json({
          code: 'channel.inactive',
          message: `channel '${channelId}' is currently deactivated`,
        });
        return;
      }
      void Promise.resolve(handler(req, res, next)).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[channel:${channelId}] unhandled route error on ${method} ${path}:`,
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

    this.routes.push({ method, path, channelId, handler });
    this.activeByChannel.set(channelId, true);
    console.log(
      `[channels] route registered ${method} ${path} (channel=${channelId})`,
    );
  }

  /**
   * Register a full Router under a prefix. Same active-flag gate —
   * requests under the prefix return 503 while the channel is inactive.
   */
  registerRouter(channelId: string, prefix: string, router: Router): void {
    this.app.use(
      prefix,
      (req: Request, res: Response, next: NextFunction) => {
        if (!this.activeByChannel.get(channelId)) {
          res.status(503).json({
            code: 'channel.inactive',
            message: `channel '${channelId}' is currently deactivated`,
          });
          return;
        }
        router(req, res, next);
      },
    );
    this.activeByChannel.set(channelId, true);
    console.log(
      `[channels] router registered at ${prefix} (channel=${channelId})`,
    );
  }

  /** Activate a channel's routes. Typically called right after register. */
  setActive(channelId: string, active: boolean): void {
    this.activeByChannel.set(channelId, active);
  }

  /** Mark every route owned by this channel as inactive (returns 503). */
  deactivateChannel(channelId: string): void {
    this.activeByChannel.set(channelId, false);
    console.log(`[channels] routes deactivated (channel=${channelId})`);
  }

  /** For introspection / dev-tools. */
  describe(): Array<{ method: HttpMethod; path: string; channelId: string; active: boolean }> {
    return this.routes.map((r) => ({
      method: r.method,
      path: r.path,
      channelId: r.channelId,
      active: this.activeByChannel.get(r.channelId) ?? false,
    }));
  }
}
