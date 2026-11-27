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
import { LISTING_PREFIX } from './memoryIndexPrefetch.js';
import { MEMORY_TOOL_NAME } from './registry/subAgentMemoryTool.js';
import {
  EDIT_PROCESS_TOOL_NAME,
  QUERY_PROCESSES_TOOL_NAME,
  RUN_STORED_PROCESS_TOOL_NAME,
  WRITE_PROCESS_TOOL_NAME,
} from './tools/processMemoryTool.js';

/**
 * #2296 — the tools whose stored text this module handles: the `memory` tool
 * and the stored-process tools. A process is persisted text read back in
 * later turns exactly like a note (ADR-0191), so it gets the same restore on
 * write (`write_process`, `edit_process`) and re-mask on read
 * (`query_processes`, `run_stored_process`).
 */
const STORED_TEXT_TOOLS: ReadonlySet<string> = new Set([
  MEMORY_TOOL_NAME,
  WRITE_PROCESS_TOOL_NAME,
  EDIT_PROCESS_TOOL_NAME,
  QUERY_PROCESSES_TOOL_NAME,
  RUN_STORED_PROCESS_TOOL_NAME,
]);

/** The tools whose input and results this module handles. */
export function isMemoryNoteTool(toolName: string): boolean {
  return STORED_TEXT_TOOLS.has(toolName);
}

/** Kernel-authored, PII-free: a note whose surrogates restore cannot map. */
export const MEMORY_NOTE_UNRESOLVED_NOTICE =
  'Error: the note or process was not saved: it contains placeholders that could not be mapped ' +
  'back to the values they stand for. Write it again and quote every term exactly as it ' +
  'appears in this conversation.';

/** Kernel-authored, PII-free: a note written with an earlier turn's surrogates. */
export const MEMORY_NOTE_STALE_SURROGATE_NOTICE =
  'Error: this stored content was withheld: it holds placeholders from an earlier ' +
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

