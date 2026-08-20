/**
 * #577 P3 — sharing = a grant over `GrantStore` (#575), not a parallel ACL.
 *
 * Kernkonzept #5: "Sharing ist grant-basiert (`share` = ACL-Grant, `move` =
 * Home-Wechsel)". This module is the one place that knows how a skill's
 * "shared with me" fact is encoded as a `Capability` string, and how to turn
 * a resolved capability set back into the `sharedSkillIds` P2's
 * `resolveSkillByName` (`skillResolver.ts`) needs. It never touches
 * `grants.ts`'s body — only its exported `GrantStore`/`resolveCapabilities`
 * contract, per the #577 binding surface separation.
 *
 * ## Fail-closed, not "unresolved is a type" — and why THIS module differs
 *
 * `resolveCapabilities` (#575) treats a partial role lookup as `undefined`
 * ("unresolved"), because collapsing it to an empty capability set would
 * silently look like real policy on the audience-floor path where too few
 * capabilities can wrongly widen who is excluded from a room. Skill sharing
 * has the opposite risk shape: a grants-backend hiccup here can only ever
 * HIDE a skill that would have been visible, never reveal one that
 * shouldn't be — the personal/team/org buckets in `skillResolver.ts` are
 * completely independent of this module and still work. So
 * `resolveSharedSkillIds` still surfaces the `unresolved` fact (never lies
 * about it), but `toSharedSkillIdsSet` gives callers who just want the
 * resolver's `sharedSkillIds` input a one-line fail-closed default —
 * "no visible shares right now" is a safe, honest degradation here in a way
 * it is NOT on the audience floor.
 */

import {
  resolveCapabilities,
  type GrantStore,
  type Principal,
  type RoleSourceRegistry,
} from '@omadia/channel-sdk';

/** The `Capability` prefix that encodes "read access to this specific skill". */
const SHARED_SKILL_CAPABILITY_PREFIX = 'skill:read:';

/** The `Capability` string a grant records to share `skillId` with its holder. */
export function sharedSkillCapability(skillId: string): string {
  return `${SHARED_SKILL_CAPABILITY_PREFIX}${skillId}`;
}

/** Extracts the skill id from a capability string, or `undefined` if it isn't a skill-share capability. */
export function parseSharedSkillCapability(capability: string): string | undefined {
  if (!capability.startsWith(SHARED_SKILL_CAPABILITY_PREFIX)) return undefined;
  const id = capability.slice(SHARED_SKILL_CAPABILITY_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

export type SharedSkillIdsResult =
  | { readonly ok: true; readonly ids: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: 'unresolved' };

/**
 * Resolve every skill id shared with `principal`, via `GrantStore` +
 * `RoleSourceRegistry` (#575/#333) — direct grants union role grants, exactly
 * as `resolveCapabilities` already defines for any other capability. Returns
 * `{ ok: false, reason: 'unresolved' }` when the underlying role lookup was
 * partial or the store threw — same trigger as `resolveCapabilities`
 * returning `undefined` — so a caller that cares CAN distinguish "nothing is
 * shared" from "we couldn't ask". A caller that doesn't care uses
 * {@link toSharedSkillIdsSet}.
 */
export async function resolveSharedSkillIds(
  principal: Principal,
  roles: RoleSourceRegistry,
  grants: GrantStore,
): Promise<SharedSkillIdsResult> {
  const resolved = await resolveCapabilities(principal, roles, grants);
  if (!resolved) return { ok: false, reason: 'unresolved' };

  const ids = new Set<string>();
  for (const capability of resolved.capabilities) {
    const id = parseSharedSkillCapability(capability);
    if (id !== undefined) ids.add(id);
  }
  // A capability granted AND denied is denied — same "denials win" rule the
  // audience floor applies (`audienceFloor.ts`), applied per-id here since a
  // skill share is a single-recipient grant, not a room-wide floor.
  for (const capability of resolved.denials) {
    const id = parseSharedSkillCapability(capability);
    if (id !== undefined) ids.delete(id);
  }
  return { ok: true, ids };
}

/**
 * Fail-closed adapter for callers (P2's `SkillResolutionContext.sharedSkillIds`)
 * that want a plain set: `unresolved` collapses to empty, per this module's
 * header — safe here because it can only hide a skill, never leak one.
 */
export function toSharedSkillIdsSet(result: SharedSkillIdsResult): ReadonlySet<string> {
  return result.ok ? result.ids : new Set();
}
