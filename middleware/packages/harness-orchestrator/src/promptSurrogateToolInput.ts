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
 * Kept narrow on purpose (security review):
 *   - only whole surrogates, never name parts or re-spelled dates/amounts,
 *     and no date/amount surrogate at all (`restoreToolInputValues`), so
 *     every value put in is one {@link remaskEchoedValues} masks again;
 *   - not for a domain tool that runs a sub-agent (its input is a question
 *     for a model; the sub-agent's own tool calls are restored in turn);
 *   - not for the intern-exempt self tools (`memory`, stored processes, …):
 *     what they store is read back in clear in later turns, whose map no
 *     longer knows the value, so they keep the placeholder;
 *   - every tool result text the model gets, errors included, is re-masked
 *     with the turn's known values before it goes out.
 * A real value therefore reaches a tool, not the model — except through a
 * plugin tool that itself hands its input to a model via `ctx.llm`
 * (docs/security-architecture.md §6f).
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
  // A provider that cannot mask an echo again (one that predates these
  // methods) keeps the old behaviour: the tool gets the placeholder, so
  // nothing it returns can carry the user's value.
  if (
    typeof privacy?.remaskPromptValues !== 'function' ||
    typeof privacy.restoreToolInputValues !== 'function'
  ) {
    return input;
  }
  const handle = privacy;
  return mapStrings(input, (text) => handle.restoreToolInputValues!(text));
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