async function carriesTurnSurrogates(
  privacy: PrivacyTurnHandle,
  text: string,
  reservedShapes = false,
): Promise<boolean> {
  if (typeof privacy.countUnresolvedSurrogates !== 'function') return false;
  return (
    (await privacy.countUnresolvedSurrogates(text, {
      unreadableLiterals: false,
      ...(reservedShapes ? { reservedShapes: true } : {}),
    })) > 0
  );
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
    // #2296 — also a reserved-shape placeholder of an earlier turn (copied
    // from history or recall): stored, it would be withheld on every read.
    if (await carriesTurnSurrogates(privacy, collectStrings(restored, []).join('\n'), true)) {
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
  toolName: string = MEMORY_TOOL_NAME,
): Promise<MemoryNoteText> {
  if (privacy === undefined) return { ok: true, text };
  try {
    if (!(await promptMaskingOn(privacy, text))) {
      return { ok: true, text: remaskEchoedValues(privacy, text) };
    }
    // #2296 — also a reserved-shape surrogate this turn never minted: stored
    // before ADR-0191, it stands for a value nobody can name any more.
    if (await carriesTurnSurrogates(privacy, text, true)) {
      console.warn('[privacy] memory content withheld: it carries surrogates of an earlier turn');
      return { ok: false, notice: MEMORY_NOTE_STALE_SURROGATE_NOTICE };
    }
    const result = await privacy.maskUserPrompt(remaskEchoedValues(privacy, text), {
      origin: 'context',
    });
    if (result.outcome === 'blocked') {
      console.error(`[privacy] memory content withheld: masking blocked (${result.reason})`);
      return { ok: false, notice: internFailedNotice(toolName) };
    }
    return { ok: true, text: result.outcome === 'masked' ? result.maskedText : text };
  } catch (err) {
    console.error(
      `[privacy] memory content withheld: masking failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, notice: internFailedNotice(toolName) };
  }
}

/** {@link maskMemoryNoteText} for a tool result: the notice in place of a
 *  withheld text. */
export async function maskMemoryNoteResult(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
  toolName: string = MEMORY_TOOL_NAME,
): Promise<string> {
  const masked = await maskStoredTextPerEntry(privacy, text, toolName);
  return masked.ok ? masked.text : masked.notice;
}


/** Kernel-authored, PII-free: entries left out of a listing or a result. */
export function withheldEntriesNote(count: number): string {
  return `(${String(count)} entr${count === 1 ? 'y' : 'ies'} withheld: placeholders from an earlier conversation)`;
}

/**
 * #2296 / ADR-0295 — {@link maskMemoryNoteText}, but per entry when the whole
 * text is withheld for an earlier turn's placeholder: a `/memories` listing
 * line by line, a `query_processes` result hit by hit. Only the entries that
 * carry such a placeholder are left out (and counted); one old note or
 * process no longer hides every other one. Other texts (one note, one
 * process) are one entry already. The fast path is the whole text: per-entry
 * masking runs only after a stale-placeholder refusal.
 */
export async function maskStoredTextPerEntry(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
  toolName: string = MEMORY_TOOL_NAME,
): Promise<MemoryNoteText> {
  const whole = await maskMemoryNoteText(privacy, text, toolName);
  if (whole.ok || whole.notice !== MEMORY_NOTE_STALE_SURROGATE_NOTICE) return whole;
  if (text.startsWith(LISTING_PREFIX)) return maskListingPerLine(privacy, text, toolName);
  if (toolName === QUERY_PROCESSES_TOOL_NAME) return maskProcessHits(privacy, text, toolName, whole);
  return whole;
}

/**
 * Which entries carry an earlier turn's placeholder: a cheap count per entry
 * (no detector call). A failing count marks the entry stale (fail closed).
 */
async function staleEntries(privacy: PrivacyTurnHandle, entries: readonly string[]): Promise<boolean[]> {
  return Promise.all(
    entries.map((entry) => carriesTurnSurrogates(privacy, entry, true).catch(() => true)),
  );
}

function logWithheld(count: number, toolName: string): void {
  if (count === 0) return;
  console.warn(
    `[privacy] ${toolName}: ${String(count)} stored entr${count === 1 ? 'y' : 'ies'} withheld — placeholders from an earlier turn (pre-ADR-0191 content); an operator can remove them in the memory/process admin`,
  );
}

async function maskListingPerLine(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
  toolName: string,
): Promise<MemoryNoteText> {
  if (privacy === undefined) return { ok: true, text };
  const [header = '', ...lines] = text.split('\n');
  const stale = await staleEntries(privacy, lines);
  const kept = lines.filter((_, i) => stale[i] !== true);
  const withheld = lines.length - kept.length;
  logWithheld(withheld, toolName);
  // One mask call over what is left, as on the fast path.
  const masked = await maskMemoryNoteText(privacy, [header, ...kept].join('\n'), toolName);
  if (!masked.ok) return masked;
  return {
    ok: true,
    text: withheld > 0 ? `${masked.text}\n${withheldEntriesNote(withheld)}` : masked.text,
  };
}

async function maskProcessHits(
  privacy: PrivacyTurnHandle | undefined,
  text: string,
  toolName: string,
  whole: MemoryNoteText,
): Promise<MemoryNoteText> {
  let parsed: { hits?: unknown };
  try {
    parsed = JSON.parse(text) as { hits?: unknown };
  } catch {
    return whole;
  }
  if (!Array.isArray(parsed.hits) || privacy === undefined) return whole;
  const hits: unknown[] = parsed.hits;
  const stale = await staleEntries(privacy, hits.map((hit) => JSON.stringify(hit)));
  const kept = hits.filter((_, i) => stale[i] !== true);
  const withheld = hits.length - kept.length;
  logWithheld(withheld, toolName);
  const reduced = JSON.stringify({
    ...parsed,
    hits: kept,
    ...(withheld > 0 ? { withheld: withheldEntriesNote(withheld) } : {}),
  });
  // One mask call over what is left; a mask that breaks the JSON withholds
  // the result (fail closed), it is not counted as a stale entry.
  const masked = await maskMemoryNoteText(privacy, reduced, toolName);
  if (!masked.ok) return masked;
  try {
    JSON.parse(masked.text);
  } catch {
    console.error(`[privacy] ${toolName}: masked result is no longer JSON — withheld`);
    return whole;
  }
  return masked;
}
