/**
 * Sentinel a channel agent emits when it deliberately has nothing to say.
 *
 * The strict form is the literal string `NO_REPLY` as the entire answer
 * (whitespace trimmed). In practice models sometimes append the sentinel
 * after an explanatory sentence — the "I won't reply because…" anti-pattern.
 * That trailing-line shape is matched too (regex below) and surfaced with a
 * warn-log so the audit trail keeps the model's full message, while the user
 * stays silent (since the model's *intent* was clearly to say nothing).
 *
 * What's NOT matched: bare substring `NO_REPLY` inside a real answer
 * (e.g. quoting a routine name "no_reply-tracker"). The trailing-line
 * anchor avoids those false positives.
 */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

/** Matches `NO_REPLY` on its own line at the end of the message. */
const TRAILING_SENTINEL_RE = /(?:^|\n)\s*NO_REPLY\s*$/;

export function isNoReply(answer: { text: string } | null | undefined): boolean {
  if (!answer) return false;
  const trimmed = answer.text.trim();
  if (trimmed === NO_REPLY_SENTINEL) return true;
  if (TRAILING_SENTINEL_RE.test(answer.text)) {
    // Model appended the sentinel after a prose explanation — honour the
    // intent (drop the message) but log the full text so we can spot how
    // often this happens and tighten the system prompt if it spikes.
    console.warn(
      '[no-reply] dropped non-strict NO_REPLY (model appended sentinel after explanation)',
      { originalText: answer.text },
    );
    return true;
  }
  return false;
}

/** Lightweight structured log so dropped replies are observable. */
export function logNoReplyDrop(
  channel: string,
  meta: Record<string, unknown> = {},
): void {
  console.log('[no-reply] dropped', { channel, ...meta });
}
