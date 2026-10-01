/**
 * How a password sign-in names its account, for the sign-in limiter
 * (docs/security-architecture.md §10f). Two identities, kept apart on purpose:
 *
 *   bucket key   `loginAccountKey`: what the limiter counts attempts against.
 *                It folds an address at least as coarsely as the users table
 *                matches it, so no spelling the table treats as one account
 *                gets a budget of its own. Coarser is safe: accounts that
 *                fold together only share their limiter state.
 *   device key   `loginDeviceAccountKey`: what a device cookie is bound to.
 *                It is minted from the address of the account the sign-in
 *                VERIFIED, as stored, and only ASCII letters are lower-cased,
 *                so the users-table lookup of the key lands on the same row
 *                as the lookup of the address itself. (Collations that
 *                lower-case a capital I their own way, Turkish, Azerbaijani
 *                and Lithuanian, are the exception; the row is then still one
 *                of the same bucket key.) Never the bucket key: that one
 *                deliberately lumps spellings of different accounts together,
 *                and one account's cookie would then count for the other.
 *
 * The users table matches `LOWER(email) = LOWER($input)`, and Postgres
 * lower-cases differently from JavaScript: it turns 'İ' (U+0130) into a plain
 * 'i' and every 'Σ' into 'σ', where toLowerCase() gives 'i' plus U+0307 and,
 * at the end of a word, 'ς'. Collations and Unicode versions differ further.
 * So the bucket key goes beyond any LOWER(): compatibility decomposition
 * (NFKD), combining marks dropped, lower case, then the dotless 'ı' (the
 * Turkish lower case of 'I') and the final 'ς' folded to 'i' and 'σ'.
 * `LocalPasswordProvider` refuses a sign-in whose address and account fold
 * apart, so whatever a database matches beyond this fold cannot sign in under
 * a budget of its own either.
 */

/** RFC 5321 bounds a mailbox at 254 characters; longer ids share one key. */
const MAX_ACCOUNT_ID_LENGTH = 254;
/** Inputs longer than this are not folded at all (the body limit is 10 MB). */
const MAX_ACCOUNT_ID_INPUT = 4 * MAX_ACCOUNT_ID_LENGTH;
/** The key of a missing, empty or oversized account id. */
const NO_ACCOUNT = '-';
const COMBINING_MARK = /\p{M}/gu;
const DOTLESS_I = /\u0131/g;
const FINAL_SIGMA = /\u03c2/g;
const ASCII_UPPER = /[A-Z]/g;

/**
 * The account a sign-in attempt targets, as the limiter counts it: namespaced
 * by provider and folded (see the header). `' Admin@X.de '`, `'ADMİN@x.de'`
 * and `'admin@x.de'` are one key. A missing, empty or oversized id is `'-'`.
 */
export function loginAccountKey(providerId: string, accountId: string | undefined): string {
  return `${providerId}:${foldLoginAccountId(accountId) ?? NO_ACCOUNT}`;
}

/** Whether two addresses are one account to the limiter: the same `loginAccountKey`. */
export function isSameLoginAccount(providerId: string, a: string, b: string): boolean {
  return loginAccountKey(providerId, a) === loginAccountKey(providerId, b);
}

/** The folded account id `loginAccountKey` keys by; undefined for a missing, empty or oversized one. */
export function foldLoginAccountId(accountId: string | undefined): string | undefined {
  if (accountId === undefined || accountId.length > MAX_ACCOUNT_ID_INPUT) return undefined;
  const folded = accountId
    .trim()
    .normalize('NFKD')
    .replace(COMBINING_MARK, '')
    .toLowerCase()
    .replace(DOTLESS_I, 'i')
    .replace(FINAL_SIGMA, '\u03c3');
  return folded.length > 0 && folded.length <= MAX_ACCOUNT_ID_LENGTH ? folded : undefined;
}

/**
 * The address a device cookie is bound to, and the one its account is looked
 * up by: trimmed, ASCII letters lower-cased, everything else as given, so the
 * lookup lands where the lookup of the address itself does. Undefined for a
 * missing, empty or oversized one.
 */
export function loginDeviceAccountName(accountId: string | undefined): string | undefined {
  if (accountId === undefined || accountId.length > MAX_ACCOUNT_ID_INPUT) return undefined;
  const name = accountId.trim().replace(ASCII_UPPER, (c) => c.toLowerCase());
  return name.length > 0 && name.length <= MAX_ACCOUNT_ID_LENGTH ? name : undefined;
}

/** `loginDeviceAccountName`, namespaced by provider; undefined when there is no name. */
export function loginDeviceAccountKey(
  providerId: string,
  accountId: string | undefined,
): string | undefined {
  const name = loginDeviceAccountName(accountId);
  return name === undefined ? undefined : `${providerId}:${name}`;
}

/**
 * The account id in a password-provider login body. Providers define their
 * own body shape (`PasswordProvider.verify(body: unknown)`); every provider
 * this repo has identifies the account by `email`, and `username` covers the
 * obvious other shape. Anything else shares the provider-wide `'-'` key.
 */
export function readLoginAccountId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { email?: unknown; username?: unknown };
  if (typeof b.email === 'string') return b.email;
  if (typeof b.username === 'string') return b.username;
  return undefined;
}
