import type { ChatTurnInput } from '@omadia/channel-sdk';
import { canonicalOwners, type ChannelKind, type KnowledgeGraph } from '@omadia/plugin-api';

import type { ChatParticipantsProvider } from './chatParticipants.js';

/**
 * Member-scoped memory — who is present in a turn's room, as canonical omadia
 * user ids.
 *
 * The rule the `members` context-memory mode enforces: knowledge belongs to
 * the people present when it was created (its owners), and a turn may use it
 * only when everyone present is one of them. Both halves need this set — it
 * becomes a new turn's `owners`, and it is the audience every read checks.
 *
 * `unknown` is not "nobody": it means the room could not be established
 * reliably, and every caller treats it as "no member-scoped knowledge in, and
 * nothing this turn learns is owned by anyone". Cases that end there:
 *
 *  - no knowledge graph, no channel, no sender;
 *  - a group whose roster the adapter did not mark complete — Telegram lists
 *    administrators only, so a silent member would be invisible to the rule;
 *  - any member that does not resolve to a canonical id.
 *
 * Personal scopes and API-key turns are one-person rooms: the sender alone.
 */
export type TurnAudience =
  | { readonly kind: 'known'; readonly members: readonly string[] }
  | { readonly kind: 'unknown'; readonly reason: string };

/** The `TurnOrigin.channelType` values that map onto a KG channel kind. */
const CHANNEL_KIND_BY_ORIGIN: Readonly<Record<string, ChannelKind>> = {
  teams: 'teams',
  telegram: 'telegram',
  api: 'api',
};

const unknown = (reason: string): TurnAudience => ({ kind: 'unknown', reason });

export async function resolveTurnAudience(
  knowledgeGraph: KnowledgeGraph | undefined,
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity' | 'origin'>,
  participants: ChatParticipantsProvider | undefined,
): Promise<TurnAudience> {
  if (!knowledgeGraph) return unknown('no-knowledge-graph');
  const channelKind =
    input.channelIdentity?.channelKind ??
    (input.origin ? CHANNEL_KIND_BY_ORIGIN[input.origin.channelType] : undefined);
  if (!channelKind) return unknown('no-channel');
  const senderId = input.channelIdentity?.channelUserId ?? input.userId;
  if (!senderId) return unknown('no-sender');

  const resolve = async (channelUserId: string, aadObjectId?: string): Promise<string | undefined> => {
    const result = await knowledgeGraph.resolveOrCreateChannelIdentity({
      channelKind,
      channelUserId,
      ...(aadObjectId ? { aadObjectId } : {}),
    });
    return result.omadiaUserId || undefined;
  };

  try {
    // Teams keys a sender on its AAD object id (`from.aadObjectId ?? from.id`);
    // passing it as such lets the identity layer merge on it, exactly as the
    // roster entries below are merged.
    const sender = await resolve(
      senderId,
      channelKind === 'teams' && !senderId.startsWith('29:') ? senderId : undefined,
    );
    if (!sender) return unknown('sender-unresolved');
    if (channelKind === 'api' || input.origin?.scope.kind === 'personal') {
      return { kind: 'known', members: [sender] };
    }

    if (!participants) return unknown('no-roster');
    if (participants.completeRoster !== true) return unknown('roster-incomplete');
    const humans = (await participants()).filter((p) => p.kind !== 'agent');
    if (humans.length === 0) return unknown('roster-empty');
    // Teams keys a sender on the AAD object id (`from.aadObjectId ?? from.id`),
    // the roster on the Bot Framework `29:` id with the AAD id beside it. Use
    // the AAD id for both so one person lands in one cluster.
    const ids = await Promise.all(
      humans.map((p) =>
        channelKind === 'teams' && p.aadObjectId
          ? resolve(p.aadObjectId, p.aadObjectId)
          : resolve(p.channelUserId),
      ),
    );
    if (ids.some((id) => id === undefined)) return unknown('member-unresolved');
    return { kind: 'known', members: canonicalOwners([sender, ...(ids as string[])]) };
  } catch (err) {
    console.warn(
      `[memory] member-scoped memory: audience resolution failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return unknown('resolution-failed');
  }
}
