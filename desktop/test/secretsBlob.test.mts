/**
 * The secrets blob's two rules, asserted on the IO port (see `secretsBlob.ts`).
 *
 * 1. Only a missing file (ENOENT) may lead to a new blob. The old loader caught
 *    every read, decrypt and parse failure and wrote fresh keys over the file,
 *    which made the kernel vault, every stored credential and every provider
 *    key unrecoverable. So each failure below must throw AND record no write.
 * 2. A rewrite never touches the live file in place: backup, temp file, rename,
 *    in that order, and a failure part-way leaves the live file as it was.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';

import {
  readSecretsBlob,
  writeSecretsBlob,
  sweepStaleTemps,
  SecretsConflictError,
  SecretsUnreadableError,
  isSecretsUnreadableError,
  type SecretsBlob,
  type SecretsCodec,
  type SecretsIo,
  type SecretsUnreadableStage,
} from '../src/secretsBlob.ts';

const DIR = '/data';
const FILE = `${DIR}/secrets.enc`;
const BAK = `${FILE}.bak`;
const SNAPSHOTS = '/data/snapshots';

/** Obviously synthetic 32-byte keys, base64 like the real ones. */
const VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
const KEYCHAIN_KEY = Buffer.alloc(32, 9).toString('base64');

const BLOB: SecretsBlob = {
  vaultKey: VAULT_KEY,
  credentialKeychainKey: KEYCHAIN_KEY,
  providerKeys: { ANTHROPIC_API_KEY: 'synthetic-provider-key' },
};

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

interface Recorder {
  readonly io: SecretsIo;
  /** Filesystem calls only; log lines go to `logs`. */
  readonly calls: string[];
  readonly logs: string[];
  readonly files: Map<string, Buffer>;
}

