import type { NextRequest } from 'next/server';

/**
 * Runtime reverse proxy to the middleware — the server half of the
 * same-origin API surface (browser → /bot-api/* → middleware /api/*).
 *
 * /bot-api/* and /p/* used to be next.config.ts rewrites. Next evaluates
 * rewrites() at BUILD time and freezes the destinations into
 * routes-manifest.json, so the published Docker image had the compose
 * hostname (http://middleware:8080) baked in and silently ignored the
 * runtime MIDDLEWARE_URL on every other platform (Fly, Render, bare VMs):
 * every browser call through the proxy failed with ENOTFOUND → 500.
 * These handlers resolve MIDDLEWARE_URL per request instead, so one image
 * runs anywhere.
 *
 * Streaming passes through untouched in both directions (SSE spec-event
 * streams, multi-megabyte plugin-ZIP uploads). WebSockets are NOT proxied
 * here — route handlers cannot upgrade a connection; nothing in the web-ui
 * connects via WS on its own origin (the canvas WS goes to the middleware
 * directly).
 */

/** Hop-by-hop headers never travel through a proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type RouteContext = { params: Promise<{ path?: string[] }> };

export function createMiddlewareProxy(
  targetPrefix: '/api' | '/p',
): (req: NextRequest, ctx: RouteContext) => Promise<Response> {
  return async function proxy(req, ctx) {
    // Resolved per request, never at module scope — module scope would
    // re-freeze the value at boot and reintroduce a flavour of the bug.
    const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
    const { path = [] } = await ctx.params;
    const target =
      base +
      targetPrefix +
      path.map((segment) => `/${encodeURIComponent(segment)}`).join('') +
      req.nextUrl.search;

    const headers = new Headers();
    req.headers.forEach((value, key) => {
      // `host` must be the upstream's own; fetch derives it from the URL.
      if (HOP_BY_HOP.has(key) || key === 'host') return;
      headers.set(key, value);
    });

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Redirects (e.g. the OAuth broker) pass through to the browser
      // unchanged, mirroring the old rewrite behaviour.
      redirect: 'manual',
      cache: 'no-store',
      signal: req.signal,
      // Node requires the half-duplex opt-in to stream request bodies.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);

    const resHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key)) return;
      // fetch already decoded the body; the upstream's encoding headers
      // would corrupt the re-served response.
      if (key === 'content-encoding' || key === 'content-length') return;
      // Multi-valued; folded by forEach. Re-added individually below.
      if (key === 'set-cookie') return;
      resHeaders.set(key, value);
    });
    for (const cookie of upstream.headers.getSetCookie()) {
      resHeaders.append('set-cookie', cookie);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  };
}
