/**
 * Spec 2042 §5.12, criterion 24 — who reads a conversation NOW, for the
 * discretion check of a proactive message at send time.
 *
 * A trigger stores the readers its creating turn resolved; a message sent
 * days later must be checked against the people in the room when it goes out
 * (someone may have joined the HR chat since). This reads the channel's
 * roster fresh and maps every human member to a canonical omadia user id,
 * the same join the turn audience uses (`resolveTurnAudience`).
 *
 * Fails closed: no roster provider, a roster that is not complete, an empty
 * one, or a member that does not resolve → `unknown` readers, and the
 * discretion check refuses anything labelled.
 */

import { rosterStatusOf, type ConversationRoster } from '@omadia/channel-sdk';
import { readersOf, UNKNOWN_READERS, type Readers } from '@omadia/orchestrator';
import type { ChannelKind, KnowledgeGraph } from '@omadia/plugin-api';

export type ConversationReaders = (channel: string, conversationId: string) => Promise<Readers>;

export interface ConversationReadersDeps {
  readonly getRoster: (
    channel: string,
    conversationId: string,
    opts: { readonly fresh: true },
  ) => Promise<ConversationRoster | undefined>;
  readonly knowledgeGraph: () => KnowledgeGraph | undefined;
  /** The identity kind a channel's members resolve under; undefined = not resolvable. */
  readonly channelKindOf: (channel: string) => ChannelKind | undefined;
  readonly log?: (message: string) => void;
}

export function createConversationReaders(deps: ConversationReadersDeps): ConversationReaders {
  return async (channel, conversationId) => {
    const kg = deps.knowledgeGraph();
    const channelKind = deps.channelKindOf(channel);
    if (!kg || !channelKind) return UNKNOWN_READERS;
    try {
      const roster = await deps.getRoster(channel, conversationId, { fresh: true });
      if (!roster || rosterStatusOf(roster) !== 'complete') return UNKNOWN_READERS;
      const humans = roster.participants.filter((p) => p.isBot !== true);
      if (humans.length === 0) return UNKNOWN_READERS;
      const ids = await Promise.all(
        humans.map(async (p) => {
          // Teams lists a member under its `29:` id with the AAD object id
          // beside it; a sender is keyed on the AAD id. Same merge as the turn.
          const aadObjectId = channelKind === 'teams' ? (p.externalId ?? undefined) : undefined;
          const { omadiaUserId } = await kg.resolveOrCreateChannelIdentity({
            channelKind,
            channelUserId: aadObjectId ?? p.userRef.id,
            ...(aadObjectId ? { aadObjectId } : {}),
          });
          return omadiaUserId || undefined;
        }),
      );
      if (ids.some((id) => id === undefined)) return UNKNOWN_READERS;
      return readersOf(ids as string[]);
    } catch (err) {
      deps.log?.(`[triggers] readers of ${channel}/${conversationId} unknown: ${err instanceof Error ? err.message : String(err)}`);
      return UNKNOWN_READERS;
    }
  };
}
