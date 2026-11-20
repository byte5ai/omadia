/**
 * Spec 2042 §5.3 × §5.12 — triggers and an agent's own bot.
 *
 * A proactive delivery goes out through the bot the trigger's conversation
 * came through. The channel plugin names that bot on the delivery ref
 * (`asChannelKey`, the bot's routing key); the kernel delivers only while the
 * bot is still the agent's, so a bot re-provisioned for another agent never
 * says an old trigger's words in the new agent's name.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The agent bot a delivery ref names, normalised like a routing key; undefined = the shared bot. */
export function asChannelKeyOf(ref: unknown): string | undefined {
  if (!isRecord(ref)) return undefined;
  const key = ref['asChannelKey'];
  if (typeof key !== 'string') return undefined;
  const normalized = key.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

/**
 * Whether `authorId` (as a channel reports a message's author) is the bot with
 * routing key `ownKey`. A routing key is the author id itself (Teams
 * `28:<appId>`) or the author id under the channel's prefix (Telegram
 * `tg:<botId>`, Discord `discord-app:<appId>`, Slack `slack-bot:<member id>`).
 */
export function isOwnBotAuthor(ownKey: string | undefined, authorId: string): boolean {
  if (!ownKey) return false;
  const key = ownKey.trim().toLowerCase();
  const author = authorId.trim().toLowerCase();
  if (author === '') return false;
  return key === author || key.endsWith(`:${author}`);
}
