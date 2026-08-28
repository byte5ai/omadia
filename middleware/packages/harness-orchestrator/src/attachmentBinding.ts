/**
 * #575 — bind an attachment handle to the room that minted it.
 *
 * Guard 3 (`audienceFloorGuard.guardAttachmentRead`) checks the floor at
 * **redemption**: may this room redeem a storage handle at all. What it could
 * not check was the floor at **minting**, and its own header says so. The gap:
 * a storage key issued in a private chat is just a string, and a string can be
 * pasted into a group chat that happens to hold `attachment:read`.
 *
 * This module closes it. The rule is deliberately simple, because a rule about
 * who may read a document has to be explainable:
 *
 *   **A handle is redeemable only in the room it was minted in.**
 *
 * ## Why the room is a `ScopeId` and never a raw scope string
 *
 * `turnContext.sessionScope` carries its own warning: it is "NOT safe as a key
 * on its own", because `resolveScope` hands every unscoped HTTP turn the
 * literal `'http-default'`. That was the live cross-user hole in #445, and
 * `teams-unknown` was the same hole in a second place.
 *
 * Keying a security binding on that string would not merely fail to restrict —
 * it would declare every unrelated caller to be *the same room*, which is worse
 * than no binding at all because it reads as enforcement. So the scope is
 * parsed into `ScopeId` and only **addressable** scopes are bound. A
 * non-addressable scope disables the check rather than approximating it.
 *
 * ## First sighting is the minting
 *
 * The binding is written the first time a key is resolved, which is the ingest
 * of the turn the file arrived on — the orchestrator resolves storage keys off
 * the inbound turn before anything else can. Writing at first sighting rather
 * than at an explicit "mint" hook means the binding cannot be bypassed by a
 * resolution path somebody adds later, which is the same argument that put the
 * floor check on the reader instead of on its call sites.
 */

import {
  formatSessionScope,
  isAddressableScope,
  parseSessionScope,
  type ScopeId,
} from '@omadia/channel-sdk';

/** The room a handle belongs to, as stored. */
export interface AttachmentScopeBinding {
  readonly scopeKind: string;
  readonly scopeRef: string;
}

/**
 * Durable storage for handle→room bindings.
 *
 * Like `GrantStore`, an implementation that **cannot answer must throw**: the
 * caller turns that into a refusal. Returning "no binding" on a database error
 * would silently unbind every handle in the deployment, and the failure would
 * look exactly like the ordinary un-bound case.
 */
export interface AttachmentBindingStore {
  /** The room this key was minted in, or `undefined` if never bound. */
  get(storageKey: string): Promise<AttachmentScopeBinding | undefined>;
  /**
   * Record the minting room. MUST NOT overwrite an existing row — the first
   * sighting is the minting, and a later write would let a wider room re-bind a
   * handle to itself and then read it.
   */
  bindIfAbsent(storageKey: string, binding: AttachmentScopeBinding): Promise<void>;
}

/**
 * The binding for a scope, or `undefined` when the scope cannot identify a room.
 *
 * Exported for the tests that pin the `unscoped` / `system` exclusions, since
 * those are the cases where a wrong answer is invisible.
 */
export function bindingForScope(scope: ScopeId): AttachmentScopeBinding | undefined {
  if (!isAddressableScope(scope)) return undefined;
  return { scopeKind: scope.kind, scopeRef: formatSessionScope(scope) };
}

/** Same, from the raw turn-context string. */
export function bindingForRawScope(raw: string | undefined): AttachmentScopeBinding | undefined {
  return bindingForScope(parseSessionScope(raw));
}

export function bindingsEqual(
  a: AttachmentScopeBinding,
  b: AttachmentScopeBinding,
): boolean {
  // Kind AND reference: `formatSessionScope` renders a conversation scope as
  // its bare conversation id, which could itself be the string `personal:x`.
  // Comparing references alone would let two different kinds of room look
  // like one.
  return a.scopeKind === b.scopeKind && a.scopeRef === b.scopeRef;
}
