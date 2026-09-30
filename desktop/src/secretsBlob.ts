import crypto from 'node:crypto';
import path from 'node:path';
import { secretsBackupFile, secretsUnreadableMessage } from './secretsRecovery';

/**
 * The encrypted secrets blob on disk, and the only two ways to touch it.
 *
 * Electron-free behind an IO port, like `dbSnapshot.ts` and for the same
 * reason: both rules below are about error paths and ordering, and a rule that
 * lives only in a comment is not held.
 *
 * 1. Only a missing file (ENOENT) means "no blob yet". Every other failure (the
 *    file cannot be read, the keychain refuses to decrypt it, it does not
 *    parse, it has the wrong shape) throws `SecretsUnreadableError` and leaves
 *    the file exactly as it was. The loader this replaces caught all of those
 *    and wrote fresh keys over the file, so one refused keychain prompt or one
 *    torn write made the kernel vault, every stored credential and every
 *    provider key unrecoverable.
 * 2. A rewrite never touches the live file in place. The current file is
 *    copied to `<file>.bak` first (a failing copy aborts the rewrite), the new
 *    bytes go to a temp file next to it, and a rename swaps that in. A crash at
 *    any point leaves the old file or the new one, never a torn one.
 */

/** Owner read/write only, for the blob, its backup and its temp files. */
export const SECRETS_FILE_MODE = 0o600;

/** The kernel base64-decodes both keys and requires exactly 32 bytes. */
const KEY_BYTES = 32;

/** Temp files are `<file>.tmp-<pid>-<uuid>`, the kernel vault's own scheme. */
const TEMP_MARKER = '.tmp-';

export interface SecretsBlob {
  /** base64 of 32 random bytes: the kernel's VAULT_KEY value. */
  readonly vaultKey: string;
  /**
   * base64 of 32 random bytes: the kernel's CREDENTIAL_KEYCHAIN_KEY value. A
   * SEPARATE trust domain from the vault by the kernel's own design (a
   * compromised key must not unlock both). Optional because installs created
   * before this field existed have a blob without it; `secrets.ts` adds it
   * lazily. A fresh blob is created with it.
   */
  readonly credentialKeychainKey?: string;
  /** provider key id -> value, e.g. { ANTHROPIC_API_KEY: "..." }. */
  readonly providerKeys: Readonly<Record<string, string>>;
}

export interface SecretsIo {
  /** The raw bytes. Throws the fs error; ENOENT is the only code with a meaning here. */
  readFile(file: string): Buffer;
  /** Create `file` exclusively with `mode`, then write and flush `data`. */
  writeFile(file: string, data: Buffer, mode: number): void;
  rename(from: string, to: string): void;
  /** Copy `from` over `to`, then set `mode` on the copy explicitly. */
  copyFile(from: string, to: string, mode: number): void;
  /** A missing file is not an error. */
  remove(file: string): void;
  exists(file: string): boolean;
  /** Entry names (not paths) in `dir`. */
  listDir(dir: string): string[];
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** OS-backed encryption: Electron `safeStorage` in the app. */
export interface SecretsCodec {
  encryptionAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export type SecretsUnreadableStage =
  | 'read'
  | 'decrypt'
  | 'parse'
  | 'shape'
  | 'encryption-unavailable';

const STAGES: ReadonlySet<string> = new Set<SecretsUnreadableStage>([
  'read',
  'decrypt',
  'parse',
  'shape',
  'encryption-unavailable',
]);

export interface SecretsUnreadableDetails {
  readonly file: string;
  readonly stage: SecretsUnreadableStage;
  /** One line on what went wrong. */
  readonly reason: string;
  /** Where pre-update snapshots live, for the restore hint; null if unknown. */
  readonly snapshotDir: string | null;
  readonly cause?: unknown;
}

/**
 * The secrets file exists but cannot be used, and nothing was written. What to
 * do about it is the user's call; the message says how for the stage that
 * failed (see `secretsRecovery.ts`).
 */
export class SecretsUnreadableError extends Error {
  readonly code = 'secrets_unreadable';
  readonly file: string;
  readonly stage: SecretsUnreadableStage;
  readonly reason: string;
  readonly snapshotDir: string | null;