function recorder(
  options: {
    files?: Record<string, Buffer | string>;
    readThrows?: Error;
    writeThrows?: Error;
    renameThrows?: Error;
    copyThrows?: Error;
    removeThrows?: Error;
    listThrows?: Error;
  } = {},
): Recorder {
  const files = new Map<string, Buffer>(
    Object.entries(options.files ?? {}).map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  const calls: string[] = [];
  const logs: string[] = [];
  const io: SecretsIo = {
    readFile: (file) => {
      calls.push(`readFile(${file})`);
      if (options.readThrows) throw options.readThrows;
      const bytes = files.get(file);
      if (bytes === undefined) throw errno('ENOENT', `no such file, open '${file}'`);
      return bytes;
    },
    writeFile: (file, data, mode) => {
      calls.push(`writeFile(${file}, ${mode.toString(8)})`);
      if (options.writeThrows) throw options.writeThrows;
      files.set(file, Buffer.from(data));
    },
    rename: (from, to) => {
      calls.push(`rename(${from} -> ${to})`);
      if (options.renameThrows) throw options.renameThrows;
      const bytes = files.get(from);
      if (bytes === undefined) throw errno('ENOENT');
      files.set(to, bytes);
      files.delete(from);
    },
    copyFile: (from, to, mode) => {
      calls.push(`copyFile(${from} -> ${to}, ${mode.toString(8)})`);
      if (options.copyThrows) throw options.copyThrows;
      const bytes = files.get(from);
      if (bytes === undefined) throw errno('ENOENT');
      files.set(to, Buffer.from(bytes));
    },
    remove: (file) => {
      calls.push(`remove(${file})`);
      if (options.removeThrows) throw options.removeThrows;
      files.delete(file);
    },
    exists: (file) => {
      calls.push(`exists(${file})`);
      return files.has(file);
    },
    listDir: (dir) => {
      calls.push(`listDir(${dir})`);
      if (options.listThrows) throw options.listThrows;
      return [...files.keys()]
        .filter((name) => path.dirname(name) === dir)
        .map((name) => path.basename(name));
    },
    info: (message) => logs.push(`info: ${message}`),
    warn: (message) => logs.push(`warn: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  };
  return { io, calls, logs, files };
}

/** A reversible stand-in for safeStorage: `enc:` + base64 of the plaintext. */
function codec(options: { available?: boolean; decryptThrows?: Error } = {}): SecretsCodec {
  return {
    encryptionAvailable: () => options.available ?? true,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
    decrypt: (cipher) => {
      if (options.decryptThrows) throw options.decryptThrows;
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('Ciphertext does not appear to be encrypted.');
      }
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
  };
}

function encrypted(value: unknown): Buffer {
  return codec().encrypt(JSON.stringify(value));
}

const PACKAGED = { allowPlaintext: false, snapshotDir: () => SNAPSHOTS } as const;
const DEV = { allowPlaintext: true, snapshotDir: () => SNAPSHOTS } as const;

const FS_WRITES = /^(writeFile|rename|copyFile|remove)\(/;

function assertNoWrites(calls: readonly string[]): void {
  assert.deepEqual(
    calls.filter((call) => FS_WRITES.test(call)),
    [],
    `an unreadable file must never be followed by a write; got ${calls.join(' ')}`,
  );
}

function assertUnreadable(
  fn: () => unknown,
  stage: SecretsUnreadableStage,
): SecretsUnreadableError {
  let caught: unknown;
  assert.throws(() => {
    try {
      fn();
    } catch (err) {
      caught = err;
      throw err;
    }
  });
  assert.ok(caught instanceof SecretsUnreadableError, `expected SecretsUnreadableError, got ${String(caught)}`);
  assert.equal(caught.code, 'secrets_unreadable');
  assert.equal(caught.stage, stage);
  assert.equal(caught.file, FILE);
  assert.ok(isSecretsUnreadableError(caught));
  return caught;
}

describe('readSecretsBlob — only ENOENT means "no blob yet"', () => {
  it('returns null for a missing file and touches nothing else', () => {
    const { io, calls } = recorder();
    assert.equal(readSecretsBlob(io, codec(), FILE, PACKAGED), null);
    assert.deepEqual(calls, [`readFile(${FILE})`]);
  });

  for (const code of ['EACCES', 'EIO', 'EPERM', 'EISDIR']) {
    it(`a ${code} read error throws (stage read) and records only the read`, () => {
      const { io, calls } = recorder({ files: { [FILE]: encrypted(BLOB) }, readThrows: errno(code) });
      const err = assertUnreadable(() => readSecretsBlob(io, codec(), FILE, PACKAGED), 'read');
      assert.match(err.reason, new RegExp(code));
      assert.deepEqual(calls, [`readFile(${FILE})`]);
    });
  }

  it('a refused keychain throws (stage decrypt), records no write, and says the file is intact', () => {
    const { io, calls } = recorder({ files: { [FILE]: encrypted(BLOB) } });
    const err = assertUnreadable(
      () => readSecretsBlob(io, codec({ decryptThrows: new Error('keychain denied') }), FILE, PACKAGED),
      'decrypt',
    );
    assertNoWrites(calls);
    assert.match(err.reason, /keychain denied/);
    // The backup is encrypted with the same keychain item, so "restore the
    // backup" must not be the first thing a user reads here, and deleting the
    // file must be explicitly ruled out.
    assert.match(err.message, /do not delete/i);
    assert.ok(
      err.message.indexOf('keychain access') < err.message.indexOf(BAK),
      'the keychain advice has to come before the restore hint',
    );
  });

  it('damaged JSON inside valid ciphertext throws (stage parse) and records no write', () => {
    const { io, calls } = recorder({ files: { [FILE]: codec().encrypt('{"vaultKey": "trunc') } });
    const err = assertUnreadable(() => readSecretsBlob(io, codec(), FILE, PACKAGED), 'parse');
    assertNoWrites(calls);
    // A damaged file is the case the backup and the snapshot copy are for.
    assert.ok(err.message.includes(BAK), 'names the backup');
    assert.ok(err.message.includes(SNAPSHOTS), 'names the resolved snapshot folder');
  });

  it('damaged plaintext in a dev run throws (stage parse), not a keyring error', () => {
    const { io, calls } = recorder({ files: { [FILE]: '{not json' } });
    assertUnreadable(() => readSecretsBlob(io, codec({ available: false }), FILE, DEV), 'parse');
    assertNoWrites(calls);
  });

  const wrongShapes: ReadonlyArray<readonly [string, unknown]> = [
    ['a number vaultKey', { vaultKey: 42, providerKeys: {} }],
    ['a vaultKey that is not 32 bytes', { vaultKey: Buffer.alloc(16).toString('base64'), providerKeys: {} }],
    ['an empty vaultKey', { vaultKey: '', providerKeys: {} }],
    ['a malformed credentialKeychainKey', { vaultKey: VAULT_KEY, credentialKeychainKey: 'short', providerKeys: {} }],
    ['missing providerKeys', { vaultKey: VAULT_KEY }],
    ['a non-string provider key', { vaultKey: VAULT_KEY, providerKeys: { X: 1 } }],
    ['an array', [VAULT_KEY]],
    ['null', null],
  ];
  for (const [label, value] of wrongShapes) {
    it(`${label} throws (stage shape) and records no write`, () => {
      const { io, calls } = recorder({ files: { [FILE]: encrypted(value) } });
      assertUnreadable(() => readSecretsBlob(io, codec(), FILE, PACKAGED), 'shape');
      assertNoWrites(calls);
    });
  }

  it('a packaged build without OS encryption never parses ciphertext as text', () => {
    const { io, calls } = recorder({ files: { [FILE]: encrypted(BLOB) } });
    const err = assertUnreadable(
      () => readSecretsBlob(io, codec({ available: false }), FILE, PACKAGED),
      'encryption-unavailable',
    );
    assertNoWrites(calls);
    assert.match(err.message, /Secret Service keyring/);
    assert.match(err.message, /do not delete/i);
  });

  it('accepts a valid blob and keeps fields a newer version may have added', () => {
    const stored = { ...BLOB, addedLater: 'kept' };
    const { io, calls } = recorder({ files: { [FILE]: encrypted(stored) } });
    const blob = readSecretsBlob(io, codec(), FILE, PACKAGED);
    assert.deepEqual(blob, stored);
    assertNoWrites(calls);
  });

  it('accepts a legacy blob without credentialKeychainKey', () => {
    const legacy = { vaultKey: VAULT_KEY, providerKeys: {} };
    const { io } = recorder({ files: { [FILE]: encrypted(legacy) } });
    assert.deepEqual(readSecretsBlob(io, codec(), FILE, PACKAGED), legacy);
  });

  it('a dev run reads its own plaintext blob after OS encryption became available', () => {
    const { io, calls, logs } = recorder({ files: { [FILE]: JSON.stringify(BLOB) } });
    const blob = readSecretsBlob(io, codec(), FILE, DEV);
    assert.deepEqual(blob, BLOB);
    assertNoWrites(calls);
    assert.ok(logs.some((line) => line.startsWith('warn:')), 'the plaintext read is logged loudly');
  });

  it('a packaged build does not fall back to reading plaintext', () => {
    const { io } = recorder({ files: { [FILE]: JSON.stringify(BLOB) } });
    assertUnreadable(() => readSecretsBlob(io, codec(), FILE, PACKAGED), 'decrypt');
  });

  it('names the stage in the error log line', () => {
    const { io, logs } = recorder({ files: { [FILE]: encrypted({ vaultKey: 1 }) } });
    assert.throws(() => readSecretsBlob(io, codec(), FILE, PACKAGED));
    assert.ok(
      logs.some((line) => line.startsWith('error:') && line.includes('shape') && line.includes(FILE)),
      `got ${logs.join(' | ')}`,
    );
  });

  it('degrades the snapshot hint when the snapshot folder cannot be resolved', () => {
    const { io } = recorder({ files: { [FILE]: encrypted({ vaultKey: 1 }) } });
    const err = assertUnreadable(
      () =>
        readSecretsBlob(io, codec(), FILE, {
          allowPlaintext: false,
          snapshotDir: () => {
            throw new Error('EACCES');
          },
        }),
      'shape',
    );
    assert.equal(err.snapshotDir, null);
    assert.ok(err.message.includes(BAK));
  });
});

describe('readSecretsBlob — a parse failure never quotes the decrypted text', () => {
  // V8's SyntaxError quotes about ten characters on each side of the error,
  // and here that text is the decrypted blob. The reason, the message and the
  // cause reach the log, the setup wizard and the recovery dialog.
  const SECRET = Buffer.alloc(32, 0xca).toString('base64');
  const cutOff = `{"vaultKey":"${SECRET}`;
  const damaged = [
    ['a damaged quote right before the vault key', `{"vaultKey":é${SECRET}","providerKeys":{}}`, 'not valid JSON'],
    ['a damaged quote right before a provider key', `{"vaultKey":"${VAULT_KEY}","providerKeys":{"X":é${SECRET}"}}`, 'not valid JSON'],
    // V8 reports this one by position, after its own wording: the number is kept.
    ['a file cut off inside a key', cutOff, `not valid JSON at position ${cutOff.length}`],
  ] as const;
  const sources = [
    ['encrypted', PACKAGED, codec(), (text: string) => codec().encrypt(text)],
    ['dev plaintext', DEV, codec({ available: false }), (text: string) => Buffer.from(text, 'utf8')],
  ] as const;

  /** A run of four characters of SECRET inside `text`, or null. Shorter runs are everyday letters. */
  function leakedRun(text: string): string | null {
    for (let i = 0; i + 4 <= SECRET.length; i += 1) {
      if (text.includes(SECRET.slice(i, i + 4))) return SECRET.slice(i, i + 4);
    }
    return null;
  }

  for (const [label, text, reason] of damaged) {
    for (const [source, options, readCodec, stored] of sources) {
      it(`${label} (${source}): nothing of it in the message, reason, cause chain or log`, () => {
        const { io, logs } = recorder({ files: { [FILE]: stored(text) } });
        const err = assertUnreadable(() => readSecretsBlob(io, readCodec, FILE, options), 'parse');
        const surfaces = [err.message, err.reason, ...logs];
        for (let link: unknown = err.cause; link != null; link = (link as { cause?: unknown }).cause) {
          surfaces.push(String(link));
        }
        for (const surface of surfaces) assert.equal(leakedRun(surface), null, surface);
        assert.equal(err.reason, reason);
      });
    }
  }
});

describe('writeSecretsBlob — backup, temp file, rename', () => {
  it('backs up the live file, writes a temp file, then renames it into place', () => {
    const before = encrypted({ vaultKey: VAULT_KEY, providerKeys: {} });
    const { io, calls, files } = recorder({ files: { [FILE]: before } });
    writeSecretsBlob(io, codec(), FILE, BLOB, { allowPlaintext: false, mode: 'replace' });

    const copy = calls.findIndex((c) => c === `copyFile(${FILE} -> ${BAK}, 600)`);
    const write = calls.findIndex((c) => c.startsWith('writeFile('));
    const rename = calls.findIndex((c) => c.startsWith('rename('));
    assert.ok(copy !== -1 && write !== -1 && rename !== -1, calls.join(' '));
    assert.ok(copy < write && write < rename, `backup → temp → rename; got ${calls.join(' ')}`);

    const tmp = /^writeFile\((.+), 600\)$/.exec(calls[write] as string)?.[1] ?? '';
    assert.ok(tmp.startsWith(`${FILE}.tmp-`), `temp file next to the live one: ${tmp}`);
    assert.notEqual(tmp, FILE, 'the live file is never written in place');
    assert.equal(calls[rename], `rename(${tmp} -> ${FILE})`);

    assert.deepEqual(files.get(BAK), before, 'the backup holds the previous bytes');
    assert.deepEqual(readSecretsBlob(io, codec(), FILE, PACKAGED), BLOB);
  });

  it('a first write with no existing file makes no backup', () => {
    const { io, calls } = recorder();
    writeSecretsBlob(io, codec(), FILE, BLOB, { allowPlaintext: false, mode: 'create' });
    assert.equal(calls.filter((c) => c.startsWith('copyFile(')).length, 0);
    assert.equal(calls.filter((c) => c.startsWith('writeFile(')).length, 1);
    assert.equal(calls.filter((c) => c.startsWith('rename(')).length, 1);
  });

  it('create refuses to replace a file that appeared in the meantime', () => {
    const existing = encrypted(BLOB);
    const { io, calls, files } = recorder({ files: { [FILE]: existing } });
    assert.throws(
      () => writeSecretsBlob(io, codec(), FILE, { ...BLOB, vaultKey: KEYCHAIN_KEY }, { allowPlaintext: false, mode: 'create' }),
      (err: unknown) => err instanceof SecretsConflictError && err.code === 'secrets_conflict',
    );
    assertNoWrites(calls);
    assert.deepEqual(files.get(FILE), existing);
  });

  it('a failing backup copy aborts the rewrite: no backup, no rewrite', () => {
    const before = encrypted(BLOB);
    const { io, calls, files } = recorder({
      files: { [FILE]: before },
      copyThrows: errno('EBUSY', 'resource busy or locked'),
    });
    assert.throws(
      () => writeSecretsBlob(io, codec(), FILE, BLOB, { allowPlaintext: false, mode: 'replace' }),
      /EBUSY/,
    );
    assert.equal(calls.filter((c) => c.startsWith('writeFile(') || c.startsWith('rename(')).length, 0);
    assert.deepEqual(files.get(FILE), before);
  });

  it('ENOSPC on the temp file rethrows, never renames, and removes the temp file', () => {
    const before = encrypted(BLOB);
    const { io, calls, files } = recorder({
      files: { [FILE]: before },
      writeThrows: errno('ENOSPC', 'no space left on device'),
    });
    assert.throws(
      () => writeSecretsBlob(io, codec(), FILE, BLOB, { allowPlaintext: false, mode: 'replace' }),
      /ENOSPC/,
    );
    assert.equal(calls.filter((c) => c.startsWith('rename(')).length, 0);
    assert.ok(calls.some((c) => c.startsWith(`remove(${FILE}.tmp-`)), calls.join(' '));
    assert.deepEqual(files.get(FILE), before, 'the live file is untouched');
  });

  it('a failing rename rethrows the real cause even when the cleanup fails too', () => {
    const before = encrypted(BLOB);
    const { io, calls, files, logs } = recorder({
      files: { [FILE]: before },
      renameThrows: errno('EPERM', 'operation not permitted'),
      removeThrows: errno('EACCES'),
    });
    assert.throws(
      () => writeSecretsBlob(io, codec(), FILE, BLOB, { allowPlaintext: false, mode: 'replace' }),
      /EPERM/,
    );
    assert.ok(calls.some((c) => c.startsWith(`remove(${FILE}.tmp-`)));
    assert.ok(logs.some((line) => line.startsWith('warn:') && line.includes('EACCES')));
    assert.deepEqual(files.get(FILE), before);
  });

  it('a packaged build without OS encryption fails closed before any IO', () => {
    const { io, calls } = recorder({ files: { [FILE]: encrypted(BLOB) } });
    assert.throws(
      () => writeSecretsBlob(io, codec({ available: false }), FILE, BLOB, { allowPlaintext: false, mode: 'replace' }),
      /will not store your secrets in plaintext/,
    );
    assert.deepEqual(calls, []);
  });

  it('a dev run without OS encryption writes plaintext and says so', () => {
    const { io, files, logs } = recorder();
    writeSecretsBlob(io, codec({ available: false }), FILE, BLOB, { allowPlaintext: true, mode: 'create' });
    assert.deepEqual(JSON.parse((files.get(FILE) as Buffer).toString('utf8')), BLOB);
    assert.ok(logs.some((line) => line.startsWith('warn:') && /UNENCRYPTED/.test(line)));
  });

  it('logs where the previous version was kept', () => {
    const { io, logs } = recorder({ files: { [FILE]: encrypted(BLOB) } });
    writeSecretsBlob(io, codec(), FILE, BLOB, { allowPlaintext: false, mode: 'replace' });
    assert.ok(logs.some((line) => line.startsWith('info:') && line.includes(BAK)), logs.join(' | '));
  });
});

describe('sweepStaleTemps', () => {
  it('removes temp files a crash left next to the secrets file, and nothing else', () => {
    const leftover = `${FILE}.tmp-4242-00000000-0000-4000-8000-000000000000`;
    const { io, files } = recorder({
      files: {
        [FILE]: 'live',
        [BAK]: 'backup',
        [leftover]: 'half-finished',
        [`${DIR}/setup.json`]: '{}',
        [`${DIR}/secrets.enc.tmp`]: 'not ours: no separator',
      },
    });
    sweepStaleTemps(io, FILE);
    assert.deepEqual(
      [...files.keys()].sort(),
      [FILE, BAK, `${DIR}/secrets.enc.tmp`, `${DIR}/setup.json`].sort(),
    );
  });

  it('logs instead of throwing when the folder cannot be listed', () => {
    const { io, logs } = recorder({ listThrows: errno('EACCES') });
    assert.doesNotThrow(() => sweepStaleTemps(io, FILE));
    assert.ok(logs.some((line) => line.startsWith('warn:')));
  });
});
