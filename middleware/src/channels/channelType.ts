import type { ChannelManifestBlock } from '../api/admin-v1.js';

/**
 * Channel-type autodiscovery (US7).
 *
 * Inbound turns carry a `channelId` (the plugin's catalog id, e.g.
 * `"de.byte5.channel.teams"`), but `channel_bindings` key on a short
 * `channel_type` (`"teams"`, `"telegram"` — the convention operators type in
 * the dashboard and `agents-apply`). This bridges the two so the dispatcher can
 * look a turn up against the binding table without any per-channel wiring.
 *
 * Resolution order — first hit wins:
 *   1. The channel manifest's declared `channel.channel_type` (explicit,
 *      authoritative — a plugin that needs a non-derivable type sets it).
 *   2. The last dotted segment of the `channelId`
 *      (`de.byte5.channel.teams` → `teams`). Covers every channel that follows
 *      the reverse-DNS `*.channel.<type>` id convention with zero config.
 *
 * The derived value is lowercased + trimmed so a manifest typo
 * (`"Teams"`) and the operator's `"teams"` still match.
 */
export interface DeriveChannelTypeSources {
  /** The channel's manifest `channel` block, if loaded in the catalog. */
  readonly manifest?: ChannelManifestBlock | undefined;
}

export function deriveChannelType(
  channelId: string,
  sources: DeriveChannelTypeSources = {},
): string {
  const declared = sources.manifest?.channel_type;
  if (typeof declared === 'string' && declared.trim().length > 0) {
    return normalize(declared);
  }
  return normalize(lastSegment(channelId));
}

function lastSegment(channelId: string): string {
  const trimmed = channelId.trim();
  const dot = trimmed.lastIndexOf('.');
  return dot >= 0 && dot < trimmed.length - 1
    ? trimmed.slice(dot + 1)
    : trimmed;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
