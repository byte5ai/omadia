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

/**
 * `X-Forwarded-Proto` is the proxy's statement about the connection IT
 * accepted, so it is this handler's to make, not the browser's to pass
 * through (#1310, security-architecture §10o). Relaying the client's value let
 * a browser decide the scheme the middleware believed, and with it the `Secure`
 * flag on its own session cookie — the middleware trusts this hop where an
 * operator names it, and would have trusted a forged value with it.
 *
 * `WEB_UI_PUBLIC_SCHEME` is a DECLARATION, not a derivation, because a Route
 * Handler cannot observe its own TLS state. There is no socket on
 * `NextRequest`, and `req.nextUrl.protocol` is no help: next builds the request
 * URL's protocol FROM the very header in question
 * (`next/dist/server/next-server.js`: `req.headers['x-forwarded-proto']
 * ?.includes('https') ? 'https' : 'http'`, with `base-server.js` only
 * `??=`-defaulting it when absent). Deriving from it would launder the
 * browser's value straight back in — and a test built with
 * `new NextRequest('https://…')` would not notice, because that sets the URL
 * literally.
 *
 *   http          (the default) this hop accepted plain HTTP. Right wherever
 *                 the browser reaches the web-ui directly — the compose stack.
 *   https         this hop sits behind a TLS-terminating edge. Fly, Render.
 *   trust-header  relay the incoming value; the operator asserts that only a
 *                 trusted edge can set it.
 */
function forwardedProto(req: NextRequest): 'http' | 'https' {
  const declared = process.env['WEB_UI_PUBLIC_SCHEME']?.trim().toLowerCase();
  if (declared === 'https' || declared === 'http') return declared;
  if (declared === 'trust-header') {
    const inbound = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (inbound === 'https' || inbound === 'http') return inbound;
  }
  return 'http';
}

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
      // Set below from this hop's own connection, never relayed.
      if (key === 'x-forwarded-proto') return;
      headers.set(key, value);
    });
    headers.set('x-forwarded-proto', forwardedProto(req));

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
