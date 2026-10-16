/**
 * Issue #1327 — the catalog of scopes some route actually checks.
 *
 * `isValidScope` (apiKeyScopes.ts) is a SHAPE test: it admits every
 * well-formed `<resource>:<action>`, so `chat:wirte` or `foo:bar` minted a key
 * that authenticated and could do nothing — indistinguishable from a revoked
 * key at debug time. Key CREATION now additionally requires the scope to be
 * known here. The read path (`normalizeScopes`) deliberately keeps using the
 * shape test only: a key minted with a scope whose plugin is later removed
 * must keep the scopes it has, not flip to deny-all.
 *
 * `ApiKeyScope` stays a plain string. A plugin that checks its own scope
 * registers it with `registerApiKeyScope` from `activate()` and calls the
 * returned dispose from `close()`.
 *
 * `mcp:write:<tool>` is admitted by shape (`isValidScope`) rather than by an
 * enumerated tool list: which tools a key can reach is decided by its public
 * MCP key binding, which is set AFTER the key exists, so there is no tool set
 * to check against at creation time. The shape rule already confines it to
 * one `mcp:write:` prefix and one tool-name segment.
 */

import {
  CHAT_WRITE_SCOPE,
  isMcpWriteScope,
  isValidScope,
  MCP_INVOKE_SCOPE,
  MCP_LIST_SCOPE,
  MCP_WRITE_SCOPE_PREFIX,
  WILDCARD_SCOPE,
  type ApiKeyScope,
} from './apiKeyScopes.js';

/** The scopes the kernel and the built-in channel check. Order is the order
 *  the admin UI renders them in. */
export const BUILTIN_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  CHAT_WRITE_SCOPE,
  MCP_LIST_SCOPE,
  MCP_INVOKE_SCOPE,
  WILDCARD_SCOPE,
];

/** What `GET /admin/keys/scopes` returns. */
export interface ApiKeyScopeCatalog {
  /** Every fixed scope a key may be minted with. */
  readonly scopes: readonly ApiKeyScope[];
  /** Prefix of the per-tool write scope (`mcp:write:<tool>`). */
  readonly mcpWritePrefix: string;
}

const registered = new Map<ApiKeyScope, number>();

/**
 * Registers a plugin-defined scope. Reference-counted so two activations of
 * the same scope (a hot reinstall overlapping its predecessor's close) don't
 * unregister each other. Throws on a malformed scope — that is a plugin bug.
 */
export function registerApiKeyScope(scope: ApiKeyScope): () => void {
  if (!isValidScope(scope) || scope === WILDCARD_SCOPE || isMcpWriteScope(scope)) {
    throw new Error(`registerApiKeyScope: '${scope}' is not a registrable scope`);
  }
  registered.set(scope, (registered.get(scope) ?? 0) + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const count = registered.get(scope) ?? 0;
    if (count <= 1) registered.delete(scope);
    else registered.set(scope, count - 1);
  };
}

export function listApiKeyScopes(): ApiKeyScopeCatalog {
  const extra = [...registered.keys()]
    .filter((scope) => !BUILTIN_API_KEY_SCOPES.includes(scope))
    .sort();
  return {
    scopes: [...BUILTIN_API_KEY_SCOPES, ...extra],
    mcpWritePrefix: MCP_WRITE_SCOPE_PREFIX,
  };
}

/** True when a route checks `scope`: a built-in, a registered plugin scope,
 *  or a well-formed `mcp:write:<tool>`. */
export function isKnownScope(scope: unknown): scope is ApiKeyScope {
  if (!isValidScope(scope)) return false;
  if (isMcpWriteScope(scope)) return true;
  return BUILTIN_API_KEY_SCOPES.includes(scope) || registered.has(scope);
}