  constructor(details: SecretsUnreadableDetails) {
    super(secretsUnreadableMessage(details), { cause: details.cause });
    this.name = 'SecretsUnreadableError';
    this.file = details.file;
    this.stage = details.stage;
    this.reason = details.reason;
    this.snapshotDir = details.snapshotDir;
  }
}

/**
 * Typed check on the code and the fields a recovery dialog needs, so callers
 * never have to classify this failure by its message text.
 */
export function isSecretsUnreadableError(value: unknown): value is SecretsUnreadableError {
  if (!(value instanceof Error)) return false;
  const candidate = value as Error & Record<string, unknown>;
  return (
    candidate['code'] === 'secrets_unreadable' &&
    typeof candidate['file'] === 'string' &&
    typeof candidate['stage'] === 'string' &&
    STAGES.has(candidate['stage']) &&
    typeof candidate['reason'] === 'string' &&
    (candidate['snapshotDir'] === null || typeof candidate['snapshotDir'] === 'string')
  );
}

/** A file appeared where a new blob was about to be created. It was not touched. */
export class SecretsConflictError extends Error {
  readonly code = 'secrets_conflict';
  readonly file: string;

  constructor(file: string) {
    super(
      `A secrets file appeared at ${file} while omadia was creating one. ` +
        'It was left untouched; start omadia again to use it.',
    );
    this.name = 'SecretsConflictError';
    this.file = file;
  }
}

export interface SecretsReadOptions {
  /** Plaintext at rest is tolerated only in an unpackaged (dev) run. */
  readonly allowPlaintext: boolean;
  /** The snapshot folder for the restore hint; resolved only when reading fails. */
  readonly snapshotDir?: () => string;
}

/**
 * The blob at `file`, or null when there is no file (ENOENT) - the only case in
 * which a caller may create one. Every other failure throws
 * `SecretsUnreadableError`. Never writes.
 */
export function readSecretsBlob(
  io: SecretsIo,
  codec: SecretsCodec,
  file: string,
  options: SecretsReadOptions,
): SecretsBlob | null {
  let bytes: Buffer;
  try {
    bytes = io.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw unreadable(io, file, 'read', describeCause(err), err, options);
  }
  const value = decode(io, codec, file, bytes, options);
  const problem = shapeProblem(value);
  if (problem !== null) throw unreadable(io, file, 'shape', problem, undefined, options);
  return freeze(value as SecretsBlob);
}

function decode(
  io: SecretsIo,
  codec: SecretsCodec,
  file: string,
  bytes: Buffer,
  options: SecretsReadOptions,
): unknown {
  if (!codec.encryptionAvailable()) {
    // A packaged build never reads ciphertext as text and calls it damaged: a
    // missing keyring has to say so, not send the user to restore a backup.
    if (!options.allowPlaintext) {
      throw unreadable(
        io,
        file,
        'encryption-unavailable',
        'OS-backed encryption is unavailable',
        undefined,
        options,
      );
    }
    return parse(io, file, bytes.toString('utf8'), options);
  }
  let plain: string;
  try {
    plain = codec.decrypt(bytes);
  } catch (err) {
    // Dev only: a blob written in plaintext while encryption was unavailable
    // (e.g. a Linux box without a keyring) stays readable once it appears. The
    // next rewrite encrypts it. A packaged build never takes this path.
    const devBlob = options.allowPlaintext ? plaintextBlob(bytes) : null;
    if (devBlob !== null) {
      io.warn(`${file} is an unencrypted dev blob; reading it as plaintext (dev only)`);
      return devBlob;
    }
    throw unreadable(io, file, 'decrypt', describeCause(err), err, options);
  }
  return parse(io, file, plain, options);
}

function parse(io: SecretsIo, file: string, text: string, options: SecretsReadOptions): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw unreadable(io, file, 'parse', describeCause(err), err, options);
  }
}

/** A well-formed plaintext blob, or null. */
function plaintextBlob(bytes: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return shapeProblem(value) === null ? value : null;
  } catch {
    return null;
  }
}

function unreadable(
  io: SecretsIo,
  file: string,
  stage: SecretsUnreadableStage,
  reason: string,
  cause: unknown,
  options: SecretsReadOptions,
): SecretsUnreadableError {
  io.error(`${stage} failed for ${file} (${reason}); the file was left untouched`);
  return new SecretsUnreadableError({
    file,
    stage,
    reason,
    snapshotDir: resolveSnapshotDir(options),
    cause,
  });
}

