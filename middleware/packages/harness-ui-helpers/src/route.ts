import type { Request, RequestHandler, Response } from 'express';

export interface RouteContext {
  readonly req: Request;
  readonly res: Response;
  readonly params: Request['params'];
  readonly query: Request['query'];
}

export type RouteHandler = (
  ctx: RouteContext,
) => Promise<string> | string | Promise<void> | void;

/**
 * Adapts a UI route handler that returns a complete HTML string into an
 * Express request handler. Sets iframe-safe headers automatically — plugin
 * UIs are designed to be embedded inside Teams Tabs.
 *
 * If the handler returns void/undefined it MUST have written the response
 * itself (e.g. res.redirect / res.status(...).send(...)).
 */
export function renderRoute(handler: RouteHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      withIframeSafeHeaders(res);
      const result = await handler({ req, res, params: req.params, query: req.query });
      if (res.headersSent || res.writableEnded) return;
      if (typeof result !== 'string') {
        res.status(204).end();
        return;
      }
      res.type('html').send(result);
    } catch (err) {
      next(err);
    }
  };
}

const TEAMS_FRAME_ANCESTORS = [
  "'self'",
  'https://*.teams.microsoft.com',
  'https://teams.microsoft.com',
  'https://*.office.com',
  'https://*.microsoft365.com',
];

/**
 * Sets headers required for safe iframe embedding inside Microsoft Teams
 * (and Office host apps). Idempotent — calling twice is a no-op.
 *
 * - CSP `frame-ancestors` is the modern replacement for X-Frame-Options
 *   when the embedding origin is known. Both are emitted because some
 *   legacy proxies still honor only X-Frame-Options.
 * - Tailwind's CDN-injected styles need `'unsafe-inline'` because it
 *   writes a <style> element at runtime; remove once Tailwind is built
 *   into a static bundle in Phase 2.
 */
export function withIframeSafeHeaders(res: Response): void {
  if (res.getHeader('content-security-policy')) return;
  const csp = [
    "default-src 'self' https: data: blob:",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self' 'unsafe-inline' https:",
    `frame-ancestors ${TEAMS_FRAME_ANCESTORS.join(' ')}`,
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
