import type { PluginCatalogEntry } from '../manifestLoader.js';
import type { SecretVault } from '../../secrets/vault.js';
import {
  isTokenRefreshable,
  readStoredTokens,
  type StoredOAuthTokens,
} from './tokenStore.js';

/**
 * Issue #474 (review round 5) — automatic OAuth-connection readiness signal.
 *
 * `PluginStatusRegistry` only gates a plugin's tools when the PLUGIN's own
 * code calls `ctx.status.report(...)`. The generic install/Connect flow
 * never does this automatically: a `type:'oauth'` plugin's `activate()` runs
 * — and its `ctx.tools.register(...)`-contributed tools are recorded —
 * the moment `configure()` completes, which is BEFORE the operator has
 * clicked "Connect" and the kernel OAuth broker has stored any tokens
 * (`installService.ts`'s `validateValues` skips `type:'oauth'` fields
 * entirely at configure time — spec 005). Without this tracker, an
 * uncompleted OAuth plugin's tools are offered to the model and the first
 * call fails with `OAuthTokenError('not_connected')` — exactly the
 * round-trip issue #474 was filed to eliminate, for a plugin author who
 * never wrote an explicit `ctx.status.report(...)` call.
 *
 * Deliberately a SEPARATE cache from `PluginStatusRegistry`, not a write
 * into it: the composed gate (`installedPluginToolsReadyReader` in
 * index.ts) reads both signals independently and requires both to say
 * "ready". Keeping them separate means neither can silently clobber the
 * other — a plugin's own `ctx.status.report({state: 'ok'})` must not be
 * able to hide a real "not connected" state, and a connected OAuth field
 * must not clear an explicit `error`/`needs_action` the plugin reported for
 * an unrelated reason.
 *
 * Semi-synchronous cache, like `PluginStatusRegistry`: the readiness gate is
 * consulted synchronously on every tool-list build / dispatch, but OAuth
 * connection state lives in the (async) vault. `refresh()` re-reads the
 * vault and is called once per plugin activation — the single choke point
 * shared by fresh install, boot-time reactivation, and post-Connect
 * reactivation (`ToolPluginRuntime.activate` / `DynamicAgentRuntime.activate`)
 * — so the cached RAW token data self-heals on every activation, including a
 * restart.
 *
 * Issue #474 (review round 12) — `refresh()` caches the vault I/O result
 * (genuinely async, so it must stay activation-triggered), but it must NOT
 * additionally cache a pre-computed "is it fresh" boolean: freshness is a
 * function of wall-clock time, which keeps moving between activations. A
 * plugin that activates with, say, 10 minutes of token freshness left and no
 * refresh token would otherwise read as connected for the tracker's entire
 * lifetime, even 6 minutes later when `ctx.oauthTokens.get()` has crossed
 * `OAUTH_REFRESH_MARGIN_MS` and started throwing `OAuthTokenError
 * ('refresh_failed')` — exactly the wasted round-trip #474 exists to
 * prevent, just deferred from activation time to a few minutes later. So
 * `refresh()` stores the raw `StoredOAuthTokens` per declared oauth field,
 * and `isConnected()` recomputes `isTokenRefreshable()` (which itself calls
 * `isTokenStillFresh()` against `Date.now()`) fresh on every call — mirroring
 * how `ctx.oauthTokens.get()` itself never caches a verdict either. Both
 * helpers are pure and synchronous (no I/O), so recomputing per read is
 * cheap.
 */
export class OAuthReadinessTracker {
  /** Raw per-field token data from the last `refresh()`, keyed by plugin id.
   *  `undefined` for a field means no tokens are stored for it yet (Connect
   *  never completed). Absent from the map entirely means the plugin
   *  declares no `type:'oauth'` setup field (always connected) or was never
   *  activated. */
  private readonly fieldTokens = new Map<
    string,
    Array<StoredOAuthTokens | undefined>
  >();

  /** Re-read `pluginId`'s declared oauth fields from the vault and cache the
   *  raw token bundles (not a pre-computed verdict — see class doc). */
  async refresh(
    pluginId: string,
    entry: PluginCatalogEntry | undefined,
    vault: SecretVault,
  ): Promise<void> {
    const fieldKeys = (entry?.plugin.setup_fields ?? [])
      .filter((field) => field.type === 'oauth')
      .map((field) => field.key);
    if (fieldKeys.length === 0) {
      this.fieldTokens.delete(pluginId);
      return;
    }
    const stored = await Promise.all(
      fieldKeys.map((fieldKey) => readStoredTokens(vault, pluginId, fieldKey)),
    );
    this.fieldTokens.set(pluginId, stored);
  }

  /** Drop any cached state for `pluginId` — called on deactivate so an
   *  uninstalled/torn-down plugin leaves no stale signal behind (mirrors
   *  `PluginStatusRegistry.clear`). */
  clear(pluginId: string): void {
    this.fieldTokens.delete(pluginId);
  }

  /** True unless `pluginId` declares a `type:'oauth'` setup field whose
   *  stored tokens are, AS OF THIS CALL, either missing or not usable
   *  (mirroring `ctx.oauthTokens.get()`'s own refreshability check via
   *  `isTokenRefreshable` — see tokenStore.ts). Recomputed against the
   *  current wall clock on every call — see class doc for why. */
  isConnected(pluginId: string): boolean {
    const stored = this.fieldTokens.get(pluginId);
    if (stored === undefined) return true;
    return stored.every(
      (tokens) => tokens !== undefined && isTokenRefreshable(tokens),
    );
  }
}
