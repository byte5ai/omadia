/**
 * Custody of the tenant's delegated Teams token set (byte5ai/omadia#924).
 *
 * WHERE IT LIVES, AND WHY NOT A TABLE. `agent_teams_identities` was built with
 * "NO SECRET MATERIAL" written across its header: the bot's client secret is a
 * ref into a vault, never a column. An access token and a refresh token are
 * strictly more dangerous than that client secret — they are bearer
 * credentials for a signed-in global admin — so putting them in a Postgres
 * column would invert the posture the rest of this feature already holds.
 *
 * The precedent this follows is `services/mcpRegistrySecretService.ts`: a
 * vault NAMESPACE per concern, a key inside it, and a thin typed service in
 * front. The vault is `FileSecretVault` (AES-256-GCM at rest, master key from
 * `VAULT_KEY`), the same one that holds MCP registry bearer tokens and MCP
 * server config secrets. Nothing new is invented here.
 *
 * ONE RECORD, BECAUSE ONE TENANT. The whole point of #924 is that an admin
 * signs in ONCE and every agent provisioned afterwards rides on that sign-in —
 * so the record is per TENANT, emphatically not per agent. And a given omadia
 * install provisions into ONE customer tenant: every app registration it
 * creates is `AzureADMyOrg` single-tenant (`assertSingleTenantInput` in
 * `platform/teamsProvisionerService.ts` enforces it), and the connector
 * contract takes exactly one `DelegatedTokenSet` per call with no tenant
 * selector anywhere. So there is one key. The tenant id travels INSIDE the
 * record, which is what makes {@link TeamsDelegatedTokenStore.read} able to
 * notice a record belonging to a different tenant instead of silently using
 * credentials for the wrong directory.
 *
 * WHAT LEAVES THIS MODULE. `read` returns the full set — its only callers are
 * the job runner (which hands it straight to the connector) and the sign-in
 * service (which refreshes it). Everything operator-facing goes through
 * {@link TeamsDelegatedTokenStore.describe}, which answers the question "is
 * someone signed in, who, until when" WITHOUT the values. A route that wants
 * to render sign-in state has no reason to touch `read`, and this is where
 * that is made structural rather than a convention.
 */

import {
  isAccessTokenExpiring,
  summarizeTokenSet,
  type DelegatedTokenSet,
  type DelegatedTokenSummary,
} from './teamsDelegatedSignIn.js';

/** The vault facet this store needs — satisfied by `SecretVault`. */
export interface DelegatedTokenVault {
  get(namespace: string, key: string): Promise<string | undefined>;
  set(namespace: string, key: string, value: string): Promise<void>;
  deleteKey(namespace: string, key: string): Promise<void>;
}

/** Vault namespace, mirroring `@omadia/mcp-registry`'s convention. */
export const TEAMS_DELEGATED_VAULT_NAMESPACE = '@omadia/teams-delegated';

/** The single key inside that namespace — see the module header on why one. */
export const TEAMS_DELEGATED_VAULT_KEY = 'tenant-token-set';

/**
 * What the operator surface is allowed to know. No token, ever — not even
 * truncated: a prefix of a bearer token is still material an attacker can
 * search logs for.
 */
export interface DelegatedSignInPresence {
  readonly signedIn: boolean;
  /** ISO-8601 — when THIS install stored the sign-in. Not from Microsoft. */
  readonly signedInAt?: string;
  /** ISO-8601 expiry of the access token. */
  readonly expiresAt?: string;
  /**
   * The access token is past {@link expiresAt}. NOT signed out: the refresh
   * token outlives it and the next upload refreshes silently. Rendering this
   * as an error is the mistake this field exists to prevent.
   */
  readonly accessTokenStale?: boolean;
  readonly scopes?: readonly string[];
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly account?: DelegatedTokenSummary['account'];
}

export const SIGNED_OUT: DelegatedSignInPresence = { signedIn: false };

/** Envelope written to the vault. Versioned so a later shape change can be
 *  recognised rather than guessed at. */
