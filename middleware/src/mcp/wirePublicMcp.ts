/**
 * W2-3 (issue #542) — assembles and mounts the public MCP endpoint.
 *
 * A separate wire module (mirroring `devplatform/wireDevPlatform.ts`) for two
 * reasons: `index.ts` is already ~4500 lines, and — more usefully — the whole
 * assembly becomes testable end-to-end against the real router chain instead of
 * a bare `express()` app. Mounting a bare app is exactly the epic #470 bug the
 * doc comment at the top of `auth/publicPaths.ts` records: the runner router's
 * e2e test built its own app, so the test passed while production 401'd behind
 * the blanket `/api` gate.
 */

import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';

import type { ApiKeySecretStorage, ApiKeyStore, AuditLog, RateLimiter } from '@omadia/api-key-auth';
import { createApiKeyStore, createRateLimiter } from '@omadia/api-key-auth';
import { AgentGraphStore, ToolDispatchService } from '@omadia/orchestrator';
import type { NativeToolRegistry, OrchestratorRegistry } from '@omadia/orchestrator';

import type { SecretVault } from '../secrets/vault.js';
import {
  createPublicMcpKeyBindingStore,
  type PublicMcpKeyBindingStore,
} from './publicMcpKeyBindings.js';
import { PUBLIC_MCP_PATH, PUBLIC_MCP_SERVER_NAME } from './publicMcpPath.js';
import { createPublicMcpRouter } from './publicMcpRouter.js';
import type { PublicMcpAuditEntry, PublicMcpDispatcher } from './publicMcpServer.js';

/**
 * The vault namespace holding API-key records.
 *
 * Deliberately the SAME namespace `@omadia/channel-api` writes to (a plugin's
 * `ctx.secrets` is its own manifest id), so there is ONE key list and ONE place
 * to revoke. A key's SCOPES decide what it can reach: `chat:write` gets the
 * chat ingress, `mcp:list`/`mcp:invoke`/`mcp:write:<tool>` get this endpoint,
 * and a key holding only the former reaches nothing here. A second key store
 * would have meant a second revoke an operator can forget.
 */
export const API_KEY_VAULT_NAMESPACE = '@omadia/channel-api';

/**
 * Adapts the kernel's namespaced vault to the flat `ApiKeySecretStorage` shape.
 *
 * Read/list ONLY — no `set`, no `delete`. `createApiKeyStore` requires a
 * write-capable accessor and throws without one, which is the point: minting
 * and revoking keys stays with `@omadia/channel-api`'s operator-session-gated
 * `/admin/keys` routes. This module builds a store for VERIFICATION, and giving
 * an internet-facing route the ability to write its own credentials is not a
 * capability it has any use for.
 *
 * @see createVerifyOnlyApiKeyStore for how the read-only store is obtained.
 */
function readOnlyVaultStorage(vault: SecretVault): ApiKeySecretStorage {
  return {
    get: (key) => vault.get(API_KEY_VAULT_NAMESPACE, key),
    keys: () => vault.listKeys(API_KEY_VAULT_NAMESPACE),
  };
}

/**
 * An `ApiKeyStore` usable for `verify()` only.
 *
 * `createApiKeyStore` demands a writer up front, so it cannot be handed the
 * read-only accessor above. Rather than widen the endpoint's vault access to
 * satisfy a constructor, the two write methods are stubbed to throw: reaching
 * either is a programmer error (nothing on this path calls them), and a throw
 * is a louder, more debuggable failure than a silent no-op that appears to have
 * minted a key.
 */
export function createVerifyOnlyApiKeyStore(vault: SecretVault): ApiKeyStore {
  const storage = readOnlyVaultStorage(vault);
  return createApiKeyStore({
    ...storage,
    set: () => {
      throw new Error(
        'public MCP endpoint must not mint API keys — use @omadia/channel-api /admin/keys',
      );
    },
    delete: () => {
      throw new Error(
        'public MCP endpoint must not revoke API keys — use @omadia/channel-api /admin/keys',
      );
    },
  });
}

/** The vault is only needed when the caller did not supply an `ApiKeyStore`;
 *  throwing here keeps that a wiring error rather than a runtime 500. */
