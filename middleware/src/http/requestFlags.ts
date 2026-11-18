/**
 * Boolean flags that arrive as request text.
 *
 * A query parameter or a multipart field is a string, and clients spell the
 * same intent several ways: `?flag=1`, `?flag=true`, a form field `yes`. The
 * routes that take such a flag (#1455: `allow_downgrade` on the Hub-install
 * and package-upload routes) read it through here so the accepted spellings
 * cannot drift apart between them.
 *
 * Deliberately strict in the other direction: anything else — `0`, `false`,
 * `maybe`, the empty string, a repeated parameter that express turns into an
 * array — is false. A flag whose job is to confirm a destructive action must
 * never be switched on by a value nobody meant as consent, and an empty field
 * is the shape a form sends when the operator left it alone.
 *
 * `bareFlag` is the one exception, and only for a query string: `?flag` with
 * no `=` reaches express as an empty string, and on a URL typed by hand that
 * IS the operator writing the flag. A multipart body has no such spelling, so
 * the upload route does not pass the option.
 */
export function isTruthyFlag(
  value: unknown,
  opts: { bareFlag?: boolean } = {},
): boolean {
  if (typeof value !== 'string') return false;
  const normalised = value.trim().toLowerCase();
  if (normalised === '') return opts.bareFlag === true;
  return normalised === '1' || normalised === 'true' || normalised === 'yes';
}
