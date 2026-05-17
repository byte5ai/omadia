import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'omadia_session';

/**
 * Edge-middleware — gates every page + API call on the Admin UI.
 *
 * Rules:
 *   - `/login`, `/setup`, and `/bot-api/v1/auth/*` pass through (the auth
 *     UI itself + the login/logout/callback endpoints must be reachable
 *     without a session).
 *   - `/_next/*`, static assets, and Next's own route handlers pass through.
 *   - Everything else requires an `omadia_session` cookie carrying an
 *     unexpired JWT. We decode-only (no signature verify — backend's
 *     `requireAuth` is the authoritative check), so a stale/expired or
 *     malformed cookie bounces to `/login?return=<encoded original path>`
 *     instead of rendering a broken page that 401s on every API call.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get(SESSION_COOKIE);
  const hasFreshSession =
    sessionCookie?.value && !isJwtExpiredOrMalformed(sessionCookie.value);
  if (hasFreshSession) {
    const forwarded = new Headers(req.headers);
    forwarded.set('x-pathname', pathname);
    return NextResponse.next({ request: { headers: forwarded } });
  }

  const returnPath = pathname + search;
  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('return', returnPath);
  const response = NextResponse.redirect(loginUrl, 302);
  if (sessionCookie?.value) {
    response.cookies.delete(SESSION_COOKIE);
  }
  return response;
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname === '/setup') return true;
  if (pathname.startsWith('/bot-api/v1/auth/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  // Fly.io health-check target — must be un-gated so a cold machine can
  // answer 200 before the first user has logged in.
  if (pathname === '/health') return true;
  if (pathname === '/favicon.ico') return true;
  // Plugin-served UI surfaces (Teams Tabs iframe these from the bot-app
  // shell; there is no omadia_session cookie in that context, only a
  // Teams SSO token in the iframe runtime). The next.config rewrite
  // forwards `/p/:path*` to middleware where the plugin handler runs
  // its own auth strategy. Bouncing to /login here would render the
  // operator login form inside the Tab iframe.
  if (pathname.startsWith('/p/')) return true;
  return false;
}

/**
 * Decode the JWT payload (no signature verification) and check the `exp`
 * claim. Returns true if the token is malformed or already expired — in
 * either case we treat it as no-session and bounce to /login. Backend's
 * `requireAuth` performs full HMAC verification on every API call.
 */
function isJwtExpiredOrMalformed(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return true;
  const payloadSegment = parts[1];
  if (!payloadSegment) return true;
  try {
    const b64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export const config = {
  // Run on every request path except the common static-asset shapes.
  // Keeping the matcher broad (with early `isPublicPath` returns above) is
  // less fragile than trying to enumerate every guarded page.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