function requireVault(deps: WirePublicMcpDeps): SecretVault {
  if (!deps.vault) {
    throw new Error('mountPublicMcp requires a vault (or an explicit apiKeys store)');
  }
  return deps.vault;
}

export interface WirePublicMcpDeps {
  readonly enabled: boolean;
  /** See `PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_SEAM`. */
  readonly allowWithoutPrivacySeam: boolean;
  /** Only read when `apiKeys` is not supplied. */
  readonly vault?: SecretVault;
  /** Bindings and the audit trail both live in the graph DB. Absent ⇒ the
   *  endpoint is NOT mounted: without bindings every key reaches nothing, and
   *  without the audit trail a public write would be unattributable. */
  readonly graphPool: Pool | undefined;
  /** Resolved LIVE, not captured: the orchestrator plugin republishes the
   *  registry on reactivation, so a boot-time value would pin a stale set.
   *  Only read when `resolveDispatcher` is not supplied. */
  readonly getRegistry?: () => OrchestratorRegistry | undefined;
  /** The process-wide native tool registry. Shared across agents by design —
   *  which is precisely why per-agent reach is decided by the binding row and
   *  the agent's OWN `listDomainTools()`, not by this registry. Only read when
   *  `resolveDispatcher` is not supplied. */
  readonly nativeToolRegistry?: NativeToolRegistry;
  readonly log?: (msg: string) => void;

  // ── Test seams. Production supplies none of these. ────────────────────────
  // Each one substitutes an INFRASTRUCTURE dependency (a pool, a vault, the
  // orchestrator registry), never a GATE: the allowlist check, the scope
  // checks, the rate limits and the audit calls all run exactly as they do in
  // production, which is what lets the e2e tests assert on real refusals.
  readonly bindings?: PublicMcpKeyBindingStore;
  readonly apiKeys?: ApiKeyStore;
  readonly rateLimiter?: RateLimiter;
  readonly keyAuditLog?: AuditLog;
  readonly resolveDispatcher?: (agentId: string) => PublicMcpDispatcher | undefined;
  readonly audit?: (entry: PublicMcpAuditEntry) => void;
  readonly toolTimeoutMs?: number;
  readonly maxConcurrentCalls?: number;
  /** Second limiter instance. Defaults to a fresh one — never the read one. */
  readonly writeRateLimiter?: RateLimiter;
}

/**
 * Builds the per-agent dispatcher.
 *
 * Mirrors the `ToolDispatchService` construction in `buildOrchestrator.ts`'s
 * claude-cli branch, with ONE difference that carries all the isolation:
 * `domainToolsProvider` reads THIS agent's orchestrator. Native tools come from
 * the process-wide registry (there is no per-agent native registry in omadia),
 * so a shared native tool is reachable by any agent — and is kept out of reach
 * of a given KEY by the binding allowlist, which is checked before dispatch is
 * ever consulted.
 *
 * Returns `undefined` for an unknown or inactive slug, which fails the call
 * closed rather than falling back to the default agent.
 */
function makeDispatcherResolver(
  deps: WirePublicMcpDeps,
): (agentId: string) => PublicMcpDispatcher | undefined {
  if (deps.resolveDispatcher) return deps.resolveDispatcher;
  const { getRegistry, nativeToolRegistry } = deps;
  if (!getRegistry || !nativeToolRegistry) {
    throw new Error(
      'mountPublicMcp requires getRegistry + nativeToolRegistry (or an explicit resolveDispatcher)',
    );
  }
  return (agentId) => {
    const entry = getRegistry()?.get(agentId);
    if (!entry) return undefined;
    return new ToolDispatchService({
      nativeTools: nativeToolRegistry,
      domainToolsProvider: () => entry.built.orchestrator.listDomainTools(),
    });
  };
}

/**
 * Maps a public MCP call onto an `mcp_call_log` row.
 *
 * `serverId` is NULL and `serverName` is the `omadia-public-mcp` literal:
 * omadia IS the server here, so there is no `mcp_servers` row to point at (0009
 * made the FK nullable for exactly this "no server row" case). `callerKind` is
 * the `api_key` member migration 0033 added, and `actingIdentity` reuses 0031's
 * vocabulary — `apikey:<keyId>`, or the literal `unresolved`.
 *
 * Fire-and-forget: an audit write must never fail a caller's request. It must
 * also never be the reason one succeeds, which is why the endpoint is not
 * mounted at all without a pool.
 */
