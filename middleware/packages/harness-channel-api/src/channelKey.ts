/**
 * Single source of truth for the API channel's `key:<uuid>` identifier.
 *
 * The same string is the caller's `ChannelUserRef.id`, the router's
 * `IncomingTurn.channelKey` routing selector (#1106), and the key the
 * `ChannelKeyDirectory` lists — so it reads identically in logs, in a
 * `channel_bindings` row, and in the operator dashboard. Deriving it in one
 * place keeps those three sites from drifting apart if the format ever
 * changes.
 */

/** Prefix shared with `channel_bindings.channel_key` and `userRef.id`. */
export const CHANNEL_KEY_PREFIX = 'key:';

/** The channel key / user-ref id for an API key's `keyId`. */
export function channelKeyOf(keyId: string): string {
  return `${CHANNEL_KEY_PREFIX}${keyId}`;
}

/**
 * #1826 (ADR-0182) — the origin of an API key's turns: that key's one-person
 * room. `channelType` `api` is in the kernel's context-memory allowlist; the
 * personal scope keys the `user` tier and the `members` audience on the key,
 * so two keys never share a tier. Never derived from caller input.
 */
export function apiKeyOrigin(keyId: string): {
  readonly channelType: 'api';
  readonly scope: { readonly kind: 'personal'; readonly userId: string };
  readonly conversationType: 'direct';
} {
  return {
    channelType: 'api',
    scope: { kind: 'personal', userId: channelKeyOf(keyId) },
    conversationType: 'direct',
  };
}
