/** RFC 5321's limit on a forward path; longer is not an address anyone receives mail at. */
export const MAX_LOGIN_EMAIL_LENGTH = 254;

// Whitespace, C0/C1 controls and the invisible format characters (zero-width,
// bidi overrides, BOM) that would let an address look like a different one.
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/**
 * #1321 — the ONE server-side rule for an address that becomes a sign-in
 * account: the admin create route, the setup wizard and the
 * `ADMIN_BOOTSTRAP_EMAIL` seed all call it, so the three cannot disagree.
 *
 * Deliberately structural, not RFC 5322: exactly one `@`, a non-empty local
 * part, a non-empty domain, no whitespace, control or invisible format
 * characters, at most 254
 * characters. That refuses `a@`, `@b`, `a@@b` and `a b@c`, and keeps every
 * address a real mail system accepts — including a dotless intranet domain
 * (`admin@localhost`), which the browser's `type="email"` accepts too.
 * Callers pass the trimmed value.
 */
export function isValidLoginEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_LOGIN_EMAIL_LENGTH) return false;
  if (WHITESPACE_OR_CONTROL.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  return at < email.length - 1;
}
