/**
 * #1544 — tools run on the user's values, models see the placeholders.
 *
 * With `mask_user_prompt` on, the model reads `PLATZHALTER-CUSTOM-1` where the
 * user wrote "Projekt Falkenstein" and writes its tool calls with that
 * placeholder. Nothing translated it back, so every search ran for the
 * placeholder and found nothing. The restore therefore happens where a tool
 * input stops being model text and becomes an effect: right before a tool
 * HANDLER runs (`Orchestrator.dispatchToolDeadlined` for native and MCP tools,
 * `LocalSubAgent.dispatch` for a sub-agent's inner tools).
 *
 * A domain tool is the exception: its input is the question for a sub-agent's
 * own model, so it keeps the placeholders; the sub-agent's inner tool calls are
 * restored in turn. A real value therefore reaches a tool, never a model.
 *
 * What a tool hands back to a model in clear (the interning-exempt tools —
 * `memory`, stored processes, `read_attachment`) can echo the restored value
 * ("created /memories/Projekt Falkenstein.md"). {@link remaskEchoedValues}
 * puts the placeholder back before that text reaches the model. Every other
 * result is interned by the Privacy Shield, and a tool error goes through the
 * tool-error redaction, whose known-value sweep covers the same values.
 */

import type { PrivacyTurnHandle } from './privacyHandle.js';

/** A copy of `value` with `restore` applied to every string leaf. The same
 *  object when nothing changed, so an input without placeholders stays
 *  byte-identical for the replay ledger and every log. */
function mapStrings(value: unknown, restore: (text: string) => string): unknown {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) {
    const mapped = value.map((item) => mapStrings(item, restore));
    return mapped.some((item, i) => item !== value[i]) ? mapped : value;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const mapped = entries.map(([key, item]) => [key, mapStrings(item, restore)] as const);
    return mapped.some(([, item], i) => item !== entries[i]![1])
      ? Object.fromEntries(mapped)
      : value;
  }
  return value;
}

/**
 * The input a tool handler gets: the model's input with this turn's prompt
 * placeholders restored to the user's values. Identity without a privacy
 * handle, or when the turn masked nothing.
 */
export function restorePromptSurrogatesInToolInput(
  privacy: PrivacyTurnHandle | undefined,
  input: unknown,
): unknown {
  // A provider that cannot mask an echo again (one that predates
  // `remaskPromptValues`) keeps the old behaviour: the tool gets the
  // placeholder, so nothing it returns can carry the user's value.
  if (typeof privacy?.remaskPromptValues !== 'function') return input;
  const restore =
    typeof privacy.snapshotPromptRestorer === 'function'
      ? privacy.snapshotPromptRestorer()
      : undefined;
  if (restore === undefined) return input;
  return mapStrings(input, restore);
}

/**
 * A tool result the model reads in clear, with every value this turn masked
 * in the user's prompt replaced by its placeholder again. Identity without a
 * handle, or with a provider that predates `remaskPromptValues`.
 */
export function remaskEchoedValues(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
): string {
  return typeof privacy?.remaskPromptValues === 'function'
    ? privacy.remaskPromptValues(text)
    : text;
}
