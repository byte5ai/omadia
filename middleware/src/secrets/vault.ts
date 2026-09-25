/**
 * Per-agent-scoped secret vault.
 *
 * Invariants (from manifest-schema v1 design-principle #6):
 *   - Secrets are ALWAYS namespaced by agent identity.id.
 *   - Agent A cannot read secrets belonging to agent B (the core never
 *     grants a handle that crosses the namespace).
 *   - The vault never returns values in a list — only `listKeys` exists.
 *   - Rotation replaces a single key; uninstall purges the whole namespace.
 *
 * v1 (this file): in-memory implementation. Values survive a single
 * middleware process but disappear on restart. Slice 1.2b swaps this for a
 * libsodium-sealed file store under /data/secrets. The interface below does
 * not change — call sites stay the same.
 */

import {
  VaultWriteEmitter,
  type SecretVaultWriteListener,
} from './vaultWriteEvents.js';

export type {
  SecretVaultWriteEvent,
  SecretVaultWriteListener,
} from './vaultWriteEvents.js';

export interface SecretVault {
  set(agentId: string, key: string, value: string): Promise<void>;
  setMany(agentId: string, entries: Record<string, string>): Promise<void>;
  get(agentId: string, key: string): Promise<string | undefined>;
  listKeys(agentId: string): Promise<string[]>;
  purge(agentId: string): Promise<void>;
  /** Remove a single secret. No-op if the key is absent. */
  deleteKey(agentId: string, key: string): Promise<void>;
}

export class InMemorySecretVault implements SecretVault {
  private readonly store = new Map<string, Map<string, string>>();
  private readonly writes = new VaultWriteEmitter();

  /** #1080 — observe completed writes (kernel-internal; not on the interface). */
  onWrite(listener: SecretVaultWriteListener): () => void {
    return this.writes.on(listener);
  }

  private namespace(agentId: string): Map<string, string> {
    let ns = this.store.get(agentId);
    if (!ns) {
      ns = new Map<string, string>();
      this.store.set(agentId, ns);
    }
    return ns;
  }

  async set(agentId: string, key: string, value: string): Promise<void> {
    this.namespace(agentId).set(key, value);
    this.writes.emit({ scope: agentId, keys: [key] });
  }

  async setMany(
    agentId: string,
    entries: Record<string, string>,
  ): Promise<void> {
    const ns = this.namespace(agentId);
    const keys = Object.keys(entries);
    for (const [k, v] of Object.entries(entries)) {
      ns.set(k, v);
    }
    if (keys.length > 0) this.writes.emit({ scope: agentId, keys });
  }

  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(agentId)?.get(key);
  }

  async listKeys(agentId: string): Promise<string[]> {
    const ns = this.store.get(agentId);
    if (!ns) return [];
    return Array.from(ns.keys()).sort();
  }

  async purge(agentId: string): Promise<void> {
    this.store.delete(agentId);
    this.writes.emit({ scope: agentId, purged: true });
  }

  async deleteKey(agentId: string, key: string): Promise<void> {
    const ns = this.store.get(agentId);
    if (!ns || !ns.has(key)) return;
    ns.delete(key);
    this.writes.emit({ scope: agentId, keys: [key] });
  }
}
