/**
 * The one length rule for local passwords. Sign-in reads the maximum from
 * here, and every place that sets a password applies the whole rule: the
 * first-run wizard, the admin create and reset routes (a reset of your own
 * row included) and the environment bootstrap of the first admin.
 *
 * Lengths are UTF-16 code units (`string.length`), the unit sign-in has
 * always counted in. A setter with no maximum, or one that counted
 * differently, could store a password that sign-in then refuses whatever is
 * typed, and a reset also ends every session of the account.
 *
 * Setters check BEFORE they hash or write, so a refused password changes
 * neither the stored hash nor the session version. A password stored above
 * the maximum before this rule existed keeps being refused at sign-in; an
 * admin reset is the way back in (docs/security-architecture.md §10m).
 */

/** Shortest password a setter accepts. Sign-in does not apply it. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Longest password anyone may set or sign in with. argon2's pre-hash is
 * linear in the input and the JSON body limit is 10 MB, so an unbounded
 * password would be an unbounded cost per sign-in attempt.
 */
export const MAX_PASSWORD_LENGTH = 1024;

export type PasswordPolicyViolation = 'too_short' | 'too_long';

/** Why a new password is refused, or `null` when a setter may store it. */
export function checkNewPassword(password: string): PasswordPolicyViolation | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too_long';
  return null;
}
