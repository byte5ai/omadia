/**
 * #575 Phase 2 — the audience floor: "given who is present, what may happen in
 * this room?"
 *
 * `specs/575-scope-and-identity-foundation/spec.md` §6 draws the line this file
 * sits on: **#333 produces Principals, #575 consumes them and produces
 * decisions.** Phase 1 gave the typed scope; #333 phases 1-3 gave Principals and
 * the sources that say what they are entitled to. This is the first module that
 * decides something.
 *
 * ## The floor is one function, not one interception point
 *
 * Spec §5.2 is emphatic that "the audience floor" is three guards with three
 * different correctness requirements, and that planning it as a single
 * interception point is the most common way to get it wrong:
 *
 * | What is guarded | Where it must be evaluated | Why not per-turn |
 * |---|---|---|
 * | Egress (tool calls) | **per call** | a turn-start snapshot is a TOCTOU hole — the audience can change before the call fires |
 * | Context / memory retrieval | **per retrieval, per recipient** | the rendered context differs per recipient by definition |
 * | File / credential handles | **at handle resolution** | the handle outlives the turn, so the check must ride with it |
 *
 * So this module exports the *intersection*, and the three guards share it.
 * {@link audienceFloor} is pure and cheap precisely so calling it per tool call
 * is affordable.
 *
 * ## Mid-turn joiners — split by reversibility (spec §5.3, decision D4)
 *
 * A floor is a value, not a subscription, and that is deliberate. Context that
 * has already been rendered cannot be un-sent, so re-filtering it mid-turn is
 * theatre: the context guard **snapshots** its floor. An outbound call that has
 * not fired yet *can* still be refused, so the egress guard **re-computes**
 * before each call. Any single answer for both is wrong in one direction.
 *
 * ## Where this sits relative to the two gates already on the path (spec §5.4)
 *
 * Every turn already passes Privacy Shield v4 (data minimization *toward* the
 * model) and #579's inbound screening (untrusted content coming *from* outside).
 * The floor is a third gate, and the ordering is not arbitrary:
 *
 *   1. **#579 inbound screening** — on the way in, before anything is trusted.
 *   2. **Audience floor** — before an effect is produced or context is rendered.
 *   3. **Privacy Shield** — at the data-plane boundary, on whatever survives.
 *
 * The floor runs before Privacy Shield because it decides *whether* an effect
 * happens at all; Privacy Shield decides what a permitted effect may carry.
 * Reversing them would mean minimizing data for a call that should never have
 * been made.
 *
 * ## Everything here fails CLOSED, and that is the whole point
 *
 * "The intersection of the rights of everyone present" has a trap in it: the
 * intersection of *nothing* is *everything*. An empty audience must therefore
 * never be read as "nobody is here, so nothing is restricted" — spec §5.1 calls
 * getting this backwards "a silent full-permission grant".
 *
 * That trap is live today, not hypothetical: `ChatParticipantsProvider`'s own
 * contract says "returning an empty array is a valid **unknown / unavailable**
 * state". An empty roster already means *unknown*, so this module refuses to
 * build a floor from a bare participant list at all — {@link Audience} makes the
 * caller state which it is.
 */

import type { Principal } from './principal.js';

/**
 * An opaque capability token — `'tool:web_search'`, `'memory:read:/notes'`.
 *
 * Deliberately a string and deliberately NOT a role. Intersecting role *labels*
 * would be wrong in a way that looks right: two people with different roles may
 * well share a right, and intersecting `{'admin'} ∩ {'approver'}` yields nothing
 * while both principals can in fact do the thing. The floor intersects what
 * people MAY DO, and the mapping from roles to capabilities belongs to the grant
 * store, not here.
 */
export type Capability = string;

/** Why an audience could not be established. Never means "nobody is present". */
export type AudienceUnknownReason =
  /** No participant provider is installed — HTTP and web turns (spec §5.1). */
  | 'no_provider'
  /** The provider threw or timed out. */
  | 'provider_failed'
  /**
   * The provider returned an empty roster. Its documented contract treats that
   * as "unknown / unavailable", NOT as "the room is empty", so it lands here.
   */
  | 'empty_roster';

/** One participant, once we have tried to turn them into a Principal. */
export type AudienceMember =
  | {
      readonly kind: 'resolved';
      readonly principal: Principal;
      /** What this principal may do. Empty is a real answer: they may do nothing. */
      readonly capabilities: ReadonlySet<Capability>;
      /**
       * What this principal is explicitly FORBIDDEN, whatever their grants say.
       *
       * Required rather than optional, deliberately. An optional field that a
       * caller forgets to thread produces an empty denial set — which is the
       * direction that silently WIDENS the floor. Making it mandatory turns
       * that omission into a compile error instead of a permission bug.
       */
      readonly denials: ReadonlySet<Capability>;
    }
  | {
      readonly kind: 'unresolved';
      /** Operator-readable. Belongs in logs, never in an HTTP body. */
      readonly reason: string;
    };

/**
 * Who is in the room.
 *
 * `known` may legitimately contain `unresolved` members — a guest with no
 * directory record is present even though we cannot say what they may do. That
 * case closes the floor rather than being silently dropped, which is the
 * difference between "we bounded the room" and "we bounded the part of the room
 * we could see".
 */
export type Audience =
  | { readonly kind: 'known'; readonly members: readonly AudienceMember[] }
  | { readonly kind: 'unknown'; readonly reason: AudienceUnknownReason };

/**
 * The computed floor.
 *
 * `closed` is not the same as `open` with an empty capability set, even though
 * both permit nothing. `open` means "we know exactly what this room allows and
 * it is nothing"; `closed` means "we could not establish the room". The first is
 * a policy outcome, the second is an outage — and an operator staring at a
 * blocked workflow needs to tell them apart. Same reasoning as `partial` on
 * #333's role lookups.
 */
