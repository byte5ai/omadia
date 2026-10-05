/**
 * #1212 — the one way a tool loop may add an instruction mid-turn.
 *
 * Every loop in this package (the orchestrator's buffered and streaming
 * loops, `LocalSubAgent`) re-sends the whole conversation once per iteration.
 * The system prompt must stay byte-identical across those iterations: on the
 * current Opus/Fable models a thinking block is signed against the
 * conversation prefix it was produced under, so editing the system prompt
 * between iterations invalidates that binding for every earlier turn — and it
 * also throws away the prompt-cache prefix. The sanctioned shape is
 * append-only: a text block at the END of the newest user turn, after its
 * `tool_result` blocks.
 *
 * So: wrap-up / finalize directives, obligation reminders and live user
 * steering all go through here, never into `buildSystemBlocks`.
 */

/**
 * One turn of the loosely-typed Anthropic-shaped transcript both loops carry
 * internally. `content` stays `unknown[]` rather than their own
 * `ContentBlock = any`: this module only ever CONSTRUCTS a text block and
 * spreads what is already there, so it never needs to read a block's fields.
 */
export interface MutableTurnMessage {
  role: 'user' | 'assistant';
  content: unknown[] | string;
}

/**
 * Append `text` to the newest user turn as its own trailing text block.
 *
 * A string-content turn (the original user message, before any tool round) is
 * promoted to blocks rather than concatenated, so the appended instruction
 * never reads as part of what the user wrote. Both readers that collapse
 * non-string content — `resolvePrependRules` and `messagesCarryImages` — run
 * once at turn start, before any loop iteration, so the promotion is invisible
 * to them.
 *
 * When the newest turn is an assistant message (no path in the current loops
 * reaches that, but a future one might), a fresh user turn is pushed instead:
 * appending to the assistant turn would break the strict role alternation the
 * API requires.
 *
 * Says `text` unconditionally. Callers that could reach the same iteration
 * twice own the "once per turn" decision — see `finalizeDirectiveAppended` in
 * `orchestrator.ts` and `wrapUpNoteAppended` in `localSubAgent.ts`.
 */
export function appendTextToLastUserTurn(
  messages: MutableTurnMessage[],
  text: string,
): void {
  const block = { type: 'text', text };
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'user') {
    messages.push({ role: 'user', content: [block] });
    return;
  }
  const blocks: unknown[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content;
  last.content = [...blocks, block];
}
