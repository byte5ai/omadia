/**
 * #1841 / ADR-0191 — `memory` notes under prompt masking.
 *
 * A prompt surrogate (`PLATZHALTER-CUSTOM-1`, a pool name, a pool address)
 * means one value for ONE turn: the next turn mints the same surrogate for
 * whatever value it meets first. A note the model wrote with the surrogates
 * it saw therefore read as a fact about a different value in a later turn.
 *
 * With `mask_user_prompt` on, the `memory` tool now works like every other
 * persisted text (ADR-0095 "restore"):
 *
 *   - **Restore on write.** Every string of the tool input is restored to the
 *     user's values with the turn's full map (`restorePromptPseudonyms`)
 *     before the handler runs, so the stored note carries real values. A
 *     surrogate restore cannot map refuses the call: storing it would make the
 *     note ambiguous in every later turn.
 *   - **Re-mask on read.** Every result the model reads is masked through the
 *     READING turn's map (`maskUserPrompt`, origin `context`): a value the
 *     user named in this turn gets this turn's surrogate, any other masked
 *     type a fresh one. A failing mask withholds the result.
 *   - **Old notes.** A note stored before this change can still carry a
 *     surrogate the reading turn has minted for another value. Such a result
 *     is withheld with a notice instead of being read as a fact about the
 *     wrong value.
 *
 * With masking off nothing changes: the model saw the user's values and wrote
 * them, and reads them back as before (only the #1544 echo re-mask applies).
 */

import { internFailedNotice } from './privacyInternPolicy.js';
import { remaskEchoedValues } from './promptSurrogateToolInput.js';
import type { PrivacyTurnHandle } from './privacyHandle.js';
import { MEMORY_TOOL_NAME } from './registry/subAgentMemoryTool.js';

/** The tool whose input and results this module handles. */
export function isMemoryNoteTool(toolName: string): boolean {
  return toolName === MEMORY_TOOL_NAME;
}

/** Kernel-authored, PII-free: a note whose surrogates restore cannot map. */
export const MEMORY_NOTE_UNRESOLVED_NOTICE =
  'Error: the memory note was not saved: it contains placeholders that could not be mapped ' +
  'back to the values they stand for. Write it again and quote every term exactly as it ' +
  'appears in this conversation.';

/** Kernel-authored, PII-free: a note written with an earlier turn's surrogates. */
export const MEMORY_NOTE_STALE_SURROGATE_NOTICE =
  'Error: this memory content was withheld: it holds placeholders from an earlier ' +
  'conversation that stand for different values in this one. Treat what it says as unknown ' +
  'and do not rely on it; tell the user you have no reliable note on this.';

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
  else if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, into));
  }
  return into;
}

/** A copy of `value` with `restore` applied to every string leaf; the same
 *  object when nothing changed (byte-identical input for ledger and logs). */
async function mapStringsAsync(
  value: unknown,
  restore: (text: string) => Promise<string>,
): Promise<unknown> {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) {
    const mapped = await Promise.all(value.map((item) => mapStringsAsync(item, restore)));
    return mapped.some((item, i) => item !== value[i]) ? mapped : value;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const mapped = await Promise.all(
      entries.map(async ([key, item]) => [key, await mapStringsAsync(item, restore)] as const),
    );
    return mapped.some(([, item], i) => item !== entries[i]![1])
      ? Object.fromEntries(mapped)
      : value;
  }
  return value;
}

/**
 * Whether the turn masks the user's prompt. A preview call: it neither
 * extends the map nor books anything. A blocked preview counts as on, so the
 * caller takes the fail-closed path; a throwing preview propagates to the
 * caller's fail-closed catch.
 */
async function promptMaskingOn(privacy: PrivacyTurnHandle, probe: string): Promise<boolean> {
  // A hand-built handle without the member masks no prompt, so no
  // placeholder of it can reach a note.
  if (probe.length === 0 || typeof privacy.maskUserPrompt !== 'function') return false;
  const preview = await privacy.maskUserPrompt(probe, { preview: true, origin: 'context' });
  return preview.outcome !== 'disabled';
}

async function carriesTurnSurrogates(privacy: PrivacyTurnHandle, text: string): Promise<boolean> {
  if (typeof privacy.countUnresolvedSurrogates !== 'function') return false;
  return (await privacy.countUnresolvedSurrogates(text, { unreadableLiterals: false })) > 0;
}

export type MemoryNoteInput =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly notice: string };

/**
 * The input the `memory` handler gets: with prompt masking on, every string
 * restored to the user's values. `ok: false` when restore failed or left a
 * surrogate of this turn in place — the handler must not run.
 */
export async function restoreMemoryNoteInput(
  privacy: PrivacyTurnHandle | undefined,
  input: unknown,
): Promise<MemoryNoteInput> {
  if (privacy === undefined) return { ok: true, input };
  const strings = collectStrings(input, []);
  try {
    if (!(await promptMaskingOn(privacy, strings.join('\n')))) return { ok: true, input };
    const restored = await mapStringsAsync(input, (text) =>
      privacy.restorePromptPseudonyms(text),
    );
    if (await carriesTurnSurrogates(privacy, collectStrings(restored, []).join('\n'))) {
      console.warn('[privacy] memory note refused: a surrogate could not be restored');
      return { ok: false, notice: MEMORY_NOTE_UNRESOLVED_NOTICE };
    }
    return { ok: true, input: restored };
  } catch (err) {
    console.error(
      `[privacy] memory note restore failed — call refused: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, notice: MEMORY_NOTE_UNRESOLVED_NOTICE };
  }
}

export type MemoryNoteText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly notice: string };

/**
 * Stored memory text on its way to a model. Masking off: the #1544 echo
 * re-mask only, as before. Masking on: withheld when it carries a surrogate
 * this turn uses (an old note), else masked through this turn's map.
 */
export async function maskMemoryNoteText(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
): Promise<MemoryNoteText> {
  if (privacy === undefined) return { ok: true, text };
  try {
    if (!(await promptMaskingOn(privacy, text))) {
      return { ok: true, text: remaskEchoedValues(privacy, text) };
    }
    if (await carriesTurnSurrogates(privacy, text)) {
      console.warn('[privacy] memory content withheld: it carries surrogates of an earlier turn');
      return { ok: false, notice: MEMORY_NOTE_STALE_SURROGATE_NOTICE };
    }
    const result = await privacy.maskUserPrompt(remaskEchoedValues(privacy, text), {
      origin: 'context',
    });
    if (result.outcome === 'blocked') {
      console.error(`[privacy] memory content withheld: masking blocked (${result.reason})`);
      return { ok: false, notice: internFailedNotice(MEMORY_TOOL_NAME) };
    }
    return { ok: true, text: result.outcome === 'masked' ? result.maskedText : text };
  } catch (err) {
    console.error(
      `[privacy] memory content withheld: masking failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, notice: internFailedNotice(MEMORY_TOOL_NAME) };
  }
}

/** {@link maskMemoryNoteText} for a tool result: the notice in place of a
 *  withheld text. */
export async function maskMemoryNoteResult(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
): Promise<string> {
  const masked = await maskMemoryNoteText(privacy, text);
  return masked.ok ? masked.text : masked.notice;
}
