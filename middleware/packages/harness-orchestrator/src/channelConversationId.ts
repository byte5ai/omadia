// The channel-native conversation id of a turn (#2043, rollout defect D13).
//
// A tool, a subscription check and a send all need the id the CHANNEL uses
// for a conversation. The turn carried only the session scope, into which
// every adapter folds things of its own (`<channelId>::<id>`, `teams-<id>`,
// and for a bot with its own identity `teams-<botKey>-<id>`), and the kernel
// took it apart again. It did not know the bot-key form, so a facilitator's
// tools were told the conversation was `28:<appId>-19:meeting_…@thread.v2`:
// readiness asked Graph about that string, got a 400, and no facilitation
// could start in Teams.
//
// The channel now STATES the id (`TurnOrigin.channelConversationId`), and the
// kernel uses it as given: opaque, never trimmed, `;messageid=<root>` of a
// channel thread kept. Parsing the scope remains only as the fallback for a
// channel that does not state it, and knows the bot-key form.

import type { ChatTurnInput } from '@omadia/channel-sdk';

/**
 * `<botKey>-` at the start of what follows the channel prefix. A bot key is
 * `<digits>:<app id>` with the app id a GUID (Teams: `28:<guid>`); a
 * conversation id never starts that way (Teams ids start `19:` followed by a
 * token without the GUID shape, or `a:`), so the match cannot eat part of one.
 */
const BOT_KEY_PREFIX =
  /^\d{1,3}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?=.)/i;

function stated(input: ChatTurnInput): string | undefined {
  const id = input.origin?.channelConversationId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The readings of a session scope, most specific last. Fallback only. */
function derivedFromScope(input: ChatTurnInput): readonly string[] {
  const scope = input.origin?.scope;
  if (!scope || scope.kind !== 'conversation') return [];
  const raw = scope.conversationId;
  const readings = [raw];
  const separatorAt = raw.indexOf('::');
  if (separatorAt >= 0) readings.push(raw.slice(separatorAt + 2));
  const prefix = `${input.origin!.channelType}-`;
  if (raw.startsWith(prefix)) {
    const rest = raw.slice(prefix.length);
    readings.push(rest);
    const withoutBotKey = rest.replace(BOT_KEY_PREFIX, '');
    if (withoutBotKey !== rest) readings.push(withoutBotKey);
  }
  return readings;
}

/**
 * The channel-native conversation id of a turn: what the channel stated,
 * else the most specific reading of the session scope. `undefined` for a turn
 * that is not in a conversation.
 */
export function channelConversationId(input: ChatTurnInput): string | undefined {
  return stated(input) ?? derivedFromScope(input).at(-1);
}

/**
 * The ids under which a subscription or a post for this turn's conversation
 * may be keyed. Exactly the stated id when the channel states one; otherwise
 * every reading of the scope, because the fallback cannot know which one the
 * adapter used.
 */
export function conversationIdCandidates(input: ChatTurnInput): readonly string[] {
  const id = stated(input);
  if (id !== undefined) return [id];
  return [...new Set(derivedFromScope(input))];
}
