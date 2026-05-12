/**
 * Sentinel a channel agent emits when it deliberately has nothing to say.
 * The literal string must be the entire answer (whitespace trimmed); anything
 * else — including "NO_REPLY because ..." — is treated as a real answer and
 * forwarded normally, which surfaces model misbehaviour in logs instead of
 * silently swallowing context-leaking explanations.
 */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

export function isNoReply(answer: { text: string } | null | undefined): boolean {
  if (!answer) return false;
  return answer.text.trim() === NO_REPLY_SENTINEL;
}

/** Lightweight structured log so dropped replies are observable. */
export function logNoReplyDrop(
  channel: string,
  meta: Record<string, unknown> = {},
): void {
  console.log('[no-reply] dropped', { channel, ...meta });
}
