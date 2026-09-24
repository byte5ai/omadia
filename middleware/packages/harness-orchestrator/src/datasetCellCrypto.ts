import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { resolveDatasetLinkKeySecret } from './datasetLinkKey.js';

/**
 * Dataset cell encryption — real values at rest, cleartext only server-side.
 *
 * Until now an uploaded table's PII cells were MASKED irreversibly at import
 * (#430/#727): the surrogate was persisted, the real value discarded. That
 * protected the row store, but it made every downstream *use* of the data
 * wrong for the person who is entitled to it: a merged contact list rendered
 * `lukas.becker@example.net` in every row (each cell got the first pseudonym
 * candidate), and the Excel export of that list was worthless.
 *
 * The Privacy Shield's boundary is the MODEL, not the server. Tool results
 * are interned into the turn's dataset store and the model only ever sees a
 * digest; the materializer and `create_xlsx` resolve real values server-side
 * for the authenticated user. Uploaded tables now follow the same rule:
 *
 *   - At import, a cell the PII scan flagged is stored as
 *     `enc1:<base64url(iv ‖ tag ‖ ciphertext)>` — AES-256-GCM under a key
 *     derived from the dataset secret ({@link resolveDatasetCellKey}), with
 *     the owner id and column name as additional authenticated data, so a
 *     ciphertext cannot be moved to another user's dataset or another column.
 *   - On read, `query_dataset` decrypts ONLY when the result is about to be
 *     interned behind the Privacy Shield (the turn carries a privacy handle);
 *     without a guard it re-masks on read, so the model never receives a
 *     cleartext PII cell either way. The owner's REST row preview decrypts.
 *
 * Cells the scan did not flag (names — the C0 baseline does not detect
 * them — and every non-PII string) are stored as before, in clear. Rows
 * imported BEFORE this change hold irreversible surrogates and are passed
 * through unchanged; re-upload to get real values.
 *
 * No key ⇒ no encryption: the import falls back to irreversible masking and
 * the import notice says so. Rotating the underlying secret makes existing
 * ciphertexts unreadable — they decrypt to {@link UNAVAILABLE_CELL}, never to
 * garbage and never to a throw that would take a whole query down.
 */

/** Marks an encrypted cell. Versioned so a future scheme can coexist. */
export const ENCRYPTED_CELL_PREFIX = 'enc1:';

/** What a reader shows for a cell it holds no key for. */
export const UNAVAILABLE_CELL = '[verschlüsselt — Schlüssel nicht verfügbar]';

/** HKDF `info` for the cell key. Domain-separated from the link-key label so
 *  the two derived keys are independent even though they share an IKM. */
const HKDF_INFO = 'omadia/dataset-cell-encryption/v1';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface DatasetCellKey {
  readonly key: Buffer;
  /** Part of the AAD: a ciphertext is bound to the dataset owner. */
  readonly ownerOmadiaUserId: string;
}

/**
 * Derive the cell key from the same secret the link keys use — explicit
 * `DATASET_LINK_KEY_SECRET` or HKDF of `VAULT_KEY` — under a separate label.
 * `undefined` when the install has neither.
 */
export function resolveDatasetCellKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Buffer | undefined {
  const ikm = resolveDatasetLinkKeySecret(env);
  if (ikm === undefined) return undefined;
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32));
}

export function isEncryptedCell(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_CELL_PREFIX);
}

function aad(ownerOmadiaUserId: string, column: string): Buffer {
  return Buffer.from(`${ownerOmadiaUserId}\n${column}`, 'utf8');
}

export function encryptCell(
  cellKey: DatasetCellKey,
  column: string,
  plaintext: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cellKey.key, iv);
  cipher.setAAD(aad(cellKey.ownerOmadiaUserId, column));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_CELL_PREFIX}${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
}

/**
 * Decrypt one cell. Returns `undefined` when the token is malformed, was
 * produced under another key/owner/column, or was tampered with — the caller
 * decides what to show; nothing here guesses.
 */
export function decryptCell(
  cellKey: DatasetCellKey,
  column: string,
  token: string,
): string | undefined {
  if (!token.startsWith(ENCRYPTED_CELL_PREFIX)) return undefined;
  let raw: Buffer;
  try {
    raw = Buffer.from(token.slice(ENCRYPTED_CELL_PREFIX.length), 'base64url');
  } catch {
    return undefined;
  }
  if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', cellKey.key, iv);
    decipher.setAAD(aad(cellKey.ownerOmadiaUserId, column));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Decrypt every encrypted cell of every row. A cell that cannot be decrypted
 * becomes {@link UNAVAILABLE_CELL}; everything else is passed through
 * untouched (including pre-encryption surrogates, which carry no prefix).
 * Returns new row objects — the input is never mutated.
 */
export function decryptRows(
  cellKey: DatasetCellKey | undefined,
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    let out: Record<string, unknown> | undefined;
    for (const [column, value] of Object.entries(row)) {
      if (!isEncryptedCell(value)) continue;
      out ??= { ...row };
      out[column] =
        cellKey === undefined ? UNAVAILABLE_CELL : (decryptCell(cellKey, column, value) ?? UNAVAILABLE_CELL);
    }
    return out ?? row;
  });
}
