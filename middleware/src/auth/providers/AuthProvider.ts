/**
 * Provider-agnostic auth contract. Every login mechanism (password,
 * OIDC, future Passkey/SAML/...) implements this. The router in
 * `routes/auth.ts` dispatches by `provider.id` and never branches on
 * the underlying mechanism — that's how the V1.x switch from "Entra
 * baked-in" to "Entra as plugin" stays a one-line change.
 */

/** Shape of the success result every provider returns to the router.
 *  The router writes a session cookie + persists a User row from this. */
export interface AuthSuccess {
  outcome: 'success';
  /** Stable provider-internal user id ('local' uses the email lower-
   *  cased; OIDC uses the idp `sub`/`oid`). Combined with `provider.id`
   *  forms the unique identity. */
  providerUserId: string;
  email: string;
  displayName: string;
  /** Optional refresh-token to persist into the vault for later renew.
   *  Local auth never returns one; OIDC providers do. */
  refreshToken?: string;
}

export interface AuthError {
  outcome: 'error';
  /** Machine-readable code. The router maps this to HTTP status. */
  code:
    | 'invalid_credentials'
    | 'user_disabled'
    | 'unknown_user'
    | 'idp_error'
    | 'state_mismatch'
    | 'callback_invalid';
  /** Operator-readable message. Goes into log lines, never into HTTP
   *  bodies (we surface generic errors externally to avoid user-
   *  enumeration). */
  message: string;
}

export type AuthResult = AuthSuccess | AuthError;

/**
 * #965 — outcome of re-checking an existing session's identity against the
 * IdP before `POST /api/v1/auth/renew` extends it.
 *
 *   - `ok`          the IdP still vouches for this identity.
 *   - `denied`      a definite "no": revoked/expired refresh token, disabled
 *                   account, identity mismatch, no refresh token on file.
 *                   The router answers 401 and the UI falls back to login.
 *   - `unavailable` the IdP could not be asked (network error, 5xx, 429).
 *                   Still refused (renewal fails closed) but reported as
 *                   retryable (502) rather than as a denial.
 *
 * `message` is operator-readable and goes to logs only, never into HTTP
 * bodies (same rule as `AuthError.message`).
 */
export type SessionRevalidation =
  | { outcome: 'ok' }
  | { outcome: 'denied' | 'unavailable'; message: string };

/** Marks a provider as "user submits credentials inline" — login is one
 *  POST to `/api/v1/auth/login/<id>` with a JSON body the provider
 *  knows how to read. */
export interface PasswordProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'password';
  /**
   * Verify a credential payload. The payload shape is defined by the
   * concrete provider (LocalPasswordProvider expects `{email, password}`).
   * Routers pass `req.body` as-is — providers validate.
   */
  verify(body: unknown): Promise<AuthResult>;
}

/** Marks a provider as "user redirects to an external IdP" — login is a
 *  GET to `/api/v1/auth/login/<id>/start` (returns 302) followed by an
 *  IdP-driven GET to `/api/v1/auth/login/<id>/cb`. */
export interface OidcProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'oidc';
  /**
   * Build the redirect URL + the state-cookie value the router persists
   * across the round-trip. Returns the URL plus an opaque token the
   * router stores in an HTTP-only short-lived cookie; provider hands it
   * back during `handleCallback` for verification.
   */
  beginLogin(input: { returnPath: string | null }): Promise<{
    redirectUrl: string;
    /** Opaque, must be JSON-serialisable. Router persists in PKCE_COOKIE. */
    pendingState: string;
  }>;
  /**
   * Validate the IdP's callback against the stored state and return a
   * canonical AuthResult. Caller handles cookie-clear + session-mint.
   */
  handleCallback(input: {
    query: Record<string, string | string[] | undefined>;
    pendingState: string;
  }): Promise<AuthResult>;
  /**
   * Optional logout-redirect URL the IdP wants the browser to visit so
   * the IdP-side session dies too. Returning null = router just clears
   * the local cookie and stops.
   */
  logoutUrl?(input: { postLogoutRedirect: string }): string | null;
  /**
   * #965 — re-validate an existing session against the IdP before the
   * router extends it. Optional so a provider that cannot re-check still
   * type-checks, but the router treats a missing implementation as
   * `denied`: renewing an OIDC session without an IdP re-check fails closed.
   */
  revalidateSession?(input: {
    /** Session `email` claim (lower-cased at login). */
    email: string;
    /** Session `sub` claim, the provider-internal user id. */
    providerUserId: string;
  }): Promise<SessionRevalidation>;
}

export type AuthProvider = PasswordProvider | OidcProvider;

/** Type-guard — narrows `AuthProvider` to a `PasswordProvider`. */
export function isPasswordProvider(
  p: AuthProvider,
): p is PasswordProvider {
  return p.kind === 'password';
}

/** Type-guard — narrows `AuthProvider` to an `OidcProvider`. */
export function isOidcProvider(p: AuthProvider): p is OidcProvider {
  return p.kind === 'oidc';
}

/** Provider summary shape exposed by `GET /api/v1/auth/providers` so the
 *  login UI can render the right form / button per provider. */
export interface ProviderSummary {
  id: string;
  displayName: string;
  kind: 'password' | 'oidc';
}
