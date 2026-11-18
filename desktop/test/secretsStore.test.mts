/**
 * The secrets store's cache and write policy (see `secretsStore.ts`).
 *
 * The rules pinned here are the ones a cache can quietly break:
 *  - a key is cached only after it was persisted, so a failed write can never
 *    hand the kernel a key that the next launch will not find;
 *  - a file that exists but cannot be read is surfaced and never replaced;
 *  - the cache belongs to one path: when first-run setup points the data dir
 *    somewhere else, the file THERE decides, and a blob cached for the old
 *    path is never written over an existing file at the new one.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';

import {
  SecretsUnreadableError,
  type SecretsBlob,
  type SecretsCodec,
  type SecretsIo,
} from '../src/secretsBlob.ts';
import { createSecretsStore, type SecretsStore } from '../src/secretsStore.ts';

const P1 = '/userData/secrets.enc';
const P2 = '/chosen/secrets.enc';
const SNAPSHOTS = '/userData/snapshots';

/** Obviously synthetic keys: 32 bytes of one repeated value, base64. */
function syntheticKey(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: synthetic`), { code });
}

interface Faults {
  write?: Error;
}

interface Harness {
  readonly store: SecretsStore;
  readonly calls: string[];
  readonly files: Map<string, Buffer>;
  readonly faults: Faults;
  /** Point the store at another data dir, as the wizard's override does. */
  moveTo(file: string): void;
}

const CODEC: SecretsCodec = {
  encryptionAvailable: () => true,
  encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
  decrypt: (cipher) => {
    const text = cipher.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('Ciphertext does not appear to be encrypted.');
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  },
};

function encrypted(blob: unknown): Buffer {
  return CODEC.encrypt(JSON.stringify(blob));
}

function decoded(bytes: Buffer | undefined): SecretsBlob {
  assert.ok(bytes, 'expected a file');
  return JSON.parse(CODEC.decrypt(bytes)) as SecretsBlob;
}

function harness(initial: Record<string, Buffer | string> = {}, start = P1): Harness {
  const files = new Map<string, Buffer>(
    Object.entries(initial).map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  const calls: string[] = [];
  const faults: Faults = {};
  let current = start;
  let nextFill = 100;
  const io: SecretsIo = {
    readFile: (file) => {
      calls.push(`readFile(${file})`);
      const bytes = files.get(file);
      if (bytes === undefined) throw errno('ENOENT');
      return bytes;
    },
    writeFile: (file, data) => {
      calls.push(`writeFile(${file})`);
      if (faults.write) throw faults.write;
      files.set(file, Buffer.from(data));
    },
    rename: (from, to) => {
      calls.push(`rename(${from} -> ${to})`);
      const bytes = files.get(from);
      if (bytes === undefined) throw errno('ENOENT');
      files.set(to, bytes);
      files.delete(from);
    },
    copyFile: (from, to) => {
      calls.push(`copyFile(${from} -> ${to})`);
      const bytes = files.get(from);
      if (bytes === undefined) throw errno('ENOENT');
      files.set(to, Buffer.from(bytes));
    },
    remove: (file) => {
      calls.push(`remove(${file})`);
      files.delete(file);
    },
    exists: (file) => files.has(file),
    listDir: (dir) =>
      [...files.keys()].filter((name) => path.dirname(name) === dir).map((name) => path.basename(name)),
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const store = createSecretsStore({
    io,
    codec: CODEC,
    file: () => current,
    allowPlaintext: false,
    generateKey: () => syntheticKey(nextFill++),
    snapshotDir: () => SNAPSHOTS,
  });
  return {
    store,
    calls,
    files,
    faults,
    moveTo: (file) => {
      current = file;
    },
  };
}

const callsTo = (calls: readonly string[], verb: string): string[] =>
  calls.filter((call) => call.startsWith(`${verb}(`));

const LEGACY: SecretsBlob = { vaultKey: syntheticKey(1), providerKeys: {} };
const FULL: SecretsBlob = {
  vaultKey: syntheticKey(2),
  credentialKeychainKey: syntheticKey(3),
  providerKeys: { OPENAI_API_KEY: 'synthetic-provider-key' },
};

describe('createSecretsStore — creating', () => {
  it('creates a missing file exactly once: one temp write, one rename, no backup', () => {
    const { store, calls, files } = harness();
    const blob = store.load();
    assert.equal(callsTo(calls, 'writeFile').length, 1);
    assert.equal(callsTo(calls, 'rename').length, 1);
    assert.equal(callsTo(calls, 'copyFile').length, 0);
    // Both kernel keys in one write: the second write a legacy blob needs is
    // not part of a fresh install.
    assert.ok(blob.credentialKeychainKey, 'a fresh blob carries the credential keychain key');
    assert.deepEqual(decoded(files.get(P1)), blob);

    store.load();
    assert.equal(callsTo(calls, 'readFile').length, 1, 'the second call is served from the cache');
  });

  it('does not cache a key whose write failed, so none is ever handed out unpersisted', () => {
    const { store, faults, files } = harness();
    faults.write = errno('ENOSPC');
    assert.throws(() => store.load(), /ENOSPC/);
    assert.equal(files.has(P1), false);

    faults.write = undefined;
    const blob = store.load();
    assert.deepEqual(decoded(files.get(P1)), blob, 'what the caller gets is what is on disk');
  });
});

describe('createSecretsStore — an unreadable file is surfaced, never replaced', () => {
  it('throws, writes nothing, and caches nothing', () => {
    const damaged = Buffer.from('enc:not-base64-json');
    const { store, calls, files } = harness({ [P1]: damaged });
    assert.throws(() => store.load(), SecretsUnreadableError);
    assert.throws(() => store.load(), SecretsUnreadableError);
    assert.equal(callsTo(calls, 'readFile').length, 2, 'a failure is not cached either');
    assert.deepEqual(
      calls.filter((call) => !call.startsWith('readFile(')),
      [],
      'no write, rename, copy or removal may follow',
    );
    assert.deepEqual(files.get(P1), damaged);
  });

  it('carries the resolved snapshot folder for the restore hint', () => {
    const { store } = harness({ [P1]: encrypted({ vaultKey: 'x', providerKeys: {} }) });
    assert.throws(
      () => store.load(),
      (err: unknown) => err instanceof SecretsUnreadableError && err.snapshotDir === SNAPSHOTS,
    );
  });

  it('an update re-reads the file and refuses to replace one that became unreadable', () => {
    const { store, calls, files } = harness({ [P1]: encrypted(FULL) });
    store.load();
    const damaged = Buffer.from('enc:');
    files.set(P1, damaged);

    assert.throws(
      () => store.update((current) => ({ ...current, providerKeys: { X: 'synthetic' } })),
      SecretsUnreadableError,
    );
    assert.equal(callsTo(calls, 'writeFile').length, 0);
    assert.equal(callsTo(calls, 'copyFile').length, 0);
    assert.deepEqual(files.get(P1), damaged);
  });

  it('keeps leftover temp files next to an unreadable file, as they may be the newer copy', () => {
    const leftover = `${P1}.tmp-7-00000000-0000-4000-8000-000000000000`;
    const { store, files } = harness({ [P1]: Buffer.from('enc:'), [leftover]: encrypted(FULL) });
    assert.throws(() => store.load());
    assert.ok(files.has(leftover));
  });
});

describe('createSecretsStore — updating', () => {
  it('writes before it caches: a failed migration leaves no unpersisted key behind', () => {
    const { store, faults, files } = harness({ [P1]: encrypted(LEGACY) });
    const addKey = (current: SecretsBlob): SecretsBlob =>
      current.credentialKeychainKey ? current : { ...current, credentialKeychainKey: syntheticKey(50) };

    faults.write = errno('ENOSPC');
    assert.throws(() => store.update(addKey), /ENOSPC/);
    assert.equal(store.load().credentialKeychainKey, undefined, 'the failed key must not be cached');

    faults.write = undefined;
    const migrated = store.update(addKey);
    assert.equal(migrated.credentialKeychainKey, syntheticKey(50));
    assert.equal(decoded(files.get(P1)).credentialKeychainKey, syntheticKey(50));
    assert.equal(store.load().credentialKeychainKey, syntheticKey(50));
  });

  it('rewrites with a backup of the previous bytes and keeps the vault key', () => {
    const before = encrypted(FULL);
    const { store, files } = harness({ [P1]: before });
    store.update((current) => ({
      ...current,
      providerKeys: { ...current.providerKeys, ANTHROPIC_API_KEY: 'synthetic-second-key' },
    }));
    assert.deepEqual(files.get(`${P1}.bak`), before);
    const after = decoded(files.get(P1));
    assert.equal(after.vaultKey, FULL.vaultKey);
    assert.equal(after.providerKeys['ANTHROPIC_API_KEY'], 'synthetic-second-key');
    assert.equal(after.providerKeys['OPENAI_API_KEY'], 'synthetic-provider-key');
  });

  it('an update that changes nothing writes nothing', () => {
    const { store, calls } = harness({ [P1]: encrypted(FULL) });
    store.update((current) => current);
    assert.equal(callsTo(calls, 'writeFile').length, 0);
    assert.equal(callsTo(calls, 'copyFile').length, 0);
  });

  it('sweeps temp files a crash left behind once the file has been read', () => {
    const leftover = `${P1}.tmp-7-00000000-0000-4000-8000-000000000000`;
    const { store, files } = harness({ [P1]: encrypted(FULL), [leftover]: 'half-written' });
    store.load();
    assert.equal(files.has(leftover), false);
  });
});

/**
 * Reading back what was just written, before anything outside the file is
 * made to depend on it (the embedded database is provisioned with passwords
 * from this blob): the cache says what was meant to be persisted, only the
 * file says what was.
 */
describe('createSecretsStore — reading back', () => {
  it('returns what is on disk now, bypassing the cache, and writes nothing', () => {
    const { store, calls, files } = harness({ [P1]: encrypted(FULL) });
    assert.deepEqual(store.load(), FULL);
    files.set(P1, encrypted(LEGACY));
    calls.length = 0;

    assert.deepEqual(store.reread(), LEGACY);
    assert.deepEqual(store.load(), FULL, 'the cache is left as it was');
    for (const verb of ['writeFile', 'rename', 'copyFile', 'remove']) {
      assert.deepEqual(callsTo(calls, verb), [], `no ${verb}`);
    }
  });

  it('returns null for a missing file instead of creating one', () => {
    const { store, calls } = harness();
    assert.equal(store.reread(), null);
    assert.deepEqual(callsTo(calls, 'writeFile'), []);
  });

  it('surfaces an unreadable file like every other read', () => {
    const { store } = harness({ [P1]: 'not-ciphertext' });
    assert.throws(() => store.reread(), SecretsUnreadableError);
  });
});

describe('createSecretsStore — the cache follows the data dir', () => {
  it('adopts an existing file at the new path instead of writing the cached blob over it', () => {
    const chosen = encrypted(FULL);
    const { store, files, moveTo } = harness({ [P2]: chosen });
    const first = store.load(); // a blob cached for the old data dir
    const userDataBytes = files.get(P1);

    moveTo(P2); // the wizard's data-dir override
    assert.deepEqual(store.load(), FULL, 'the file in the chosen folder decides');

    store.update((current) => ({
      ...current,
      providerKeys: { ...current.providerKeys, ANTHROPIC_API_KEY: 'synthetic-wizard-key' },
    }));
    const after = decoded(files.get(P2));
    assert.equal(after.vaultKey, FULL.vaultKey, 'the chosen folder keeps its own vault key');
    assert.notEqual(after.vaultKey, first.vaultKey);
    assert.equal(after.credentialKeychainKey, FULL.credentialKeychainKey);
    assert.deepEqual(files.get(`${P2}.bak`), chosen);
    assert.deepEqual(files.get(P1), userDataBytes, 'the old folder is not touched');
  });

  it('gives a missing file at the new path the keys it already handed out', () => {
    const { store, files, moveTo, calls } = harness();
    const revealed = store.load();

    moveTo(P2);
    assert.deepEqual(store.load(), revealed, 'the key a user was shown stays the key in use');
    assert.deepEqual(decoded(files.get(P2)), revealed);
    assert.equal(callsTo(calls, 'copyFile').length, 0, 'nothing existed there to back up');
  });

  it('an unreadable file in the old folder does not stop a fresh start in an empty one', () => {
    const damaged = Buffer.from('enc:');
    const { store, files, moveTo } = harness({ [P1]: damaged });
    assert.throws(() => store.load(), SecretsUnreadableError);

    moveTo(P2);
    const fresh = store.load();
    assert.deepEqual(decoded(files.get(P2)), fresh);
    assert.deepEqual(files.get(P1), damaged, 'the unreadable file stays exactly as it was');
  });
});

/**
 * `preview` is what the wizard's recovery key is read through before setup
 * binds the chosen folder: it must answer with what `load()` will return after
 * the move, and must not write, cache or move anything to get there.
 */
describe('createSecretsStore — previewing a data dir before moving there', () => {
  it('reads an existing file there without writing, caching or moving', () => {
    const chosen = encrypted(FULL);
    const { store, files, calls, moveTo } = harness({ [P2]: chosen });
    const first = store.load();
    calls.length = 0;

    assert.deepEqual(store.preview(P2), FULL, 'the file in that folder decides');
    for (const verb of ['writeFile', 'rename', 'copyFile', 'remove']) {
      assert.deepEqual(callsTo(calls, verb), [], `no ${verb}`);
    }
    assert.deepEqual(files.get(P2), chosen, 'byte-identical');
    assert.deepEqual(store.load(), first, 'the current data dir and its cache are unchanged');

    moveTo(P2);
    assert.deepEqual(store.load(), FULL, 'and the move loads what was previewed');
  });

  it('answers a missing file there with the persisted keys the move will write', () => {
    const { store, files, moveTo } = harness();
    const previewed = store.preview(P2);
    assert.equal(files.has(P2), false, 'nothing is written there before the move');
    assert.deepEqual(decoded(files.get(P1)), previewed, 'the keys shown are on disk already');

    moveTo(P2);
    assert.deepEqual(store.load(), previewed);
    assert.deepEqual(decoded(files.get(P2)), previewed);
  });

  it('surfaces an unreadable file there and writes nothing anywhere', () => {
    const damaged = Buffer.from('enc:');
    const { store, files, calls } = harness({ [P2]: damaged });
    assert.throws(() => store.preview(P2), SecretsUnreadableError);
    assert.deepEqual(files.get(P2), damaged);
    assert.equal(files.has(P1), false, 'no keys were made up for the current data dir');
    assert.deepEqual(callsTo(calls, 'writeFile'), []);
  });
});
