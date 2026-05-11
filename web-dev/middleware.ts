import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'omadia_session';

/**
 * Edge-middleware — gates every page + API call on the Harness Admin UI.
 *
 * Rules:
 *   - `/login`, `/setup`, and `/bot-api/v1/auth/*` pass through (the auth
 *     UI itself + the login/logout/callback endpoints must be reachable
 *     without a session).
 *   - `/_next/*`, static assets, and Next's own route handlers pass through.
 *   - Everything else requires a `harness_session` cookie. If absent, we
 *     redirect to `/login?return=<encoded original path>` — that page
 *     resolves the active providers and either renders the form or kicks
 *     the user into an OIDC redirect.
 *
 * Important: we only check for cookie *presence*, not validity. The
 * middleware-side `requireAuth` guard verifies the JWT — that's the
 * authoritative check. Doing a second JWT verify here would need the signing
 * key on the edge and duplicate the gate logic; not worth it.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get(SESSION_COOKIE);
  if (sessionCookie && sessionCookie.value) {
    return NextResponse.next();
  }

  const returnPath = pathname + search;
  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('return', returnPath);
  return NextResponse.redirect(loginUrl, 302);
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname === '/setup') return true;
  if (pathname.startsWith('/bot-api/v1/auth/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/api/')) return true;
  // Fly.io health-check target — must be un-gated so a cold machine can
  // answer 200 before the first user has logged in.
  if (pathname === '/health') return true;
  // Static-public prefixes. Extend if we add more top-level public URLs.
  if (pathname === '/favicon.ico') return true;
  return false;
}

export const config = {
  // Run on every request path except the common static-asset shapes.
  // Keeping the matcher broad (with early `isPublicPath` returns above) is
  // less fragile than trying to enumerate every guarded page.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
