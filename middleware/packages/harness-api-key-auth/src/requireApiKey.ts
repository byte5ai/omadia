/**
 * Issue #439 — `requireApiKey`: the mountable authentication middleware for
 * server-to-server callers.
 *
 * omadia's auth model was built around human-bound sessions (`omadia_session`
 * cookie → `createRequireAuth`). A Laravel/PHP integration calling omadia from
 * its own server has no human behind it and no cookie to present. This
 * middleware is the second authentication method: any Express route — kernel
 * or plugin — can mount it and be authenticated by a bearer API key instead.
 *
 * It deliberately does NOT populate `req.session`. A `SessionClaims` value
 * means "a human logged in and these are their claims"; synthesizing one for
 * a machine would make every downstream `req.session`-reading route silently
 * treat a key as an operator (`role: 'admin'` is hard-typed on those claims).
 * The principal lands on its own `req.apiKey` so a route has to opt in.
 *
 * Error shape follows the public API surface issue #438 established
 * (`{ error, message }`), NOT the kernel session gate's `{ code, message }` —
 * these routes answer API clients, and `POST /api/public/v1/chat`'s wire
 * format must not change.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { ApiKeyScope } from './apiKeyScopes.js';
import { hasScope } from './apiKeyScopes.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import type { AuditLog, AuditStatus } from './auditLog.js';
import type { RateLimiter } from './rateLimiter.js';

/** The authenticated machine caller, attached to the request. */
export interface ApiKeyPrincipal {
  readonly keyId: string;
  readonly label?: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly rateLimitPerMinute: number;
  /**
   * Records one audit entry for THIS request. Fire-and-forget — a logging
   * failure must never fail the caller's request. The middleware itself
   * audits only the outcomes it produces (`rate_limited`, `forbidden`); the
   * route handler owns its own outcome, because only it knows whether the
   * work actually succeeded.
   */
  readonly audit: (status: AuditStatus) => void;
}

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKeyPrincipal;
  }
}

export interface RequireApiKeyOptions {
  readonly apiKeys: ApiKeyStore;
  /** Optional — omit to authenticate without enforcing a per-key quota. */
  readonly rateLimiter?: RateLimiter;
  /** Optional — omit to authenticate without a usage trail. */
  readonly auditLog?: AuditLog;
  /** Scope the guarded routes require. Omit to require authentication only. */
  readonly scope?: ApiKeyScope;
  /** Value recorded as `route` in audit entries. Defaults to `req.path`,
   *  which is relative to the router's mount point and therefore stable. */
  readonly routeLabel?: string;
}

/** `Authorization: Bearer <token>` → the token, or undefined. */
export function bearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

export function requireApiKey(opts: RequireApiKeyOptions): RequestHandler {
  return async function requireApiKeyHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'missing Authorization: Bearer <api-key> header',
      });
      return;
    }

    const key = await opts.apiKeys.verify(token);
    if (!key) {
      res.status(401).json({ error: 'unauthorized', message: 'invalid or revoked API key' });
      return;
    }

    // From here on the caller is AUTHENTICATED, so every outcome is
    // attributable to a key and worth auditing. Unauthenticated rejections
    // above are deliberately not audited — there is no caller identity that
    // would make such an entry meaningful.
    const route = opts.routeLabel ?? req.path;
    const audit = (status: AuditStatus): void => {
      if (!opts.auditLog) return;
      void opts.auditLog.record({
        keyId: key.id,
        route,
        method: req.method,
        at: Date.now(),
        status,
      });
    };

    if (opts.rateLimiter && !opts.rateLimiter.tryConsume(key.id, key.rateLimitPerMinute)) {
      audit('rate_limited');
      res.status(429).json({
        error: 'rate_limited',
        message: `this key is limited to ${key.rateLimitPerMinute} requests/minute`,
      });
      return;
    }

    // Scope is checked AFTER the rate limit on purpose: a caller probing for
    // scopes it doesn't have should burn quota like any other request.
    if (opts.scope !== undefined && !hasScope(key.scopes, opts.scope)) {
      audit('forbidden');
      res.status(403).json({
        error: 'forbidden',
        message: `this API key is not scoped for '${opts.scope}'`,
      });
      return;
    }

    req.apiKey = {
      keyId: key.id,
      ...(key.label ? { label: key.label } : {}),
      scopes: key.scopes,
      rateLimitPerMinute: key.rateLimitPerMinute,
      audit,
    };
    next();
  };
}
