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
import { rosterStatusOf, type ChatTurnInput, type ConversationRoster } from '@omadia/channel-sdk';
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
  /**
   * #2048 — who reads this turn's answer when no roster is needed.
   *
   * `personal` is a one-reader room: a web, desktop, CLI or API turn, or a
   * channel turn whose origin says it is a 1:1. Its audience is the turn owner
   * alone, resolved by the caller (the same canonical id the run trace is filed
   * under). No owner ⇒ the audience is unknown and the floor closes.
   *
   * `shared` (and absence, for callers predating #2048) reads the roster.
   */
  readonly room?: AudienceRoom;
}

/** See {@link AudienceFloorProviderDeps.room}. */
export type AudienceRoom =
  | { readonly kind: 'personal'; readonly owner: Principal | undefined }
  | { readonly kind: 'shared' };

export function createAudienceFloorProvider(deps: AudienceFloorProviderDeps): AudienceFloorProvider {
  return async (): Promise<AudienceFloor> => {
    if (deps.room?.kind === 'personal') {
      const owner = deps.room.owner;
      if (!owner) return audienceFloor({ kind: 'unknown', reason: 'no_provider' });
      return audienceFloor(
        await resolveAudience([owner], (principal) =>
          resolveCapabilities(principal, deps.roles, deps.grants),
        ),
      );
    }

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

    // Other agents in the room are colleagues, not readers whose rights bound
    // it: their own envelopes apply when they act. Counting them would resolve
    // a bot account into a principal and hand the room its grants.
    const humans = roster?.filter((participant) => participant.kind !== 'agent');
    const audience = await resolveAudience(humans, async (participant) => {
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
      // Teams lists a member under the Bot Framework `29:` id with the AAD
      // object id beside it, while a sender is keyed on the AAD id. Resolving
      // the AAD id for both lands one person in one cluster — the same merge
      // `resolveTurnAudience` does — so a prohibition written for that person
      // binds them in a group too.
      const aadObjectId = channelKind === 'teams' ? participant.aadObjectId : undefined;
      const { omadiaUserId } = await knowledgeGraph.resolveOrCreateChannelIdentity({
        channelKind,
        channelUserId: aadObjectId ?? participant.channelUserId,
        ...(aadObjectId ? { aadObjectId } : {}),
      });
      return omadiaUserId ? makePrincipal('user', omadiaUserId) : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * #2048 — which kind of room a turn is, for {@link AudienceFloorProviderDeps.room}.
 *
 * A one-reader room needs no roster: whoever owns the turn is the only person
 * who reads the answer. That holds for
 *
 *  - turns that arrived through no channel at all (web chat, desktop and mobile
 *    UI, CLI — the HTTP path; `origin` is set only by channel plugins and the
 *    kernel's agent-turn service, `channelIdentity` only by the channel
 *    dispatcher);
 *  - the public API channel (one API key, one caller);
 *  - a channel turn whose adapter-attested origin says it is a 1:1
 *    (`personal` scope or `conversationType: 'direct'`).
 *
 * Every other channel turn is `shared` and is bounded by its roster; a channel
 * that installs none closes the floor, which is the fail-closed answer for a
 * room nobody can enumerate.
 *
 * Returns `undefined` for a **headless** turn — no channel and no owner: a
 * schedule or a Conductor step. Nobody reads its answer directly, so there is
 * no audience to intersect; it stays bounded by the agent's own grants (INV-8).
 * Without this, every scheduled run would refuse every tool.
 *
 * `turnOwnerId` is the canonical omadia user id the turn is filed under
 * (`resolveRunTraceOwner`), never a channel-native id: grants and prohibitions
 * are keyed in omadia's id space.
 */
export function audienceRoomFor(
  input: Pick<ChatTurnInput, 'channelIdentity' | 'origin'>,
  turnOwnerId: string | undefined,
): AudienceRoom | undefined {
  const viaChannel = input.channelIdentity !== undefined || input.origin !== undefined;
  if (!viaChannel && !turnOwnerId) return undefined;
  const isOneReader =
    !viaChannel ||
    input.channelIdentity?.channelKind === 'api' ||
    input.origin?.channelType === 'api' ||
    input.origin?.scope.kind === 'personal' ||
    input.origin?.conversationType === 'direct';
  if (!isOneReader) return { kind: 'shared' };
  return { kind: 'personal', owner: turnOwnerId ? makePrincipal('user', turnOwnerId) : undefined };
}

/**
 * #2048 — a {@link ChatParticipantsProvider} over a channel's conversation
 * roster, for turns that do not arrive through a channel adapter (the
 * facilitation engine's `agentTurn@2`): without one, such a turn in a group
 * would have no audience and the floor would refuse every tool.
 *
 * An unreadable roster (`undefined`, or status `unknown`) yields an empty list,
 * which the floor reads as an unknown audience and closes on. Bots are marked
 * as agents so they do not count as readers.
 */
export function chatParticipantsFromRoster(
  readRoster: () => Promise<ConversationRoster | undefined>,
): ChatParticipantsProvider {
  return async (): Promise<ChatParticipant[]> => {
    const roster = await readRoster();
    if (!roster || rosterStatusOf(roster) === 'unknown') return [];
    return roster.participants.map((p) => ({
      channelUserId: p.userRef.id,
      aadObjectId: p.externalId ?? null,
      displayName: p.userRef.displayName ?? p.userRef.id,
      email: p.userRef.email ?? null,
      userPrincipalName: p.userPrincipalName ?? null,
      ...(p.isBot === true ? { kind: 'agent' as const } : {}),
    }));
  };
}