function resolveSnapshotDir(options: SecretsReadOptions): string | null {
  if (options.snapshotDir === undefined) return null;
  try {
    return options.snapshotDir();
  } catch {
    // Only a hint: failing to name the folder must not replace the real error.
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The kernel's own check (`resolveMasterKey`): base64-decode, exactly 32 bytes. */
function isKey(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.from(value, 'base64').length === KEY_BYTES
  );
}

/** What is wrong with a parsed blob, or null. Mirrors `updateAttempts.ts`'s guard. */
function shapeProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'not a JSON object';
  if (!isKey(value['vaultKey'])) return 'vaultKey is not a base64-encoded 32-byte key';
  const keychainKey = value['credentialKeychainKey'];
  if (keychainKey !== undefined && !isKey(keychainKey)) {
    return 'credentialKeychainKey is not a base64-encoded 32-byte key';
  }
  const providerKeys = value['providerKeys'];
  if (!isPlainObject(providerKeys)) return 'providerKeys is not an object';
  if (Object.values(providerKeys).some((entry) => typeof entry !== 'string')) {
    return 'providerKeys holds a value that is not a string';
  }
  return null;
}

/** Frozen, and fields a newer version may have added are kept for the next rewrite. */
function freeze(blob: SecretsBlob): SecretsBlob {
  return Object.freeze({ ...blob, providerKeys: Object.freeze({ ...blob.providerKeys }) });
}

export type SecretsWriteMode = 'create' | 'replace';

export interface SecretsWriteOptions {
  /** Plaintext at rest is tolerated only in an unpackaged (dev) run. */
  readonly allowPlaintext: boolean;
  /**
   * 'create': the caller saw ENOENT, so a file that appeared since is left
   * alone (`SecretsConflictError`). 'replace': the caller read this very file,
   * which is copied to `<file>.bak` before it is swapped out.
   */
  readonly mode: SecretsWriteMode;
}

const FAIL_CLOSED_MESSAGE =
  'OS-backed encryption (keychain/credential store) is unavailable, so ' +
  'omadia will not store your secrets in plaintext. On Linux, configure ' +
  'a Secret Service keyring (e.g. gnome-keyring/libsecret) and retry.';

/** Backup, temp file, rename, in that order; see the module doc. */
export function writeSecretsBlob(
  io: SecretsIo,
  codec: SecretsCodec,
  file: string,
  blob: SecretsBlob,
  options: SecretsWriteOptions,
): void {
  const bytes = encode(io, codec, blob, options.allowPlaintext);
  if (options.mode === 'create') {
    if (io.exists(file)) throw new SecretsConflictError(file);
  } else if (io.exists(file)) {
    // No backup, no rewrite: a failing copy (EBUSY under a virus scanner,
    // ENOSPC) aborts here, before the live file is touched.
    io.copyFile(file, secretsBackupFile(file), SECRETS_FILE_MODE);
  }
  const tmp = `${file}${TEMP_MARKER}${process.pid}-${crypto.randomUUID()}`;
  try {
    io.writeFile(tmp, bytes, SECRETS_FILE_MODE);
    io.rename(tmp, file);
  } catch (err) {
    // The cleanup gets its own try so a failure here cannot replace the real
    // cause the caller has to report (the snapshot code's rule too).
    try {
      io.remove(tmp);
    } catch (cleanupErr) {
      io.warn(`could not remove the temp file ${tmp}: ${describeCause(cleanupErr)}`);
    }
    throw err;
  }
  io.info(
    options.mode === 'create'
      ? `created ${file}`
      : `rewrote ${file}; the previous version is kept at ${secretsBackupFile(file)}`,
  );
}

function encode(
  io: SecretsIo,
  codec: SecretsCodec,
  blob: SecretsBlob,
  allowPlaintext: boolean,
): Buffer {
  const json = JSON.stringify(blob);
  if (codec.encryptionAvailable()) return codec.encrypt(json);
  // Fail closed in a real (packaged) install: the onboarding UI promises the
  // key is encrypted in the OS keychain, so we must not silently downgrade to
  // plaintext. In dev we allow it with a loud warning to keep iteration cheap.
  if (!allowPlaintext) throw new Error(FAIL_CLOSED_MESSAGE);
  io.warn('OS encryption unavailable — storing secrets UNENCRYPTED (dev only).');
  return Buffer.from(json, 'utf8');
}

/**
 * Remove temp files an interrupted write left next to `file`. Call it only
 * after `file` was read successfully: next to an unreadable file, a leftover
 * may be the newer copy, and it is evidence for whoever recovers it.
 */
export function sweepStaleTemps(io: SecretsIo, file: string): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${TEMP_MARKER}`;
  let names: string[];
  try {
    names = io.listDir(dir);
  } catch (err) {
    io.warn(`could not look for leftover temp files in ${dir}: ${describeCause(err)}`);
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const leftover = path.join(dir, name);
    try {
      io.remove(leftover);
      io.info(`removed ${leftover}, left behind by an interrupted write`);
    } catch (err) {
      io.warn(`could not remove ${leftover}: ${describeCause(err)}`);
    }
  }
}

function describeCause(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}
