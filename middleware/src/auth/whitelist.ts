/**
 * Email whitelist — only people in here can mint a session.
 *
 * Source is the `ADMIN_ALLOWED_EMAILS` Fly secret (comma-separated). We
 * keep it out of the vault on purpose: the vault key that decrypts creds is
 * itself a Fly secret, so storing the whitelist alongside would make a
 * misplaced VAULT_KEY a self-lockout if decryption ever failed at boot. The
 * secret-layer is orthogonal to the access-layer.
 */

export class EmailWhitelist {
  private readonly allowed: Set<string>;

  constructor(raw: string | undefined) {
    const entries = (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && s.includes('@'));
    this.allowed = new Set(entries);
  }

  isEmpty(): boolean {
    return this.allowed.size === 0;
  }

  isAllowed(email: string): boolean {
    return this.allowed.has(email.toLowerCase());
  }

  size(): number {
    return this.allowed.size;
  }
}
