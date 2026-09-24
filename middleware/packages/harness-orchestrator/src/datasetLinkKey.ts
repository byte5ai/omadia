import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Dataset link keys — stable, identity-free join/dedup keys for uploads.
 *
 * Why they exist: a CSV/XLSX import masks PII *irreversibly* and the
 * surrogate a value receives depends on the whole value set of that one
 * text (`createPromptPseudonymMap` sorts the values it sees). So "Anna
 * Schmidt" in file A and the same person in file B end up as two unrelated
 * surrogates — two uploads have no common identity left, and a cross-file
 * de-duplication or join is not merely unbuilt but *unsound*. Worse, the C0
 * baseline that runs at import does not detect person names at all; a bare
 * `Name` column survives in clear here and is then masked downstream by the
 * v4 shape classifier (multi-word string ⇒ `sensitive-masked`), where the
 * verb engine refuses it as a key.
 *
 * The fix is a second column per text column: `__k_<column>` holding
 *
 *     HMAC-SHA256(secret, ownerOmadiaUserId ‖ "\n" ‖ normalize(value))
 *
 * truncated to {@link LINK_KEY_LENGTH} hex chars. Properties that matter:
 *
 *  - **Stable per user:** the same normalized value yields the same key in
 *    every file the same user uploads, so `v4_join`/`v4_distinct` work across
 *    files. Keyed per *user*, not per tenant, on purpose: datasets are only
 *    ever queryable by their owner, so a tenant-wide key would add linkability
 *    across people without adding any capability.
 *  - **Identity-free:** without the secret a key cannot be inverted or even
 *    tested against a guess, so the LLM may see it in clear. The v4 shape
 *    classifier's S5 rule (whitespace-free alphanumeric token with ≥1 digit)
 *    then classifies the column `safe-cleartext` — which is exactly what lets
 *    the verb engine accept it as a key with NO relaxation of its
 *    masked-fields-are-never-keys rule. {@link ensureTokenShaped} guarantees
 *    the digit so a column can never fall out of S5 by bad luck.
 *  - **Tolerant:** {@link normalizeLinkValue} folds case, whitespace and
 *    Unicode compatibility forms, so "Max  Mustermann " and "max mustermann"
 *    link. Mirrors `normalizeKeyPart` in the privacy-guard verb engine.
 *
 * The secret is process-wide (`DATASET_LINK_KEY_SECRET`), falling back to a
 * key HKDF-derived from the vault master key (`VAULT_KEY`) so a standard
 * production install has link keys without a new required variable. When
 * neither exists, no key columns are written and the import notice says so —
 * a fact the model can state, not a capability it silently lacks.
 */

/** Column-name prefix of a link-key column: `__k_<source column>`. */
export const LINK_KEY_COLUMN_PREFIX = '__k_';

/** Hex chars kept from the HMAC — 64 bits, collision-free for any dataset
 *  the row cap allows, short enough not to bloat the interned rows. */
export const LINK_KEY_LENGTH = 16;

/** Explicit secret (any string ≥ {@link MIN_SECRET_CHARS} chars). */
export const LINK_KEY_SECRET_ENV = 'DATASET_LINK_KEY_SECRET';

/** Fallback IKM: the vault master key (base64, 32 bytes), see `fileVault`. */
export const VAULT_KEY_ENV = 'VAULT_KEY';

export const MIN_SECRET_CHARS = 16;

/** HKDF `info` — domain-separates the derived key from every other use of
 *  the vault master key. Bump the suffix to rotate link keys deliberately. */
const HKDF_INFO = 'omadia/dataset-link-key/v1';

/** Maps a raw cell value to its link key, or `null` for an empty cell. */
export type DatasetLinkKeyer = (value: string) => string | null;

export function linkKeyColumnName(column: string): string {
  return `${LINK_KEY_COLUMN_PREFIX}${column}`;
}

export function isLinkKeyColumn(name: string): boolean {
  return name.startsWith(LINK_KEY_COLUMN_PREFIX);
}

/**
 * Canonical form a value is keyed under: NFKC, trimmed, inner whitespace
 * collapsed, lower-cased. Returns `''` for a blank cell.
 */
export function normalizeLinkValue(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The v4 shape classifier only clears a string column as an `id` when EVERY
 * value is an alphanumeric token carrying at least one digit. A 16-hex-char
 * key is all letters with probability (6/16)^16 ≈ 2e-7 — rare, but one such
 * value would silently mask the whole column. Make the digit deterministic:
 * borrow it from the next hash byte and put it in the last position.
 */
export function ensureTokenShaped(hexDigest: string): string {
  if (hexDigest.length < LINK_KEY_LENGTH + 2) {
    throw new Error(
      `dataset link key: digest too short (${String(hexDigest.length)} < ${String(LINK_KEY_LENGTH + 2)})`,
    );
  }
  const key = hexDigest.slice(0, LINK_KEY_LENGTH);
  if (/\d/.test(key)) return key;
  const spare = parseInt(hexDigest.slice(LINK_KEY_LENGTH, LINK_KEY_LENGTH + 2), 16);
  return `${key.slice(0, -1)}${String(spare % 10)}`;
}

/**
 * Build the keyer for one import. The owner id is part of the MAC input, so
 * one process-wide secret still yields per-user key spaces.
 */
export function createDatasetLinkKeyer(opts: {
  readonly secret: Buffer;
  readonly ownerOmadiaUserId: string;
}): DatasetLinkKeyer {
  if (opts.secret.length === 0) {
    throw new Error('dataset link key: secret must not be empty');
  }
  if (opts.ownerOmadiaUserId.length === 0) {
    throw new Error('dataset link key: ownerOmadiaUserId must not be empty');
  }
  return (value: string): string | null => {
    const norm = normalizeLinkValue(value);
    if (norm.length === 0) return null;
    const digest = createHmac('sha256', opts.secret)
      .update(`${opts.ownerOmadiaUserId}\n${norm}`)
      .digest('hex');
    return ensureTokenShaped(digest);
  };
}

/**
 * Resolve the link-key secret from the environment:
 *
 *  1. `DATASET_LINK_KEY_SECRET` — used as-is (UTF-8) when long enough.
 *  2. `VAULT_KEY` — HKDF-SHA256(ikm = base64-decoded key, info = v1 label).
 *  3. otherwise `undefined` → the import writes no link-key columns.
 *
 * A configured-but-too-short explicit secret is *rejected*, not silently
 * accepted: a 6-char secret would make every key guessable offline.
 */
export function resolveDatasetLinkKeySecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Buffer | undefined {
  const explicit = env[LINK_KEY_SECRET_ENV];
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit.length < MIN_SECRET_CHARS) {
      throw new Error(
        `${LINK_KEY_SECRET_ENV} must be at least ${String(MIN_SECRET_CHARS)} characters`,
      );
    }
    return Buffer.from(explicit, 'utf8');
  }
  const vault = env[VAULT_KEY_ENV];
  if (vault === undefined || vault.length === 0) return undefined;
  const ikm = Buffer.from(vault, 'base64');
  if (ikm.length === 0) return undefined;
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32));
}
