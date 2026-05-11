import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  isOidcProvider,
  isPasswordProvider,
  type AuthProvider,
  type AuthSuccess,
} from '../auth/providers/AuthProvider.js';
import { hashPassword } from '../auth/passwordHasher.js';
import {
  LOCAL_PROVIDER_ID,
} from '../auth/providers/LocalPasswordProvider.js';
import { ENTRA_PROVIDER_ID } from '../auth/providers/EntraProvider.js';
import type { ProviderRegistry } from '../auth/providerRegistry.js';
import { SESSION_COOKIE } from '../auth/requireAuth.js';
import { signSession } from '../auth/sessionJwt.js';
import type { UserStore } from '../auth/userStore.js';

interface AuthDeps {
  registry: ProviderRegistry;
  userStore: UserStore;
  signingKey: Uint8Array;
  /** Public-facing base URL (scheme+host, no trailing slash). */
  publicBaseUrl: string;
  /** Where to send users after successful login if no ?return. */
  defaultReturnPath: string;
  /**
   * Set when this boot detected an empty users-table without env-seed
   * values — the /setup wizard mounts only when this is true. The route
   * additionally double-checks `userStore.count() === 0` on every call so
   * the gate stays correct even if the boot-time value drifts.
   */
  setupAllowed: boolean;
}

const PKCE_COOKIE = 'harness_auth_pkce';
const PKCE_COOKIE_MAX_AGE_S = 600;
const SESSION_COOKIE_MAX_AGE_S = 4 * 60 * 60;

/**
 * Provider-aware Auth router (OB-49a).
 *
 * Endpoints:
 *   GET  /api/v1/auth/providers        list active providers (login UI)
 *   GET  /api/v1/auth/login            back-compat: 302 → /login page
 *   POST /api/v1/auth/login/:id        password-provider form submit
 *   GET  /api/v1/auth/login/:id/start  oidc-provider redirect to IdP
 *   GET  /api/v1/auth/login/:id/cb     oidc-provider callback handler
 *   POST /api/v1/auth/logout           clear cookie + optional IdP-logout
 *   GET  /api/v1/auth/me               current session (or 401)
 *   POST /api/v1/auth/setup            first-user wizard (one-shot, 410 once locked)
 *
 * Provider mechanics live in `auth/providers/*` — the router branches
 * exactly twice (password vs. oidc) and is otherwise provider-agnostic.
 */
