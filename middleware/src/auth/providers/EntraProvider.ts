import type { OAuthClient } from '../oauthClient.js';
import {
  decodeIdToken,
  generatePkcePair,
  generateState,
  pickEmail,
} from '../oauthClient.js';
import type { RefreshStore } from '../refreshStore.js';
import type { EmailWhitelist } from '../whitelist.js';
import type { AuthResult, OidcProvider } from './AuthProvider.js';

/**
 * Adapter that exposes the existing Azure-AD `OAuthClient` through the
 * provider-agnostic `OidcProvider` interface.
 *
 * Why an adapter, not a rewrite: the OAuthClient already encapsulates the
 * Azure-specific URL building + PKCE + token-exchange. The provider layer
 * only needs the begin/handleCallback/logoutUrl shape — wrapping is a
 * one-file change with zero behavioural drift in the production path.
 *
 * Pre-V1.x this lives in the OSS repo. V1.x extracts to a separate
 * `harness-auth-entra` plugin package; the AuthProvider interface stays
 * stable so the routes/registry don't change.
 */

export const ENTRA_PROVIDER_ID = 'entra';

interface PendingState {
  /** Anti-CSRF state value the IdP echoes back. */
  state: string;
  /** PKCE verifier — kept opaque to the router, used only here. */
  verifier: string;
  /** Optional same-origin return path the user wanted to land on. */
  returnPath: string | null;
}

interface EntraProviderDeps {
  oauth: OAuthClient;
  refreshStore: RefreshStore;
  /** Same Azure-tenant whitelist the legacy flow used. Empty list = every
   *  IdP-authenticated user is rejected — admins must opt-in by editing
   *  ADMIN_ALLOWED_EMAILS. */
  whitelist: EmailWhitelist;
  /** Azure AD UI locale, e.g. 'de'. Forwarded into the authorize URL. */
  uiLocale?: string;
}

export class EntraProvider implements OidcProvider {
  readonly id = ENTRA_PROVIDER_ID;
  readonly displayName = 'Microsoft / Entra ID';
  readonly kind = 'oidc' as const;

  constructor(private readonly deps: EntraProviderDeps) {}

  async beginLogin(input: {
    returnPath: string | null;
  }): Promise<{ redirectUrl: string; pendingState: string }> {
    const state = generateState();
    const pkce = generatePkcePair();
    const url = this.deps.oauth.buildAuthorizeUrl({
      state,
      codeChallenge: pkce.challenge,
      ...(this.deps.uiLocale ? { uiLocale: this.deps.uiLocale } : {}),
    });
    const pending: PendingState = {
      state,
      verifier: pkce.verifier,
      returnPath: input.returnPath,
    };
    return {
      redirectUrl: url,
      pendingState: JSON.stringify(pending),
    };
  }

  async handleCallback(input: {
    query: Record<string, string | string[] | undefined>;
    pendingState: string;
  }): Promise<AuthResult> {
    let pending: PendingState;
    try {
      pending = JSON.parse(input.pendingState) as PendingState;
    } catch {
      return {
        outcome: 'error',
        code: 'callback_invalid',
        message: 'pending-state cookie was not valid JSON',
      };
    }
    if (
      typeof pending.state !== 'string' ||
      typeof pending.verifier !== 'string'
    ) {
      return {
        outcome: 'error',
        code: 'callback_invalid',
        message: 'pending-state cookie missing state or verifier',
      };
    }

    const queryState = pickFirst(input.query['state']);
    if (queryState !== pending.state) {
      return {
        outcome: 'error',
        code: 'state_mismatch',
        message: 'oauth state mismatch — possible CSRF, refusing',
      };
    }
    const code = pickFirst(input.query['code']);
    if (!code) {
      const idpError = pickFirst(input.query['error']) ?? 'no code in callback';
      return {
        outcome: 'error',
        code: 'idp_error',
        message: `entra returned no auth code: ${idpError}`,
      };
    }

    let tokens;
    try {
      tokens = await this.deps.oauth.exchangeCode(code, pending.verifier);
    } catch (err) {
      return {
        outcome: 'error',
        code: 'idp_error',
        message:
          err instanceof Error ? err.message : 'exchangeCode failed (unknown)',
      };
    }

    const claims = decodeIdToken(tokens.id_token);
    const email = pickEmail(claims);
    if (!email) {
      return {
        outcome: 'error',
        code: 'idp_error',
        message: 'id_token has no email/preferred_username claim',
      };
    }
    if (!this.deps.whitelist.isAllowed(email)) {
      return {
        outcome: 'error',
        code: 'unknown_user',
        message: `email ${email} is not on the entra whitelist`,
      };
    }

    if (tokens.refresh_token) {
      await this.deps.refreshStore.save(email, tokens.refresh_token);
    }

    return {
      outcome: 'success',
      providerUserId: claims.oid,
      email,
      displayName: claims.name ?? email,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    };
  }

  logoutUrl(input: { postLogoutRedirect: string }): string | null {
    return this.deps.oauth.buildLogoutUrl(input.postLogoutRedirect);
  }
}

function pickFirst(
  v: string | string[] | undefined,
): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
