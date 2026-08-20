/**
 * #577 P2 — scope-ordered skill resolution with shadowing.
 *
 * Given a skill NAME (not `slug` — `skills.slug` is globally UNIQUE, so two
 * scopes can never own the same slug; `name` has no such constraint and is
 * the identity a shadowing lookup resolves against, e.g. "which skill
 * answers to the name 'incident-runbook' for THIS requester"), pick the
 * single winning row across the owner-scope hierarchy: **personal beats
 * shared beats team beats org** (#577 Kernkonzept #4).
 *
 * Pure and synchronous, like `skillLifecycle.ts`. It does NOT resolve team
 * membership, org membership or sharing grants itself — `SkillResolutionContext`
 * takes all three as already-resolved inputs, same seam as
 * `missingRequiredCapabilities` taking an already-resolved `granted` set in
 * P1. P3 is the phase that knows how to ask `GrantStore` for `sharedSkillIds`
 * and however membership is sourced for `memberTeams`/`orgId`; this module
 * only knows what to do once it has the answer.
 *
 * ## The dangerous case this resolver is built to avoid
 *
 * A shadowing resolver's failure mode is never "returns nothing" — it's
 * "returns something, from the WRONG level, and nobody notices because the
 * result isn't empty." Two instances of that shape are guarded here
 * explicitly (both covered in `test/skillResolver.test.ts`):
 *
 *  1. **Wrong precedence.** If personal and org both have a skill named `x`,
 *     returning the org one is silently wrong in the safe direction (too
 *     little personalization) but returning it INSTEAD of a more-privileged
 *     personal draft would be silently wrong in the dangerous direction. This
 *     resolver always evaluates buckets in strict `personal → shared → team →
 *     org` order and stops at the first non-empty one.
 *  2. **Wrong lifecycle status.** An unpublished skill (`draft` / `reviewed` /
 *     `archived`, #577 P1) must never win a resolution just because it sits
 *     at a higher-precedence level than a published one elsewhere — that
 *     would silently serve unreviewed content ahead of reviewed content.
 *     Non-`published` candidates are filtered out BEFORE bucketing, not
 *     merely deprioritized.
 *
 * A third case that is not "wrong level" but is the same silent-corruption
 * shape: two candidates tie within one bucket (e.g. a data bug lets two org
 * skills share a name). Resolution refuses to arbitrarily pick one — it
 * reports `ambiguous` with the level and the full candidate set, exactly the
 * "absence/uncertainty is a type, not a value" posture `resolveCapabilities`
 * (#575) and `RoleSourceRegistry` (#333) already use elsewhere in this repo.
 */

import { parseSessionScope, type ScopeId } from '@omadia/channel-sdk';
import type { SkillLifecycleStatus } from './skillLifecycle.js';

export type SkillResolutionLevel = 'personal' | 'shared' | 'team' | 'org';

/** The minimal shape a resolvable skill row needs — deliberately narrow. */
export interface ResolvableSkill {
  readonly id: string;
  readonly name: string;
  /** Wire form of the owner `ScopeId`, or `null` for an unowned (legacy) skill. */
  readonly ownerScope: string | null;
  readonly lifecycleStatus: SkillLifecycleStatus;
}

export interface SkillResolutionContext {
  /** Who/what is asking. Only `kind: 'personal'` ever populates the `personal` bucket. */
  readonly requesterScope: ScopeId;
  /** `groupRef`s (teams) the requester currently belongs to. */
  readonly memberTeams: ReadonlySet<string>;
  /** The org the requester belongs to, or `undefined` if none. */
  readonly orgId: string | undefined;
  /** Skill ids explicitly granted to the requester by another owner (#575 `GrantStore`, wired in P3). */
  readonly sharedSkillIds: ReadonlySet<string>;
}

export type SkillResolutionResult<T extends ResolvableSkill> =
  | { readonly ok: true; readonly level: SkillResolutionLevel; readonly skill: T }
  | { readonly ok: false; readonly reason: 'not-found' }
  | {
      readonly ok: false;
      readonly reason: 'ambiguous';
      readonly level: SkillResolutionLevel;
      readonly candidates: readonly T[];
    };

function isOwnedPersonalBy(ownerScope: string, requester: ScopeId): boolean {
  if (requester.kind !== 'personal') return false;
  const parsed = parseSessionScope(ownerScope);
  return parsed.kind === 'personal' && parsed.userId === requester.userId;
}

function isOwnedByAnyTeam(ownerScope: string, memberTeams: ReadonlySet<string>): boolean {
  const parsed = parseSessionScope(ownerScope);
  return parsed.kind === 'group' && memberTeams.has(parsed.groupRef);
}

function isOwnedByOrg(ownerScope: string, orgId: string | undefined): boolean {
  if (orgId === undefined) return false;
  const parsed = parseSessionScope(ownerScope);
  return parsed.kind === 'org' && parsed.orgId === orgId;
}

/**
 * Resolve `name` against `candidates` for the requester described by `ctx`.
 * Case-sensitive on `name` — same rule as everywhere else in the #577 model:
 * an identity this module didn't mint is never case-folded.
 */
export function resolveSkillByName<T extends ResolvableSkill>(
  name: string,
  candidates: readonly T[],
  ctx: SkillResolutionContext,
): SkillResolutionResult<T> {
  // Published + owned only. An unowned (`ownerScope === null`) row has no
  // home to bucket it by and can never win a scope-ordered resolution.
  const eligible = candidates.filter(
    (c) => c.name === name && c.lifecycleStatus === 'published' && c.ownerScope !== null,
  );

  const buckets: readonly [SkillResolutionLevel, readonly T[]][] = [
    ['personal', eligible.filter((c) => isOwnedPersonalBy(c.ownerScope as string, ctx.requesterScope))],
    ['shared', eligible.filter((c) => ctx.sharedSkillIds.has(c.id))],
    ['team', eligible.filter((c) => isOwnedByAnyTeam(c.ownerScope as string, ctx.memberTeams))],
    ['org', eligible.filter((c) => isOwnedByOrg(c.ownerScope as string, ctx.orgId))],
  ];

  for (const [level, group] of buckets) {
    if (group.length === 1) return { ok: true, level, skill: group[0] as T };
    if (group.length > 1) return { ok: false, reason: 'ambiguous', level, candidates: group };
  }
  return { ok: false, reason: 'not-found' };
}
