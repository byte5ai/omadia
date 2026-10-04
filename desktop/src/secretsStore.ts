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
 *   while the app runs. A cache for the old path is never written over an
 *   existing file at the new one: that file is read and wins. Only a missing
 *   file there receives the keys already handed out. `preview` answers by the
 *   same rule before the move, so the recovery key the wizard shows for the
 *   chosen folder is the key in use once setup binds it.
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
  /**
   * The blob `load()` will return once the data dir's file is `file`, without
   * moving there: an existing file is read and wins, and a missing one will
   * receive the keys of the current data dir (created there if needed, like
   * `load()`). Never writes at `file` and never caches it. An unreadable file
   * throws like every other read.
   */
  preview(file: string): SecretsBlob;
  /**
   * The blob as the file holds it right now, bypassing the cache, or null when
   * there is no file. Never writes and never touches the cache: this is how a
   * caller checks that what it just persisted really reads back.
   */
  reread(): SecretsBlob | null;
  /** Forget the cache (tests, and a caller that no longer trusts it). */
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

  const store: SecretsStore = {
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

    preview(file: string): SecretsBlob {
      if (cached !== null && cached.file === file) return cached.blob;
      // A missing file there will start from `startingBlob()`, so the keys
      // shown for it must already be persisted ones: `load()` makes them so.
      return readSecretsBlob(deps.io, deps.codec, file, readOptions) ?? store.load();
    },

    reread(): SecretsBlob | null {
      return readSecretsBlob(deps.io, deps.codec, deps.file(), readOptions);
    },

    reset(): void {
      cached = null;
    },
  };
  return store;
}