interface StoredEnvelope {
  readonly version: 1;
  readonly signedInAt: string;
  readonly tokens: DelegatedTokenSet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Narrow a decrypted blob back into a token set.
 *
 * Strict on the fields the connector REQUIRES (both tokens, expiry, scopes,
 * client and tenant): a half-written record is not a usable credential, and
 * handing the connector a set with an empty `refreshToken` would produce a
 * confusing `DelegatedTokenExpiredError` instead of an honest "nobody is
 * signed in". Returns `undefined` rather than throwing — the caller's honest
 * answer for a corrupt record is the same as for an absent one.
 */
function parseEnvelope(raw: string): StoredEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  const tokens = parsed.tokens;
  if (!isRecord(tokens)) return undefined;
  const {
    accessToken,
    refreshToken,
    expiresAt,
    scopes,
    clientId,
    tenantId,
    account,
  } = tokens;
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0 ||
    typeof expiresAt !== 'string' ||
    typeof clientId !== 'string' ||
    typeof tenantId !== 'string' ||
    !isStringArray(scopes)
  ) {
    return undefined;
  }
  const signedInAt =
    typeof parsed.signedInAt === 'string' ? parsed.signedInAt : new Date(0).toISOString();
  return {
    version: 1,
    signedInAt,
    tokens: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
      clientId,
      tenantId,
      ...(isRecord(account)
        ? {
            account: {
              ...(typeof account.username === 'string'
                ? { username: account.username }
                : {}),
              ...(typeof account.displayName === 'string'
                ? { displayName: account.displayName }
                : {}),
              ...(typeof account.objectId === 'string'
                ? { objectId: account.objectId }
                : {}),
              ...(typeof account.tenantId === 'string'
                ? { tenantId: account.tenantId }
                : {}),
            },
          }
        : {}),
    },
  };
}

export class TeamsDelegatedTokenStore {
  constructor(
    private readonly vault: DelegatedTokenVault,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The stored token set, or `undefined` when nobody is signed in.
   *
   * TWO CALLERS ONLY — the provisioning job runner and the sign-in service.
   * Everything that renders sign-in state uses {@link describe}.
   */
  async read(): Promise<DelegatedTokenSet | undefined> {
    const raw = await this.vault.get(
      TEAMS_DELEGATED_VAULT_NAMESPACE,
      TEAMS_DELEGATED_VAULT_KEY,
    );
    if (raw === undefined) return undefined;
    return parseEnvelope(raw)?.tokens;
  }

  /**
   * Persist a token set — the sign-in that just succeeded, or the rotation the
   * connector performed (`refreshed === true`).
   *
   * `signedInAt` is preserved across a ROTATION and reset on a fresh SIGN-IN.
   * The distinction is what the operator screen means by "signed in since":
   * a refresh happens without a human and must not restart that clock, or the
   * panel would suggest someone re-authenticated when nobody did. The two
   * cases are told apart by the account and tenant staying the same.
   */
  async write(tokens: DelegatedTokenSet): Promise<void> {
    const previous = await this.readEnvelope();
    const continuesPrevious =
      previous !== undefined &&
      previous.tokens.tenantId === tokens.tenantId &&
      previous.tokens.account?.objectId === tokens.account?.objectId;
    const envelope: StoredEnvelope = {
      version: 1,
      signedInAt: continuesPrevious
        ? previous.signedInAt
        : this.now().toISOString(),
      tokens,
    };
    await this.vault.set(
      TEAMS_DELEGATED_VAULT_NAMESPACE,
      TEAMS_DELEGATED_VAULT_KEY,
      JSON.stringify(envelope),
    );
  }

  /** Forget the sign-in. Idempotent: clearing an empty vault is a no-op. */
  async clear(): Promise<void> {
    await this.vault.deleteKey(
      TEAMS_DELEGATED_VAULT_NAMESPACE,
      TEAMS_DELEGATED_VAULT_KEY,
    );
  }

  /**
   * Sign-in state WITHOUT the values — the projection every operator-facing
   * caller uses.
   *
   * `accessTokenStale` is computed here rather than asked of the connector so
   * the answer exists even when no connector is installed. It is deliberately
   * NOT `signedIn: false`: an expired access token with a live refresh token
   * is a working sign-in, and the UI is required to render it as such.
   */
  async describe(): Promise<DelegatedSignInPresence> {
    const envelope = await this.readEnvelope();
    if (envelope === undefined) return SIGNED_OUT;
    const summary = summarizeTokenSet(envelope.tokens);
    // Margin 0: this is the plain "has it expired" question. The job runner
    // asks the SAME predicate with a refresh margin — sharing the rule is what
    // keeps "stale" on screen and "refresh before use" in the runner from
    // becoming two different definitions of expiry.
    const stale = isAccessTokenExpiring(summary.expiresAt, this.now());
    return {
      signedIn: true,
      signedInAt: envelope.signedInAt,
      expiresAt: summary.expiresAt,
      accessTokenStale: stale,
      scopes: summary.scopes,
      tenantId: summary.tenantId,
      clientId: summary.clientId,
      ...(summary.account ? { account: summary.account } : {}),
    };
  }

  private async readEnvelope(): Promise<StoredEnvelope | undefined> {
    const raw = await this.vault.get(
      TEAMS_DELEGATED_VAULT_NAMESPACE,
      TEAMS_DELEGATED_VAULT_KEY,
    );
    return raw === undefined ? undefined : parseEnvelope(raw);
  }
}
