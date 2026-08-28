import { canonicalizePrincipalRef } from '@omadia/channel-sdk';

// Canonical id space for Conductor principals (US5 reminder/approval delivery).
//
// A reminder reaches a person only if the channel-binding key and the human-step principal /
// role-holder id compare EQUAL. Those ids enter from different sources (a channel plugin's
// `principalRef`, an operator-typed role holder, a `user:` principal) and the SQL match is
// case-sensitive, so every id that crosses that boundary must be canonicalized identically.
// Canonicalization lives at the store/role layer (not the call sites) so it can't be forgotten.
// Email/UPN ids are case-insensitive; AAD-object-id GUIDs are already lowercase — so trimming +
// lowercasing is safe and lossless for both.

// #333 Phase 1 — the rule itself now lives with the `Principal` type in the channel
// SDK, so Conductor and every future Principal producer canonicalize identically.
// Two independent implementations of "canonical" drifting apart would reintroduce
// exactly the case-sensitive miss this function exists to prevent. Conductor's
// principal ids are the `user` kind: `role` keys are canonicalized differently
// (trim only) because `createRole` writes them verbatim — see `principal.ts`.
export function canonicalizePrincipalId(id: string): string {
  return canonicalizePrincipalRef('user', id);
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
