/**
 * Formula text that reaches the spreadsheet application exactly as the
 * formula policy (`formulaPolicy.ts`) checked it.
 *
 * The policy reads a formula the way the application's grammar does, so it
 * has to see the same characters. Two steps between the check and the
 * application can change them:
 *
 * - exceljs 4.4 writes the formula through its XML encoder
 *   (`utils.xmlEncode`), which silently drops the control characters XML 1.0
 *   cannot carry (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F) and DEL
 *   (U+007F). Text the check read as two names would reach the file as one.
 *   A carriage return reaches the application as a line feed (XML end-of-line
 *   handling), an unpaired surrogate as U+FFFD, and U+FFFE and U+FFFF are not
 *   XML characters at all.
 * - The file format stores formula text as an escaped string (`ST_Formula` is
 *   an `ST_Xstring`), in which `_xHHHH_` stands for the character U+HHHH, and
 *   a reader may decode it into a character the check never saw.
 *
 * So none of those characters may appear anywhere in a formula, and neither
 * may `_x` followed by a hexadecimal digit or by `{row}`, which a computed
 * column turns into digits. Tab and line feed are allowed here because inside
 * quotes they are text; the policy refuses them outside quotes.
 *
 * Checked at the tool boundary (the Zod schemas in `types.ts`) and again by
 * the policy before anything is written. When exceljs is upgraded, re-read its
 * encoder: this list has to match what it changes.
 */

/** Characters that do not reach the application as written. Property escapes
 *  keep eslint's no-control-regex satisfied (as in `filename.ts`). */
const UNCARRIED_CHARACTER = /(?![\t\n\u0080-\u009F])\p{Cc}|\p{Cs}|[￾￿]/u;

/** The start of the file format's `_xHHHH_` escape, or of one that a
 *  computed column's row number could complete. */
const ESCAPE_START = /_x(?:[0-9a-f]|\{row\})/i;

/** A character as `U+0041` (four hex digits at least). */
function codePointLabel(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** A character for an error message: its code point, and what kind of
 *  character it is when that is not obvious from the number. */
export function describeCharacter(character: string): string {
  if (/\p{Cc}/u.test(character)) return `the control character ${codePointLabel(character)}`;
  if (/\p{Cs}/u.test(character)) return `the unpaired surrogate ${codePointLabel(character)}`;
  return codePointLabel(character);
}

/** Why formula text would not reach the application as written, or undefined
 *  when every character of it would. */
export function formulaTextReason(text: string): string | undefined {
  const uncarried = UNCARRIED_CHARACTER.exec(text)?.[0];
  if (uncarried !== undefined) {
    return `it contains ${describeCharacter(uncarried)}, which the file cannot carry as written`;
  }
  if (ESCAPE_START.test(text)) {
    return 'it contains _x followed by a hexadecimal digit or {row}, which the file format reads as an escaped character (_xHHHH_)';
  }
  return undefined;
}
