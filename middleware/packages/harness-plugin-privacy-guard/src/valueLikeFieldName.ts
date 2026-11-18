/**
 * #1556 follow-up — field names that are values.
 *
 * A tool result's KEYS are not always schema: an MCP tool can return a map
 * keyed by e-mail address (`{ "anna@example.com": "Sales" }`), a spreadsheet
 * can carry a person as a column header ("Anna Müller"). Such a key is a
 * value. The field-classification recorder never observes it and the kernel
 * never sends it to the schema model — fail-safe: not observed ⇒ the field
 * stays masked.
 *
 * A name counts as a value when the C0 identity baseline hits it (e-mail,
 * IBAN, phone, address, ID number) or it looks like a person's name: two or
 * more words, each an upper-case letter followed by lower-case letters
 * ("Anna Müller", "Jean-Luc Picard"). Ordinary schema names — `department_id`,
 * "Abteilung", `partner_id.name` — pass.
 */

import { baselineHasIdentityPii } from './promptMask.js';

/** Two or more capitalized words joined by a space or hyphen. */
export const PERSON_NAME_LIKE = /^\p{Lu}\p{Ll}+(?:[ -]\p{Lu}\p{Ll}+)+$/u;

/** Is the field path or label (or any `.` segment of it) a value? */
export function isValueLikeFieldName(name: string): boolean {
  const text = name.trim();
  if (text.length === 0) return false;
  if (baselineHasIdentityPii(text)) return true;
  return [text, ...text.split('.')].some((segment) => PERSON_NAME_LIKE.test(segment.trim()));
}