export function createPublicMcpAuditSink(
  graph: AgentGraphStore,
  log: (msg: string) => void,
): (entry: PublicMcpAuditEntry) => void {
  return (entry) => {
    void graph
      .insertMcpCallLog({
        serverId: null,
        serverName: PUBLIC_MCP_SERVER_NAME,
        toolName: entry.toolName,
        callerKind: 'api_key',
        callerAgent: entry.agentId,
        turnId: null,
        ok: entry.ok,
        error: entry.error,
        durationMs: entry.durationMs,
        calledAt: entry.calledAt,
        actingIdentity: entry.actingIdentity,
      })
      .catch((err: unknown) => {
        log(`[public-mcp] audit write failed: ${String(err)}`);
      });
  };
}

/**
 * Mounts the endpoint, or explains why it stayed dark.
 *
 * `requireAuth` runs FIRST and is load-bearing in both directions: it short-
 * circuits to `next()` because `PUBLIC_MCP_PATH` is in `publicPaths.ts`, and if
 * that entry were ever removed this route would 401 before `requireApiKey` ran.
 * That is the intended failure mode — a path that loses its exemption goes dark
 * rather than open — and it is what makes the `publicPaths` test meaningful
 * rather than decorative.
 */
export function mountPublicMcp(app: Express, requireAuth: RequestHandler, deps: WirePublicMcpDeps): boolean {
  const log = deps.log ?? ((msg: string) => console.log(msg));

  if (!deps.enabled) {
    log('[public-mcp] DISABLED (PUBLIC_MCP_ENABLED=false) — no router mounted');
    return false;
  }
  if (!deps.graphPool && !deps.bindings) {
    log('[public-mcp] NOT mounted — no DATABASE_URL, so there are no key bindings and no audit trail');
    return false;
  }

  const bindings =
    deps.bindings ?? createPublicMcpKeyBindingStore(deps.graphPool as Pool);
  const audit =
    deps.audit ??
    (deps.graphPool
      ? createPublicMcpAuditSink(new AgentGraphStore(deps.graphPool), log)
      : undefined);
  const apiKeys = deps.apiKeys ?? createVerifyOnlyApiKeyStore(requireVault(deps));

  // Scoped to the ONE path, not `app.use(requireAuth, …)`. An unscoped mount
  // would run `requireAuth` for every request on the whole app — including the
  // non-`/api` surfaces (`/health`, static assets) that were never behind it.
  app.use(
    PUBLIC_MCP_PATH,
    requireAuth,
    createPublicMcpRouter({
      apiKeys,
      rateLimiter: deps.rateLimiter ?? createRateLimiter(),
      ...(deps.keyAuditLog ? { keyAuditLog: deps.keyAuditLog } : {}),
      bindings,
      // A SECOND limiter instance, not the one above. Writes get their own
      // budget so a read-heavy integration's unused read headroom cannot fund a
      // write burst.
      writeRateLimiter: deps.writeRateLimiter ?? createRateLimiter(),
      resolveDispatcher: makeDispatcherResolver(deps),
      ...(audit ? { audit } : {}),
      requirePrivacySeam: !deps.allowWithoutPrivacySeam,
      serverName: PUBLIC_MCP_SERVER_NAME,
      ...(deps.toolTimeoutMs !== undefined ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
      ...(deps.maxConcurrentCalls !== undefined
        ? { maxConcurrentCalls: deps.maxConcurrentCalls }
        : {}),
    }),
  );

  log(
    `[public-mcp] mounted at POST ${PUBLIC_MCP_PATH} (API-key auth, per-key tool allowlist)${
      deps.allowWithoutPrivacySeam
        ? ' ⚠ tool calls ENABLED WITHOUT the dispatch privacy seam — responses may carry unmasked PII'
        : ' — tool calls REFUSED until the dispatch privacy seam is wired (tools/list works)'
    }`,
  );
  return true;
}
