// Canonical id space for Conductor principals (US5 reminder/approval delivery).
//
// A reminder reaches a person only if the channel-binding key and the human-step principal /
// role-holder id compare EQUAL. Those ids enter from different sources (a channel plugin's
// `principalRef`, an operator-typed role holder, a `user:` principal) and the SQL match is
// case-sensitive, so every id that crosses that boundary must be canonicalized identically.
// Canonicalization lives at the store/role layer (not the call sites) so it can't be forgotten.
// Email/UPN ids are case-insensitive; AAD-object-id GUIDs are already lowercase — so trimming +
// lowercasing is safe and lossless for both.

export function canonicalizePrincipalId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * The Conductor channel-binding key for an inbound turn: the operator-addressable `principalRef`
 * (e.g. a Teams user's email) when the channel supplied a non-empty one, else the channel-native
 * `userId` (e.g. AAD object id). Uses `||` (not `??`) so a blank `principalRef` from a channel
 * falls back to `userId` instead of writing an empty, never-matched binding key.
 */
export function bindingKeyForTurn(info: { userId: string; principalRef?: string }): string {
  return info.principalRef || info.userId;
}
