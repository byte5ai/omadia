import type { PluginCatalogEntry } from '../manifestLoader.js';
import type { SecretVault } from '../../secrets/vault.js';
import { isTokenRefreshable, readStoredTokens } from './tokenStore.js';

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
 * Synchronous cache, like `PluginStatusRegistry`: the readiness gate is
 * consulted synchronously on every tool-list build / dispatch, but OAuth
 * connection state lives in the (async) vault. `refresh()` re-derives the
 * cached value from the vault and is called once per plugin activation —
 * the single choke point shared by fresh install, boot-time reactivation,
 * and post-Connect reactivation (`ToolPluginRuntime.activate` /
 * `DynamicAgentRuntime.activate`) — so the cache self-heals on every
 * activation, including a restart.
 */
export class OAuthReadinessTracker {
  private readonly disconnected = new Set<string>();

  /** Re-derive `pluginId`'s connection state from the vault and cache the
   *  result. Connected (cache cleared) when the plugin declares no
   *  `type:'oauth'` setup field, or when every declared oauth field has
   *  stored tokens that are either still fresh or expired-with-a-refresh-
   *  token (mirroring `ctx.oauthTokens.get()`'s own refreshability check via
   *  `isTokenRefreshable` — see tokenStore.ts); not-connected otherwise.
   *
   *  Issue #474 (review round 10) — a token bundle existing in the vault is
   *  NOT enough: `ctx.oauthTokens.get()` throws `OAuthTokenError
   *  ('refresh_failed')` for an expired token with no refresh token to renew
   *  it, so a plugin in that state must not be reported ready either. */
  async refresh(
    pluginId: string,
    entry: PluginCatalogEntry | undefined,
    vault: SecretVault,
  ): Promise<void> {
    const fieldKeys = (entry?.plugin.setup_fields ?? [])
      .filter((field) => field.type === 'oauth')
      .map((field) => field.key);
    if (fieldKeys.length === 0) {
      this.disconnected.delete(pluginId);
      return;
    }
    const stored = await Promise.all(
      fieldKeys.map((fieldKey) => readStoredTokens(vault, pluginId, fieldKey)),
    );
    const allUsable = stored.every(
      (tokens) => tokens !== undefined && isTokenRefreshable(tokens),
    );
    if (allUsable) {
      this.disconnected.delete(pluginId);
    } else {
      this.disconnected.add(pluginId);
    }
  }

  /** Drop any cached state for `pluginId` — called on deactivate so an
   *  uninstalled/torn-down plugin leaves no stale signal behind (mirrors
   *  `PluginStatusRegistry.clear`). */
  clear(pluginId: string): void {
    this.disconnected.delete(pluginId);
  }

  /** True unless `pluginId` declares a `type:'oauth'` setup field that has
   *  not completed the Connect flow yet. */
  isConnected(pluginId: string): boolean {
    return !this.disconnected.has(pluginId);
  }
}
