/**
 * #1540 — provenance of a note the agent writes with the `memory` tool.
 *
 * `memory` is exempt from interning, so a note goes to the model as stored.
 * A note written in a turn without a Privacy Shield, or after a tool bypassed
 * it, can hold names and addresses no shield masked (a transcript copied into
 * notes, a raw tool result). Such a note carries {@link UNPROTECTED_NOTE_MARKER}
 * on a line of its own. Under a shield the model-facing memory namespacers
 * refuse to read it; without one they strip the line before the model sees
 * the note. Readers of the raw store that derive knowledge from notes (the
 * durable-rules promotion, the scratch-promotion reaper) strip it too and
 * stamp what they derive `unprotected`.
 *
 * The marker is matched as a whole line anywhere in the note, so provenance
 * frontmatter put in front of it (an operator promotion) does not hide it. A
 * literal marker written in a protected turn only makes the note stricter.
 */

export const UNPROTECTED_NOTE_MARKER = '<!-- omadia:unprotected -->';

const MARKER_LINE = /^[ \t]*<!-- omadia:unprotected -->[ \t]*\r?$/m;
const MARKER_LINES = /^[ \t]*<!-- omadia:unprotected -->[ \t]*(\r?\n|$)/gm;

/** Does the note carry the unprotected marker? */
export function isUnprotectedNote(content: string): boolean {
  return MARKER_LINE.test(content);
}

/** The note without its marker lines. Identity for an unmarked note. */
export function stripUnprotectedNoteMarker(content: string): string {
  return isUnprotectedNote(content) ? content.replace(MARKER_LINES, '') : content;
}

/** The note with exactly one marker, as its first line. */
export function markUnprotectedNote(content: string): string {
  return `${UNPROTECTED_NOTE_MARKER}\n${stripUnprotectedNoteMarker(content)}`;
}
