/**
 * Microsoft Graph OAuth provider (Calendar, Mail, Teams, …).
 *
 * Sole concrete implementation in P1. Talks to Azure AD's v2.0 endpoints,
 * accepts the dynamic scopes the plugin manifest declares (Calendar uses
 * `Calendars.Read User.Read offline_access`; Mail will use a different
 * set). `offline_access` is what causes Microsoft to issue a refresh
 * token — DO NOT drop it from the scope list, else getAccessToken() can
 * never refresh.
 *
 * Config comes from the operator's `de.byte5.integration.microsoft365`
 * install (HANDOFF §5.3). The factory at module bottom narrows the
 * type-erased registry config payload.
 */

import type {
  AuthorizeUrlInput,
  OAuthTokens,
  PluginOAuthProvider,
  ProviderFactory,
} from './types.js';

export const MS365_PROVIDER_ID = 'microsoft365';

export interface MicrosoftGraphProviderConfig {
  /** Azure AD tenant id. `common` and `organizations` work for multi-
   *  tenant apps; we usually use a single-tenant id from the operator's
   *  app-registration. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

export class MicrosoftGraphProvider implements PluginOAuthProvider {
  readonly id = MS365_PROVIDER_ID;
  readonly displayName = 'Microsoft 365';

  constructor(
    private readonly config: MicrosoftGraphProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get authorizeEndpoint(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/authorize`;
  }

  get tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
  }

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: input.scopes.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    if (input.uiLocale) params.set('ui_locales', input.uiLocale);
    return `${this.authorizeEndpoint}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    scopes: string[],
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: scopes.join(' '),
    });
    return await this.postToken(body);
  }

  async refreshAccessToken(
    refreshToken: string,
    scopes: string[],
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    });
    return await this.postToken(body);
  }

  private async postToken(body: URLSearchParams): Promise<OAuthTokens> {
    const res = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`microsoft365 token endpoint ${res.status}: ${text}`);
    }
    let parsed: RawTokenResponse;
    try {
      parsed = JSON.parse(text) as RawTokenResponse;
    } catch {
      throw new Error('microsoft365 token endpoint returned non-JSON');
    }
    const accessToken =
      typeof parsed.access_token === 'string' ? parsed.access_token : '';
    const refreshToken =
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
    const expiresInRaw = parsed.expires_in;
    const expiresIn =
      typeof expiresInRaw === 'number'
        ? expiresInRaw
        : typeof expiresInRaw === 'string'
          ? Number(expiresInRaw)
          : NaN;
    const scope = typeof parsed.scope === 'string' ? parsed.scope : '';
    if (!accessToken) {
      throw new Error('microsoft365 token response missing access_token');
    }
    if (!refreshToken) {
      throw new Error(
        'microsoft365 token response missing refresh_token (did the manifest forget offline_access?)',
      );
    }
    if (!Number.isFinite(expiresIn)) {
      throw new Error('microsoft365 token response missing expires_in');
    }
    const expiresAt = new Date(this.now() + expiresIn * 1000).toISOString();
    return { accessToken, refreshToken, expiresAt, scope };
  }
}

/** Factory used by the OAuthProviderRegistry. Type-erased at registration
 *  time, narrowed here so a misconfigured MS365-integration fails loudly
 *  instead of silently. */
export const microsoftGraphProviderFactory: ProviderFactory = (config) => {
  if (!config || typeof config !== 'object') {
    throw new Error('microsoft365 provider needs a config object');
  }
  const c = config as Record<string, unknown>;
  const tenantId = typeof c['tenantId'] === 'string' ? c['tenantId'] : '';
  const clientId = typeof c['clientId'] === 'string' ? c['clientId'] : '';
  const clientSecret =
    typeof c['clientSecret'] === 'string' ? c['clientSecret'] : '';
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'microsoft365 provider config requires tenantId, clientId, clientSecret',
    );
  }
  return new MicrosoftGraphProvider({ tenantId, clientId, clientSecret });
};
