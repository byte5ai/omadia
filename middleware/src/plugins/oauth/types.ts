/**
 * Plugin-OAuth-Provider abstraction (Slice 1.2c / OB-1).
 *
 * Decoupled from the operator-login OAuth client (`src/auth/oauthClient.ts`)
 * by design — see docs/harness-platform/HANDOFF-2026-05-07-OB-1-oauth-setup-fields.md
 * §5.5 for rationale.
 */

/** Tokens returned by a provider's token-endpoint. */
export interface OAuthTokens {
  /** Bearer access token (short-lived, ~1h). */
  accessToken: string;
  /** Refresh token used to mint new access tokens. May be rotated by the
   *  provider on every refresh — callers MUST persist the new value
   *  before returning the new access token to the caller. */
  refreshToken: string;
  /** ISO-8601 absolute expiry timestamp (computed at exchange time). */
  expiresAt: string;
  /** Space-separated scopes that were granted. May be a subset of the
   *  scopes that were requested. */
  scope: string;
}

/** Input for `buildAuthorizeUrl`. The state and codeChallenge are produced
 *  by the install-route, NOT by the provider. */
export interface AuthorizeUrlInput {
  /** Signed state JWT (provider just embeds it verbatim). */
  state: string;
  /** S256 code-challenge (base64url(sha256(verifier))). */
  codeChallenge: string;
  /** Scopes requested for this flow. Provider is responsible for joining
   *  these into the format its endpoint expects (space-sep for OAuth2). */
  scopes: string[];
  /** Optional locale hint for the consent screen, e.g. 'de'. */
  uiLocale?: string;
  /** The redirect URI registered with the provider. Single value across
   *  all plugins — see HANDOFF §5.4. */
  redirectUri: string;
}

/** Provider-agnostic OAuth-2 + PKCE client. Each concrete impl knows its
 *  IdP's authorize/token endpoints and any provider-specific quirks (extra
 *  query params, token-response field naming, etc). */
export interface PluginOAuthProvider {
  /** Stable id used in plugin manifests' `provider:` field and in the
   *  signed-state `providerId` claim. Lower-snake-case, e.g. 'microsoft365'. */
  readonly id: string;

  /** Human-readable label for the Connect-button. */
  readonly displayName: string;

  /** Build the authorization URL the operator's browser is sent to. */
  buildAuthorizeUrl(input: AuthorizeUrlInput): string;

  /** Exchange an authorization code for tokens. `codeVerifier` is the
   *  raw verifier (NOT the challenge) that produced the challenge in
   *  `buildAuthorizeUrl`. */
  exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    scopes: string[],
  ): Promise<OAuthTokens>;

  /** Use a refresh token to mint a fresh access token. The returned
   *  tokens MAY include a rotated refresh token — caller must persist
   *  it before returning the access token (atomic RT-rotation, see
   *  HANDOFF §5.2). */
  refreshAccessToken(
    refreshToken: string,
    scopes: string[],
  ): Promise<OAuthTokens>;
}

/** Factory that turns an integration-plugin's config into a concrete
 *  provider instance. Lazy by design so the install-route can resolve
 *  config from the dependency-graph at job-start time, not at boot.
 *  See HANDOFF §5.3.
 *
 *  The config is `unknown` at the registry level — each factory narrows
 *  it internally. This keeps the registry shape provider-agnostic. */
export type ProviderFactory = (config: unknown) => PluginOAuthProvider;
