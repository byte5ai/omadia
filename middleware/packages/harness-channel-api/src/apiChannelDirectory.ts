/**
 * #1106 finding #1 — Public API channel's `ChannelKeyDirectory` contribution.
 *
 * Without this, `/operator/channels` builds its list purely from the
 * directories aggregated in the kernel's `ChannelDirectoryRegistry`, so the
 * API channel contributed no rows: an operator had nothing to bind an agent
 * to, and every API turn fell through to the platform fallback orchestrator.
 *
 * The directory lists one row per ACTIVE (non-revoked) API key, keyed by
 * `key:<uuid>` — the exact value `chatRouter.ts` now sets as
 * `IncomingTurn.channelKey`. Binding a row therefore routes real turns made
 * with that key, exactly as a Teams `28:<appId>` row does. Revoked keys drop
 * out on the next dashboard load (the registry calls `listKeys()` once per
 * page render), so a revoked credential is no longer a bindable unit.
 *
 * Ownership follows the SDK contract (`channelKeyDirectory.ts`): the plugin
 * that owns the keys owns their discovery. No platform-level enumeration of
 * the vault from generic kernel code.
 */

import type { ChannelKeyDirectory, ChannelKeyEntry } from '@omadia/channel-sdk';
import type { ApiKeyStore } from '@omadia/api-key-auth';

import { channelKeyOf } from './channelKey.js';

export interface ApiChannelDirectoryDeps {
  /** The plugin's key store — the single source of truth for which keys
   *  exist. Read (never written) here. */
  apiKeys: Pick<ApiKeyStore, 'list'>;
  /** The `channel_bindings.channel_type` an operator binds under. Must equal
   *  the value the dispatcher resolves for this channel (`deriveChannelType`
   *  of the plugin's channelId) so a bound row actually matches routed turns.
   *  Passed in rather than hardcoded so the plugin stays the single owner of
   *  the canonical spelling. */
  channelType: string;
  /** Display name of the contributing plugin, for the dashboard's per-row
   *  "via …" hint. */
  originPluginId: string;
}

/**
 * Builds a self-describing picker label for a key. Operators can leave a key
 * unlabelled; the row must still be distinguishable from its neighbours
 * without reading the opaque `key:<uuid>` selector, so fall back to a short
 * id fragment (the same prefix the admin UI shows).
 */
function labelFor(id: string, label: string | undefined): string {
  const trimmed = label?.trim();
  if (trimmed) return trimmed;
  return `API key ${id.slice(0, 8)}`;
}

export function createApiChannelDirectory(
  deps: ApiChannelDirectoryDeps,
): ChannelKeyDirectory {
  return {
    channelType: deps.channelType,
    originPluginId: deps.originPluginId,
    async listKeys(): Promise<readonly ChannelKeyEntry[]> {
      const keys = await deps.apiKeys.list();
      return keys
        // `list()` returns every key including revoked ones (it carries
        // `revokedAt` for the admin view); a revoked key must not remain a
        // bindable routing target.
        .filter((k) => k.revokedAt === undefined)
        .map((k) => ({
          key: channelKeyOf(k.id),
          label: labelFor(k.id, k.label),
        }));
    },
  };
}