export type AudienceFloor =
  | { readonly outcome: 'open'; readonly capabilities: ReadonlySet<Capability> }
  | { readonly outcome: 'closed'; readonly reason: string };

/** What #333's join hands back for one participant. */
export interface ResolvedAudienceMember {
  readonly principal: Principal;
  readonly capabilities: ReadonlySet<Capability>;
  /** Explicit prohibitions. See {@link AudienceMember} for why it is required. */
  readonly denials: ReadonlySet<Capability>;
}

/**
 * Turn a roster into an {@link Audience}, refusing to invent one.
 *
 * `participants` is what `ChatParticipantsProvider` returned, or `undefined`
 * when no provider is installed. `resolve` is #333's join — participant to
 * Principal plus capabilities — and returns `undefined` for anyone it cannot
 * place.
 *
 * The empty-roster case is the load-bearing one, and it is why this helper
 * exists rather than callers assembling an `Audience` by hand.
 */
export async function resolveAudience<TParticipant>(
  participants: readonly TParticipant[] | undefined,
  resolve: (participant: TParticipant) => Promise<ResolvedAudienceMember | undefined>,
): Promise<Audience> {
  if (participants === undefined) return { kind: 'unknown', reason: 'no_provider' };
  if (participants.length === 0) return { kind: 'unknown', reason: 'empty_roster' };

  const members = await Promise.all(
    participants.map(async (participant): Promise<AudienceMember> => {
      try {
        const resolved = await resolve(participant);
        return resolved
          ? {
              kind: 'resolved',
              principal: resolved.principal,
              capabilities: resolved.capabilities,
              denials: resolved.denials,
            }
          : { kind: 'unresolved', reason: 'no principal could be resolved for this participant' };
      } catch (err) {
        return {
          kind: 'unresolved',
          reason: `resolution threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );

  return { kind: 'known', members };
}

/**
 * The intersection every guard shares: what may happen with THIS audience
 * present.
 *
 * Three ways it closes, and all three are refusals to guess:
 *
 *  1. The audience is `unknown` — including an empty roster, which the provider
 *     contract already defines as unknown.
 *  2. A member is `unresolved` — somebody is in the room whose rights we cannot
 *     bound, so the room cannot be bounded either.
 *  3. `known` with no members at all — a shape callers should not build, but
 *     intersecting it would yield "everything", so it is refused explicitly
 *     rather than left to the reduce.
 *
 * Otherwise the floor is the set intersection across resolved members, minus
 * every explicit denial. An empty result is `open` with nothing in it — a real
 * answer, not a failure.
 *
 * ## Allowances INTERSECT, prohibitions UNION — and the asymmetry is the point
 *
 * Spec §5.2 states the rule as "allowlist ∩, denylist ∪". They are not two
 * spellings of one operation:
 *
 *  - An **allowance** is a statement about what a principal MAY do, so a room
 *    may only do what everyone may do. Intersect.
 *  - A **prohibition** is a statement about what a principal must NOT be party
 *    to, and it binds the room even if only one participant carries it. Union.
 *
 * Applying intersection to prohibitions would mean a rule only bites when
 * *everyone* is under it — which inverts what a prohibition is for. Applying
 * union to allowances would hand the room the most permissive participant's
 * rights, which is the classic full-permission grant.
 *
 * ## A denial beats a grant, rather than merely being absent from one
 *
 * Subtracting denials AFTER the intersection is what makes them override roles.
 * If a prohibition were expressed as "simply do not grant it", then adding any
 * role that happens to confer the capability would silently lift it — an
 * operator's explicit "this person must never do X" would be undone by an
 * unrelated role assignment somewhere else.
 */
export function audienceFloor(audience: Audience): AudienceFloor {
  if (audience.kind === 'unknown') {
    return { outcome: 'closed', reason: `audience unknown (${audience.reason})` };
  }

  const unresolved = audience.members.filter((m) => m.kind === 'unresolved');
  if (unresolved.length > 0) {
    return {
      outcome: 'closed',
      reason: `${unresolved.length} participant(s) could not be resolved to a principal`,
    };
  }

  const resolved = audience.members.filter(
    (m): m is Extract<AudienceMember, { kind: 'resolved' }> => m.kind === 'resolved',
  );
  if (resolved.length === 0) {
    // The intersection of nothing is everything. Never return that.
    return { outcome: 'closed', reason: 'audience is known but has no members' };
  }

  let capabilities = new Set<Capability>(resolved[0]?.capabilities ?? []);
  for (const member of resolved.slice(1)) {
    capabilities = new Set([...capabilities].filter((c) => member.capabilities.has(c)));
    if (capabilities.size === 0) break;
  }

  // Prohibitions are collected across EVERY resolved member, including the ones
  // whose allowances the intersection has already discarded: a denial is not a
  // missing grant, it is a veto, and it must be read even from a participant who
  // was granted nothing.
  const denied = new Set<Capability>();
  for (const member of resolved) {
    for (const capability of member.denials) denied.add(capability);
  }

  return {
    outcome: 'open',
    capabilities: new Set([...capabilities].filter((c) => !denied.has(c))),
  };
}

/**
 * Whether `capability` is permitted under `floor`.
 *
 * The single predicate the three guards call. A `closed` floor permits nothing —
 * stated here once so no guard has to remember to check `outcome` first, which
 * is exactly the check that gets forgotten.
 */
export function floorPermits(floor: AudienceFloor, capability: Capability): boolean {
  return floor.outcome === 'open' && floor.capabilities.has(capability);
}
