/**
 * #1549 — which personal-identity values from this turn's tool data the
 * requester named in their own message (`PrivacyReceipt.identityValuesOnWire`).
 *
 * The receipt turns red on a hit and tells the user "you named a person". The
 * values come from the fields the schema classifier calls personal data, and
 * that verdict is per FIELD: an Odoo `department_id` many2one counts as "an id
 * paired with a name", so "Research & Development" was in the bag, and a plain
 * `message.includes(value)` then matched it, a column name inside `__k_Name`,
 * or "Lena" inside "Magdalena". Two rules make the count mean what it says:
 *
 *  1. Only values shaped like a personal identifier count: an e-mail address,
 *     a phone number, or a full name (two to five capitalised words, letters
 *     with `-`, `'` or `.` only, lowercase particles like "van der" allowed
 *     in between). A single word ("Sales", "Anna") is too ambiguous to call a
 *     named person; "Research & Development" fails on `&`. A phone number is
 *     any 7–15 digits with the usual separators, so a personnel number in a
 *     PII-classified field counts too. A two-word org unit ("Vertrieb Nord")
 *     passes this filter; it is kept out by the schema classifier, which no
 *     longer calls org units personal data.
 *  2. The value must occur as a whole word sequence, case-insensitively: no
 *     letter, digit or `_` directly before or after it.
 *
 * Pure; the values stay server-side, only the count leaves.
 */

const EMAIL_RE = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}$/u;
/** Digits with the usual separators; 7 to 15 digits (E.164 maximum). */
const PHONE_RE = /^\+?[\d\s()./-]+$/;
const NAME_TOKEN_RE = /^\p{Lu}[\p{L}'’.-]*$/u;
/** Lowercase name particles allowed between capitalised tokens
 *  ("Lena van der Berg", "Jan de Vries"). */
const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'van', 'von', 'de', 'der', 'den', 'del', 'zu', 'da', 'di', 'du', 'le', 'la', 'ter', 'ten',
]);
const MIN_NAME_TOKENS = 2;
const MAX_NAME_TOKENS = 5;
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;

/** Is `value` shaped like a personal identifier (rule 1 above)? */
export function isPersonIdentifierValue(value: string): boolean {
  const v = value.trim();
  if (EMAIL_RE.test(v)) return true;
  if (PHONE_RE.test(v)) {
    const digits = v.replace(/\D/g, '').length;
    return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS;
  }
  const tokens = v.split(/\s+/);
  if (tokens.length < MIN_NAME_TOKENS || tokens.length > MAX_NAME_TOKENS) return false;
  const capitalised = (t: string): boolean => NAME_TOKEN_RE.test(t) && /\p{L}{2,}/u.test(t);
  // First and last token capitalised; particles only in between.
  if (!capitalised(tokens[0]!) || !capitalised(tokens[tokens.length - 1]!)) return false;
  return tokens.every((t) => capitalised(t) || NAME_PARTICLES.has(t));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `message` contain `value` as a whole word sequence (rule 2 above)? */
export function namesValue(message: string, value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // Whitespace inside the value matches any whitespace run in the message.
  const body = v.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu').test(message);
}

/** How many distinct `values` the requester named in `message`. */
export function countIdentityValuesNamed(message: string, values: Iterable<string>): number {
  // Case variants of one value are one named person.
  const named = new Set<string>();
  const haystack = message.toLowerCase();
  for (const value of values) {
    // Cheap prefilter before the regex: a dataset can hold many values.
    const first = value.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first === '' || !haystack.includes(first)) continue;
    if (isPersonIdentifierValue(value) && namesValue(message, value)) {
      named.add(value.trim().toLowerCase());
    }
  }
  return named.size;
}
