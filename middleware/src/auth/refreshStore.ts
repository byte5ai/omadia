import type { SecretVault } from '../secrets/vault.js';
import { CORE_AUTH_AGENT_ID, refreshTokenKey } from './coreAuthScope.js';

/**
 * Azure AD refresh tokens, keyed by user email. The middleware never hands
 * these out; they are consumed only by requireAuth-side re-issue logic.
 *
 * Rationale for storing in-vault rather than in a cookie: the cookie stays
 * tiny (just the signed session JWT), revoke-on-logout is a one-liner
 * (`vault.purge` on the key), and a compromised cookie can't replay as the
 * user beyond the 4h access window because the refresh_token never left the
 * box.
 */
export class RefreshStore {
  constructor(private readonly vault: SecretVault) {}

  async save(email: string, refreshToken: string): Promise<void> {
    await this.vault.set(
      CORE_AUTH_AGENT_ID,
      refreshTokenKey(email),
      refreshToken,
    );
  }

  async get(email: string): Promise<string | null> {
    const value = await this.vault.get(
      CORE_AUTH_AGENT_ID,
      refreshTokenKey(email),
    );
    return value ?? null;
  }

  /**
   * Drop a single user's refresh token. We do NOT call vault.purge here
   * because purge wipes the whole `core:auth` namespace (including the
   * session signing key!). Instead, explicitly overwrite with an empty
   * string and accept that `listKeys` will still show the key — cheap, safe.
   */
  async forget(email: string): Promise<void> {
    await this.vault.set(CORE_AUTH_AGENT_ID, refreshTokenKey(email), '');
  }
}
