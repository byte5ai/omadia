/**
 * #2310 / ADR-0273 — a deleted API key takes its public MCP binding with it.
 *
 * API keys live in `@omadia/channel-api`'s vault namespace, the bindings in
 * Postgres (`public_mcp_key_bindings`, no foreign key possible). The plugin's
 * key-delete route calls this kernel service (`publicMcpKeyBindings`) after a
 * delete. The kernel removes the binding only when the key is really gone from
 * the vault, so a caller of the service can clean up orphans and nothing else.
 */

import type { PublicMcpKeyBindingAdminStore } from './publicMcpKeyBindingsAdmin.js';

/** Kernel service name; plugins declare `optional_requires: publicMcpKeyBindings@1`. */
export const PUBLIC_MCP_KEY_BINDINGS_SERVICE = 'publicMcpKeyBindings';

export type ForgetDeletedKeyOutcome =
  /** The binding was removed. */
  | 'removed'
  /** The key had no binding. */
  | 'none'
  /** The key still exists in the vault: nothing was removed. */
  | 'key_exists'
  /** No bindings store (no database) or the vault could not be read. */
  | 'unavailable';

export interface PublicMcpKeyBindingsService {
  forgetDeletedKey(keyId: string): Promise<ForgetDeletedKeyOutcome>;
}

export interface PublicMcpKeyBindingCascadeDeps {
  /** Resolved per call: the graph pool may arrive after plugins activate. */
  readonly bindings: () => PublicMcpKeyBindingAdminStore | undefined;
  /** The ids of every key in the vault, revoked and expired ones included. */
  readonly keyIds: () => Promise<ReadonlySet<string>>;
  readonly log?: (line: string) => void;
}

const KEY_ID_MAX = 200;

export function createPublicMcpKeyBindingCascade(
  deps: PublicMcpKeyBindingCascadeDeps,
): PublicMcpKeyBindingsService {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return {
    async forgetDeletedKey(keyId) {
      if (typeof keyId !== 'string' || keyId.length === 0 || keyId.length > KEY_ID_MAX) return 'none';
      const store = deps.bindings();
      if (store === undefined) return 'unavailable';
      let ids: ReadonlySet<string>;
      try {
        ids = await deps.keyIds();
      } catch {
        log(`[public-mcp] key-binding cascade: vault unreadable, binding of key ${keyId} kept`);
        return 'unavailable';
      }
      if (ids.has(keyId)) return 'key_exists';
      const removed = await store.remove(keyId);
      if (removed) log(`[public-mcp] removed the binding of deleted key ${keyId}`);
      return removed ? 'removed' : 'none';
    },
  };
}
