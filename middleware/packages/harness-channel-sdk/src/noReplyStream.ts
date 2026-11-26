import type { ChatStreamEvent } from './chatAgent.js';
import { NO_REPLY_SENTINEL, isNoReply } from './noReply.js';

/**
 * #1896 — keeps the `NO_REPLY` sentinel off a streamed turn.
 *
 * Non-streaming paths drop a bare `NO_REPLY` answer with {@link isNoReply};
 * a stream would otherwise show it twice: as `text_delta` preview and as
 * `done.answer`. This filter
 *
 *  - holds `text_delta` text back while everything visible so far could still
 *    become the sentinel (its trimmed form is a prefix of `NO_REPLY`), and
 *    releases it unchanged as soon as it cannot — or before a `tool_use`, so
 *    the order of text and tool calls stays as it was;
 *  - returns to holding when a `text_retract` takes every released character
 *    back (a preamble before a tool call), so a later iteration's bare
 *    `NO_REPLY` is held too;
 *  - replaces a `done` whose answer is a no-reply with an empty answer and
 *    `silent: true`, dropping held text; text it already released (the
 *    trailing form, "explanation\nNO_REPLY") is taken back with one
 *    `text_retract` first, so delta-assembling clients end empty as well.
 *
 * Every other event passes through in order.
 */
export async function* suppressNoReplyStream(
  events: AsyncIterable<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  let held = '';
  let holding = true;
  let released = 0;
  for await (const event of events) {
    if (event.type === 'text_delta') {
      if (!holding) {
        released += event.text.length;
        yield event;
        continue;
      }
      held += event.text;
      if (couldBecomeSentinel(held)) continue;
      holding = false;
      released += held.length;
      yield { type: 'text_delta', text: held };
      held = '';
      continue;
    }
    if (event.type === 'text_retract') {
      if (holding) {
        held = held.slice(0, Math.max(0, held.length - event.chars));
        continue;
      }
      released = Math.max(0, released - event.chars);
      if (released === 0) holding = true;
      yield event;
      continue;
    }
    if (event.type === 'done') {
      if (isNoReply({ text: event.answer })) {
        held = '';
        if (released > 0) yield { type: 'text_retract', chars: released };
        released = 0;
        yield { ...event, answer: '', silent: true };
        continue;
      }
      if (held.length > 0) {
        yield { type: 'text_delta', text: held };
        held = '';
      }
      yield event;
      continue;
    }
    if (event.type === 'tool_use' && held.length > 0) {
      released += held.length;
      yield { type: 'text_delta', text: held };
      held = '';
      holding = false;
    }
    yield event;
  }
}

function couldBecomeSentinel(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Trailing whitespace after the full sentinel still matches `isNoReply`.
  if (trimmed === NO_REPLY_SENTINEL) return true;
  return NO_REPLY_SENTINEL.startsWith(text.trimStart());
}
