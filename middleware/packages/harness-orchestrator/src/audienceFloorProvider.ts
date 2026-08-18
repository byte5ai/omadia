import {
  audienceFloor,
  makePrincipal,
  resolveAudience,
  resolveCapabilities,
  type AudienceFloor,
  type GrantStore,
  type Principal,
  type RoleSourceRegistry,
} from '@omadia/channel-sdk';
import type { ChannelKind, KnowledgeGraph } from '@omadia/plugin-api';

import type { AudienceFloorProvider } from './audienceFloorGuard.js';
import type { ChatParticipant, ChatParticipantsProvider } from './chatParticipants.js';

/**
 * #575 — assembles the audience floor from the pieces #333 and #575 phase 2 put
 * in place. This is the module that makes the three guards non-inert: until
 * something installs one of these on `turnContext.audienceFloor`, every guard
 * short-circuits and the deployment behaves exactly as before.
 *
 * The chain it runs, per evaluation:
 *
 *   roster (ChatParticipantsProvider)
 *     → Principal per participant            (#333 phase 1, via the KG join)
 *     → capabilities per Principal            (#333 phase 2 roles + #575 grants)
 *     → Audience                              (#575, fails closed on any gap)
 *     → the intersection                      (#575)
 *
 * Every failure mode along that chain has already been made explicit by the
 * layers below — an unreadable role source yields no capability set, an
 * unplaceable participant yields `unresolved`, an empty roster yields
 * `unknown` — so this module adds no policy of its own. It only wires.
 *
 * ## It deliberately does NOT cache
 *
 * The egress guard re-evaluates per tool call precisely so a participant who
 * joins mid-turn narrows the floor before the next call fires (spec §5.2,
 * TOCTOU). Memoizing the roster for the duration of a turn would make that
 * re-evaluation theatre — the guard would keep re-asking and keep getting the
 * turn's opening answer.
 *
 * Caching is not forbidden, it is simply somebody else's job: the
 * `ChatParticipantsProvider` contract already says the roster accessor is
 * "expected to be cheap (cached by the implementer)". A channel adapter knows
 * when its roster can go stale; this module does not.
 */
export interface AudienceFloorProviderDeps {
  /** The turn's roster accessor. `undefined` ⇒ the audience is unknowable. */
  readonly participants: ChatParticipantsProvider | undefined;
  /** #333's join: one chat participant to one platform Principal. */
  readonly resolvePrincipal: (participant: ChatParticipant) => Promise<Principal | undefined>;
  /** #333 phase 2 — what roles a Principal holds. */
  readonly roles: RoleSourceRegistry;
  /** #575 phase 2 — what those roles, and the Principal directly, are granted. */
  readonly grants: GrantStore;
}

export function createAudienceFloorProvider(deps: AudienceFloorProviderDeps): AudienceFloorProvider {
  return async (): Promise<AudienceFloor> => {
    let roster: readonly ChatParticipant[] | undefined;
    if (deps.participants) {
      try {
        roster = await deps.participants();
      } catch {
        // A roster accessor that blew up has not told us who is present. The
        // reason string is built by `audienceFloor` so every closed floor reads
        // the same way regardless of which step failed.
        return audienceFloor({ kind: 'unknown', reason: 'provider_failed' });
      }
    }

    const audience = await resolveAudience(roster, async (participant) => {
      const principal = await deps.resolvePrincipal(participant);
      if (!principal) return undefined;
      return resolveCapabilities(principal, deps.roles, deps.grants);
    });

    return audienceFloor(audience);
  };
}

/**
 * The participant → Principal join, over the knowledge graph.
 *
 * Mirrors `resolveTurnOwnerIdentity` (#568/#333) — the same
 * `resolveOrCreateChannelIdentity` call, applied to everyone in the room rather
 * than only the caller. Idempotent: re-resolving the same
 * `(channelKind, channelUserId)` pair returns the same id.
 *
 * Returns `undefined` — which the floor turns into an `unresolved` member and
 * therefore a closed room — rather than falling back to the channel-native id.
 * That fallback would be worse than useless here: a Teams AAD object id is not
 * a principal in omadia's id space, so grants keyed on it would silently never
 * match, and the room would look bounded while being bounded by nothing.
 */
export function knowledgeGraphPrincipalResolver(
  knowledgeGraph: KnowledgeGraph | undefined,
  channelKind: ChannelKind | undefined,
): (participant: ChatParticipant) => Promise<Principal | undefined> {
  return async (participant) => {
    // No channel kind means this turn did not arrive through a channel, so
    // there is no `(channelKind, channelUserId)` pair to resolve against. Left
    // unresolved on purpose rather than defaulted to some plausible-looking
    // kind: a wrong kind resolves to a DIFFERENT identity cluster, which would
    // hand the room somebody else's grants.
    if (!knowledgeGraph || !channelKind) return undefined;
    try {
      const { omadiaUserId } = await knowledgeGraph.resolveOrCreateChannelIdentity({
        channelKind,
        channelUserId: participant.channelUserId,
      });
      return omadiaUserId ? makePrincipal('user', omadiaUserId) : undefined;
    } catch {
      return undefined;
    }
  };
}