export function createAuthRouter(deps: AuthDeps): Router {
  const router = Router();

  // ── GET /providers ───────────────────────────────────────────────────────
  router.get('/providers', async (_req: Request, res: Response) => {
    // Setup is only "required" when ALL three hold:
    //   - boot-time `setupAllowed` flag (bootstrap detected empty users +
    //     no env-seed)
    //   - the local provider is registered (otherwise the wizard would
    //     produce a local admin we can't actually log in as)
    //   - users-table is still empty NOW (re-checked per call so the UI
    //     reflects state without a server restart)
    const localActive = deps.registry.get(LOCAL_PROVIDER_ID) !== undefined;
    const empty = (await deps.userStore.count()) === 0;
    res.json({
      providers: deps.registry.summaries(),
      setup_required: deps.setupAllowed && localActive && empty,
    });
  });

  // ── GET /login (back-compat for the Next edge middleware) ────────────────
  // The legacy Azure-flow used `GET /api/v1/auth/login` as the entry point.
  // Edge-middleware in web-ui still redirects 401s there; we forward to
  // the new web-ui `/login` page where the user picks a provider.
  router.get('/login', (req: Request, res: Response) => {
    const rawReturn =
      typeof req.query['return'] === 'string' ? req.query['return'] : undefined;
    const safeReturn = sanitiseReturnPath(rawReturn);
    const url = new URL('/login', deps.publicBaseUrl);
    if (safeReturn) url.searchParams.set('return', safeReturn);
    res.redirect(302, url.toString());
  });

  // ── POST /login/:providerId (password-providers only) ────────────────────
  router.post('/login/:providerId', async (req: Request, res: Response) => {
    const id = readParam(req, 'providerId');
    const provider = id ? deps.registry.get(id) : undefined;
    if (!provider || !isPasswordProvider(provider)) {
      res.status(404).json({ code: 'auth.unknown_provider' });
      return;
    }

    const result = await provider.verify(req.body);
    if (result.outcome === 'error') {
      res.status(httpForAuthErrorCode(result.code)).json({
        code: `auth.${result.code}`,
      });
      return;
    }

    await mintSessionAndSetCookie({
      req,
      res,
      success: result,
      provider,
      signingKey: deps.signingKey,
    });
    res.json({ ok: true, user: userPayload(result, provider) });
  });

  // ── GET /login/:providerId/start (oidc-providers only) ───────────────────
  router.get('/login/:providerId/start', async (req: Request, res: Response) => {
    const id = readParam(req, 'providerId');
    const provider = id ? deps.registry.get(id) : undefined;
    if (!provider || !isOidcProvider(provider)) {
      res.status(404).send('unknown oidc-provider');
      return;
    }
    const rawReturn =
      typeof req.query['return'] === 'string' ? req.query['return'] : undefined;
    const safeReturn = sanitiseReturnPath(rawReturn);
    const begin = await provider.beginLogin({ returnPath: safeReturn });

    res.cookie(
      pkceCookieNameFor(provider.id),
      Buffer.from(begin.pendingState).toString('base64url'),
      {
        httpOnly: true,
        secure: isSecureContext(req),
        sameSite: 'lax',
        maxAge: PKCE_COOKIE_MAX_AGE_S * 1000,
        path: '/',
      },
    );
    res.redirect(302, begin.redirectUrl);
  });

  const handleOidcCallback = async (
    providerId: string | undefined,
    req: Request,
    res: Response,
  ) => {
    const provider = providerId ? deps.registry.get(providerId) : undefined;
    if (!provider || !isOidcProvider(provider)) {
      res.status(404).send('unknown oidc-provider');
      return;
    }
    const cookies = readCookies(req);
    const cookieName = pkceCookieNameFor(provider.id);
    const raw = cookies[cookieName];
    if (!raw) {
      res.status(400).send('missing pending-state cookie (session expired?)');
      return;
    }
    let pendingState: string;
    try {
      pendingState = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
      res.status(400).send('malformed pending-state cookie');
      return;
    }

    const result = await provider.handleCallback({
      query: req.query as Record<string, string | string[] | undefined>,
      pendingState,
    });
    if (result.outcome === 'error') {
      res.status(httpForAuthErrorCode(result.code)).send(
        `auth.${result.code}: ${result.message}`,
      );
      return;
    }

    // Upsert the IdP identity into the users-table so the /setup wizard
    // gate, admin-list views, and last_login tracking all see the user.
    // Without this, a pure-OIDC deployment would leave userStore.count()
    // at 0 forever and /setup would stay unlocked — anyone could then
    // hit /setup unauthenticated and create a local admin.
    const upserted = await deps.userStore.upsertOidcIdentity({
      provider: provider.id,
      providerUserId: result.providerUserId,
      email: result.email,
      displayName: result.displayName,
    });
    void deps.userStore.markLoginNow(upserted.id).catch(() => undefined);

    res.clearCookie(cookieName, { path: '/' });
    await mintSessionAndSetCookie({
      req,
      res,
      success: result,
      provider,
      signingKey: deps.signingKey,
    });

    let returnTo = deps.defaultReturnPath;
    try {
      const parsed = JSON.parse(pendingState) as { returnPath?: unknown };
      if (typeof parsed.returnPath === 'string') {
        const safe = sanitiseReturnPath(parsed.returnPath);
        if (safe) returnTo = safe;
      }
    } catch {
      /* fall back to default */
    }
    res.redirect(302, deps.publicBaseUrl + returnTo);
  };

  // ── GET /login/:providerId/cb (oidc-providers only) ──────────────────────
  router.get('/login/:providerId/cb', async (req: Request, res: Response) => {
    await handleOidcCallback(readParam(req, 'providerId'), req, res);
  });

  // Legacy alias for the pre-OB-49a single-provider redirect URI that is
  // registered in Azure AD and pinned in the AUTH_REDIRECT_URI Fly secret.
  // Pinned to 'entra' since that was the only OIDC provider pre-refactor.
  // TODO(OB-54-followup): drop once Azure-AD redirect URI is migrated to
  // /api/v1/auth/login/entra/cb.
  router.get('/callback', async (req: Request, res: Response) => {
    await handleOidcCallback(ENTRA_PROVIDER_ID, req, res);
  });

  // ── POST /logout ─────────────────────────────────────────────────────────
  router.post('/logout', async (req: Request, res: Response) => {
    const cookies = readCookies(req);
    const token = cookies[SESSION_COOKIE];
    let providerId: string | undefined;
    if (token) {
      try {
        const { verifySession } = await import('../auth/sessionJwt.js');
        const claims = await verifySession(token, deps.signingKey);
        providerId = claims.provider;
      } catch {
        /* expired / malformed — still clear the cookie below */
      }
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });

    // Surface the IdP-side logout URL when the session was minted from an
    // oidc-provider so the SPA can bounce the browser to it. For local
    // sessions the array stays empty and the SPA just lands on /login.
    const postLogoutRedirect = `${deps.publicBaseUrl}${deps.defaultReturnPath}`;
    const logoutUrls: Array<{ provider: string; url: string }> = [];
    const candidates = providerId
      ? [deps.registry.get(providerId)].filter((p): p is AuthProvider => !!p)
      : deps.registry.list();
    for (const p of candidates) {
      if (isOidcProvider(p) && p.logoutUrl) {
        const url = p.logoutUrl({ postLogoutRedirect });
        if (url) logoutUrls.push({ provider: p.id, url });
      }
    }
    res.json({ ok: true, logout_urls: logoutUrls });
  });

  // ── GET /me ──────────────────────────────────────────────────────────────
  router.get('/me', async (req: Request, res: Response) => {
    const cookies = readCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      res.status(401).json({ code: 'auth.missing', message: 'no session' });
      return;
    }
    try {
      const { verifySession } = await import('../auth/sessionJwt.js');
      const claims = await verifySession(token, deps.signingKey);
      res.json({
        user: {
          id: claims.sub,
          email: claims.email,
          display_name: claims.display_name,
          role: claims.role,
          provider: claims.provider,
        },
      });
    } catch {
      res.status(401).json({ code: 'auth.invalid' });
    }
  });

  // ── POST /setup (one-shot first-user wizard) ─────────────────────────────
  // Returns 410 Gone in two cases:
  //   - any user already exists (one-shot lock)
  //   - the local password provider is not active (no point creating a
  //     local admin if AUTH_PROVIDERS=entra-only — that would just leave a
  //     dangling unauthenticated-creation surface for attackers).
  // The boot-time `setupAllowed` flag is the third gate, advertised in
  // /providers so the UI flips into "first-time-setup" mode only when
  // the wizard is actually usable.
  router.post('/setup', async (req: Request, res: Response) => {
    const localProvider = deps.registry.get(LOCAL_PROVIDER_ID);
    if (!localProvider) {
      res.status(410).json({
        code: 'auth.setup_no_local_provider',
        message:
          'setup wizard requires the "local" auth provider to be active in AUTH_PROVIDERS',
      });
      return;
    }
    const existing = await deps.userStore.count();
    if (existing > 0) {
      res
        .status(410)
        .json({ code: 'auth.setup_locked', message: 'setup already completed' });
      return;
    }

    const body = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      display_name?: unknown;
    };
    const email =
      typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName =
      typeof body.display_name === 'string' ? body.display_name.trim() : '';

    if (email.length === 0 || !email.includes('@')) {
      res.status(400).json({ code: 'auth.setup_invalid_email' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ code: 'auth.setup_password_too_short' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await deps.userStore.create({
      email,
      provider: LOCAL_PROVIDER_ID,
      providerUserId: email.toLowerCase(),
      passwordHash,
      displayName: displayName.length > 0 ? displayName : email,
      role: 'admin',
    });

    // Auto-login the freshly-created admin so the operator lands inside the
    // UI without a second round-trip. Mirrors the password-login cookie.
    await mintSessionAndSetCookie({
      req,
      res,
      success: {
        outcome: 'success',
        providerUserId: user.providerUserId,
        email: user.email,
        displayName: user.displayName,
      },
      provider: { id: LOCAL_PROVIDER_ID, kind: 'password' },
      signingKey: deps.signingKey,
    });
    void deps.userStore.markLoginNow(user.id).catch(() => undefined);

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        role: user.role,
        provider: user.provider,
      },
    });
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function readCookies(req: Request): Record<string, string> {
  return (
    (req as Request & { cookies?: Record<string, string> }).cookies ?? {}
  );
}

/** Express 5 types `req.params[key]` as `string | string[] | undefined`
 *  depending on the route generics. We always declared the param in the
 *  path string so a string is what arrives at runtime — but TypeScript
 *  doesn't know that. Narrow once, here. */
function readParam(req: Request, key: string): string | undefined {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function pkceCookieNameFor(providerId: string): string {
  // One pending-state cookie per provider id keeps two parallel oidc-flows
  // (e.g. user opens /login/google + /login/entra in adjacent tabs) from
  // overwriting each other.
  return `${PKCE_COOKIE}_${providerId}`;
}

function isSecureContext(req: Request): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (Array.isArray(proto)) return proto[0] === 'https';
  return proto === 'https';
}

function sanitiseReturnPath(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\n') || value.includes('\r')) return null;
  return value;
}

function httpForAuthErrorCode(code: string): number {
  switch (code) {
    case 'invalid_credentials':
    case 'user_disabled':
    case 'unknown_user':
      return 401;
    case 'state_mismatch':
    case 'callback_invalid':
      return 400;
    case 'idp_error':
    default:
      return 502;
  }
}

interface MintArgs {
  req: Request;
  res: Response;
  success: AuthSuccess;
  provider: { id: string; kind: 'password' | 'oidc' };
  signingKey: Uint8Array;
}

async function mintSessionAndSetCookie(args: MintArgs): Promise<void> {
  const session = await signSession(
    {
      sub: args.success.providerUserId,
      email: args.success.email,
      display_name: args.success.displayName,
      role: 'admin',
      provider: args.provider.id,
    },
    args.signingKey,
    `${SESSION_COOKIE_MAX_AGE_S}s`,
  );
  args.res.cookie(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: isSecureContext(args.req),
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE_S * 1000,
    path: '/',
  });
}

function userPayload(
  success: AuthSuccess,
  provider: { id: string },
): {
  id: string;
  email: string;
  display_name: string;
  role: 'admin';
  provider: string;
} {
  return {
    id: success.providerUserId,
    email: success.email,
    display_name: success.displayName,
    role: 'admin',
    provider: provider.id,
  };
}
