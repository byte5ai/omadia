/**
 * Epic #459 — schema-driven MCP server config with Vault-backed secrets.
 *
 * Non-secret config values live on the `mcp_servers.config` JSONB (handled by
 * the store); SECRET values live ONLY in the Vault (namespace
 * `@omadia/mcp-config`, key `<serverId>:<fieldKey>`) and never touch the DB row.
 * `{key}` placeholders in HEADER templates are substituted from the resolved
 * secret values at connect time; non-secret `{key}` placeholders in the
 * endpoint/headers are substituted earlier by `mcpRowToConfig`.
 */

import type { AgentGraphStore, McpServerConfig, McpServerRow } from '@omadia/orchestrator';

import { substituteMcpConfig } from '../agents/subAgentToolHydration.js';

interface Vault {
  get(namespace: string, key: string): Promise<string | undefined>;
  set(namespace: string, key: string, value: string): Promise<void>;
  deleteKey?(namespace: string, key: string): Promise<void>;
}

const VAULT_NS = '@omadia/mcp-config';

export interface McpConfigServiceDeps {
  readonly graph: AgentGraphStore;
  readonly vault: Vault;
}

export class McpConfigService {
  constructor(private readonly deps: McpConfigServiceDeps) {}

  private ref(serverId: string, key: string): string {
    return `${serverId}:${key}`;
  }

  async getSecret(serverId: string, key: string): Promise<string | undefined> {
    return this.deps.vault.get(VAULT_NS, this.ref(serverId, key));
  }

  async setSecret(serverId: string, key: string, value: string): Promise<void> {
    await this.deps.vault.set(VAULT_NS, this.ref(serverId, key), value);
  }

  async deleteSecret(serverId: string, key: string): Promise<void> {
    await this.deps.vault.deleteKey?.(VAULT_NS, this.ref(serverId, key));
  }

  /** Which secret fields currently have a stored value (for the UI — never the
   *  values themselves). */
  async secretsSet(server: McpServerRow): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const f of server.configSchema) {
      if (!f.secret) continue;
      out[f.key] = (await this.getSecret(server.id, f.key)) != null;
    }
    return out;
  }

  /**
   * Resolve secret config values from the Vault and substitute them into the
   * server's HEADER templates, returning only the headers that changed. Merged
   * over the (non-secret-substituted) cfg headers by the McpManager at connect.
   */
  async getConfigHeaders(cfg: McpServerConfig): Promise<Record<string, string>> {
    const server = (await this.deps.graph.listMcpServers()).find((s) => s.id === cfg.id);
    if (!server) return {};
    const secretVals: Record<string, string> = {};
    for (const f of server.configSchema) {
      if (!f.secret) continue;
      const v = await this.getSecret(server.id, f.key);
      if (v != null) secretVals[f.key] = v;
    }
    if (Object.keys(secretVals).length === 0) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.headers ?? {})) {
      if (typeof v !== 'string') continue;
      const sub = substituteMcpConfig(v, secretVals);
      if (sub !== v) out[k] = sub; // only headers that actually held a secret
    }
    return out;
  }

  /**
   * Environment variables for a stdio server: every declared config field
   * (field key = env var name) → its value — non-secret from the row, secret
   * from the Vault. Passed to the spawned process by the McpManager.
   */
  async getConfigEnv(cfg: McpServerConfig): Promise<Record<string, string>> {
    const server = (await this.deps.graph.listMcpServers()).find((s) => s.id === cfg.id);
    if (!server) return {};
    const out: Record<string, string> = {};
    for (const f of server.configSchema) {
      if (f.secret) {
        const v = await this.getSecret(server.id, f.key);
        if (v != null) out[f.key] = v;
      } else {
        const v = server.config[f.key];
        if (v != null) out[f.key] = String(v);
      }
    }
    return out;
  }
}
