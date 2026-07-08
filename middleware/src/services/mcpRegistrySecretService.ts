/**
 * Epic #459 / issue #463 item 5 — Vault-backed MCP registry bearer tokens.
 *
 * A catalog source (mcp_registries) may carry an optional bearer token. That
 * token is a secret-at-rest and must NEVER live on the DB row. It is stored
 * ONLY in the Vault (namespace `@omadia/mcp-registry`, key = registry id),
 * mirroring `McpConfigService` (server-config secrets, `@omadia/mcp-config`).
 *
 * The runtime `McpRegistryConfig` consumed by `McpRegistryClient` still carries
 * a `token` field — the caller resolves it from this service when assembling
 * the config, instead of reading a plaintext column.
 */

interface Vault {
  get(namespace: string, key: string): Promise<string | undefined>;
  set(namespace: string, key: string, value: string): Promise<void>;
  deleteKey?(namespace: string, key: string): Promise<void>;
}

const VAULT_NS = '@omadia/mcp-registry';

export interface McpRegistrySecretServiceDeps {
  readonly vault: Vault;
}

export class McpRegistrySecretService {
  constructor(private readonly deps: McpRegistrySecretServiceDeps) {}

  /** The bearer token for a registry, or undefined when none is stored. */
  async getToken(registryId: string): Promise<string | undefined> {
    return this.deps.vault.get(VAULT_NS, registryId);
  }

  async setToken(registryId: string, value: string): Promise<void> {
    await this.deps.vault.set(VAULT_NS, registryId, value);
  }

  async deleteToken(registryId: string): Promise<void> {
    await this.deps.vault.deleteKey?.(VAULT_NS, registryId);
  }
}

/** Minimal store surface the backfill needs — satisfied by AgentGraphStore. */
export interface McpRegistryTokenBackfillStore {
  listLegacyMcpRegistryTokens(): Promise<readonly { id: string; token: string }[]>;
  clearLegacyMcpRegistryToken(id: string): Promise<void>;
}

export interface BackfillMcpRegistryTokensDeps {
  readonly store: McpRegistryTokenBackfillStore;
  readonly secrets: McpRegistrySecretService;
  readonly log?: (msg: string) => void;
}

/**
 * One-time, idempotent migration of legacy plaintext `mcp_registries.token`
 * values into the Vault. Safe to run on every boot: after the first pass the
 * column is NULL, so subsequent passes find nothing and do nothing. Ordered
 * write-then-clear so a crash mid-backfill leaves the token recoverable from
 * the (still-populated) column on the next boot rather than lost.
 */
export async function backfillMcpRegistryTokens(
  deps: BackfillMcpRegistryTokensDeps,
): Promise<number> {
  const log = deps.log ?? (() => undefined);
  const legacy = await deps.store.listLegacyMcpRegistryTokens();
  if (legacy.length === 0) return 0;
  let moved = 0;
  for (const { id, token } of legacy) {
    await deps.secrets.setToken(id, token);
    await deps.store.clearLegacyMcpRegistryToken(id);
    moved += 1;
  }
  log(
    `[mcp-registry] backfilled ${String(moved)} legacy plaintext registry token(s) into the vault`,
  );
  return moved;
}
