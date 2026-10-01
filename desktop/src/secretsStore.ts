import {
  readSecretsBlob,
  sweepStaleTemps,
  writeSecretsBlob,
  type SecretsBlob,
  type SecretsCodec,
  type SecretsIo,
  type SecretsReadOptions,
  type SecretsWriteMode,
} from './secretsBlob';

/**
 * The in-memory side of secret custody: one cache, three rules.
 *
 * - **A key is cached only after it was written.** A kernel handed a key that
 *   never reached disk boots against keys the next launch will not find. So
 *   every change is written first and cached second, and a failed write leaves
 *   the cache as it was.
 * - **A rewrite starts from the file, not from the cache.** An update re-reads
 *   the file it is about to replace, so a file that became unreadable since it
 *   was cached is surfaced instead of overwritten.
 * - **The cache belongs to one path.** First-run setup can move the data dir
 *   while the app runs (the wizard shows the recovery key before it applies the
 *   chosen folder). A cache for the old path is never written over an existing
 *   file at the new one: that file is read and wins. Only a missing file there
 *   receives the keys already handed out, so the recovery key the user was just
 *   shown stays the key in use.
 */

export interface SecretsStoreDeps {
  readonly io: SecretsIo;
  readonly codec: SecretsCodec;
  /** Resolved on every call: the data dir can change while the app runs. */
  readonly file: () => string;
  /** Plaintext at rest is a dev-only concession; a packaged build fails closed. */
  readonly allowPlaintext: boolean;
  /** 32 random bytes, base64: the format the kernel checks for. */
  readonly generateKey: () => string;
  /** The pre-update snapshot folder, named in the restore hint of an unreadable file. */
  readonly snapshotDir: () => string;
}

export interface SecretsStore {
  /** The blob for the current data dir; creates one only when the file is missing. */
  load(): SecretsBlob;
  /**
   * Apply an immutable change and persist it. Returning `current` unchanged
   * writes nothing.
   */
  update(change: (current: SecretsBlob) => SecretsBlob): SecretsBlob;
  /** Forget the cache (tests). */
  reset(): void;
}

interface Entry {
  readonly file: string;
  readonly blob: SecretsBlob;
}

export function createSecretsStore(deps: SecretsStoreDeps): SecretsStore {
  let cached: Entry | null = null;
  const readOptions: SecretsReadOptions = {
    allowPlaintext: deps.allowPlaintext,
    snapshotDir: deps.snapshotDir,
  };

  const freshBlob = (): SecretsBlob => ({
    vaultKey: deps.generateKey(),
    credentialKeychainKey: deps.generateKey(),
    providerKeys: {},
  });

  const write = (file: string, blob: SecretsBlob, mode: SecretsWriteMode): void => {
    writeSecretsBlob(deps.io, deps.codec, file, blob, {
      allowPlaintext: deps.allowPlaintext,
      mode,
    });
  };

  /**
   * What a missing file at `file` starts from: the keys already handed out
   * (for this path, or for the data dir the user just moved away from), else
   * new ones. This is the only place new keys come from.
   */
  const startingBlob = (): SecretsBlob => cached?.blob ?? freshBlob();

  return {
    load(): SecretsBlob {
      const file = deps.file();
      if (cached !== null && cached.file === file) return cached.blob;

      const existing = readSecretsBlob(deps.io, deps.codec, file, readOptions);
      const blob = existing ?? startingBlob();
      if (existing === null) write(file, blob, 'create');
      cached = { file, blob };
      sweepStaleTemps(deps.io, file);
      return blob;
    },

    update(change: (current: SecretsBlob) => SecretsBlob): SecretsBlob {
      const file = deps.file();
      const onDisk = readSecretsBlob(deps.io, deps.codec, file, readOptions);
      const current = onDisk ?? startingBlob();
      const next = change(current);
      if (onDisk === null || next !== onDisk) {
        write(file, next, onDisk === null ? 'create' : 'replace');
      }
      cached = { file, blob: next };
      return next;
    },

    reset(): void {
      cached = null;
    },
  };
}
