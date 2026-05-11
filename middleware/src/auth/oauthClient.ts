import crypto from 'node:crypto';

/**
 * Thin wrapper around Azure AD v2.0 OIDC. We hand-roll this rather than
 * pulling @azure/msal-node because the whole dance is three URLs and a POST;
 * the MSAL surface is built for SPA/cache scenarios we don't need.
 */

export interface OAuthClientOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthorizeUrlInput {
  state: string;
  codeChallenge: string;
  /** Azure AD-supported locale, e.g. 'de'. Improves consent-screen UX. */
  uiLocale?: string;
}

export interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token: string | null;
  expires_in: number;
  token_type: 'Bearer';
  scope: string;
}

export interface IdTokenClaims {
  /** Stable per-user GUID within the tenant. */
  oid: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  tid: string;
}

const SCOPE = ['openid', 'profile', 'email', 'offline_access', 'User.Read'].join(' ');

export class OAuthClient {
  constructor(private readonly opts: OAuthClientOptions) {}

  get authorizeEndpoint(): string {
    return `https://login.microsoftonline.com/${this.opts.tenantId}/oauth2/v2.0/authorize`;
  }

  get tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${this.opts.tenantId}/oauth2/v2.0/token`;
  }

  get logoutEndpoint(): string {
    return `https://login.microsoftonline.com/${this.opts.tenantId}/oauth2/v2.0/logout`;
  }

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      response_type: 'code',
      redirect_uri: this.opts.redirectUri,
      response_mode: 'query',
      scope: SCOPE,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    if (input.uiLocale) {
      params.set('ui_locales', input.uiLocale);
    }
    return `${this.authorizeEndpoint}?${params.toString()}`;
  }

  buildLogoutUrl(postLogoutRedirect: string): string {
    const params = new URLSearchParams({
      post_logout_redirect_uri: postLogoutRedirect,
    });
    return `${this.logoutEndpoint}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
      code_verifier: codeVerifier,
      scope: SCOPE,
    });
    return await this.postToken(body);
  }

  async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPE,
    });
    return await this.postToken(body);
  }

  private async postToken(body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`azure-ad token endpoint ${res.status}: ${text}`);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const at = parsed['access_token'];
    const it = parsed['id_token'];
    const rt = parsed['refresh_token'];
    const expires = parsed['expires_in'];
    if (typeof at !== 'string' || typeof it !== 'string') {
      throw new Error('azure-ad token response missing access_token/id_token');
    }
    return {
      access_token: at,
      id_token: it,
      refresh_token: typeof rt === 'string' ? rt : null,
      expires_in: typeof expires === 'number' ? expires : 0,
      token_type: 'Bearer',
      scope: typeof parsed['scope'] === 'string' ? parsed['scope'] : SCOPE,
    };
  }
}

/**
 * Decode (NOT verify) an id_token to surface the claims Azure sent back.
 *
 * We skip signature verification here because the token was just delivered
 * over TLS from the token endpoint we trust — there is no third-party channel
 * the attacker could tamper it on. Full JWKS verification would be required
 * if we accepted tokens from the client.
 */
export function decodeIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('invalid id_token shape');
  }
  const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = payloadB64.length % 4;
  const padded = pad ? payloadB64 + '='.repeat(4 - pad) : payloadB64;
  const json = Buffer.from(padded, 'base64').toString('utf8');
  const raw = JSON.parse(json) as Record<string, unknown>;
  const oid = typeof raw['oid'] === 'string' ? raw['oid'] : '';
  const tid = typeof raw['tid'] === 'string' ? raw['tid'] : '';
  if (!oid || !tid) {
    throw new Error('id_token missing oid/tid');
  }
  return {
    oid,
    tid,
    ...(typeof raw['email'] === 'string' ? { email: raw['email'] } : {}),
    ...(typeof raw['preferred_username'] === 'string'
      ? { preferred_username: raw['preferred_username'] }
      : {}),
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
  };
}

export function pickEmail(claims: IdTokenClaims): string | null {
  if (claims.email) return claims.email.toLowerCase();
  if (claims.preferred_username && claims.preferred_username.includes('@')) {
    return claims.preferred_username.toLowerCase();
  }
  return null;
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}
