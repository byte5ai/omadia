/**
 * `secrets.ts` wired to the real filesystem, through the Electron fake (#932).
 *
 * The regression this pins: every read, decrypt or parse failure used to be
 * caught and answered with fresh keys written over `secrets.enc`. The kernel
 * then got a different VAULT_KEY, could no longer open its own vault, and every
 * stored credential and provider key was gone. Now only a missing file leads to
 * new keys; anything else throws and leaves the file byte-identical.
 *
 * The fake's `userData` is a fresh temp dir per test file (node --test runs each
 * file in its own process), and the module cache is reset before every case.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import { __setSafeStorage } from './helpers/electron-fake.mjs';
import { secretsFile, setDataDirOverride } from '../src/paths.ts';
import {
  __resetSecretsCacheForTests,
  allProviderKeys,
  credentialKeychainKey,
  embeddedDbCredentials,
  exportRecoveryKey,
  getProviderKey,
  recoveryKeyFor,
  setProviderKey,
  vaultKey,
} from '../src/secrets.ts';

interface StoredBlob {
  vaultKey: string;
  credentialKeychainKey?: string;
  providerKeys: Record<string, string>;
  embeddedDb?: { superuserPassword: string; kernelPassword: string };
}

const userData = app.getPath('userData');
const overrideFile = path.join(userData, 'datadir.txt');

/** Obviously synthetic keys: 32 bytes of one repeated value, base64. */
function syntheticKey(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

const FULL: StoredBlob = {
  vaultKey: syntheticKey(11),
  credentialKeychainKey: syntheticKey(12),
  providerKeys: { OPENAI_API_KEY: 'synthetic-provider-key' },
};

/** The fake has no OS encryption and is unpackaged, so the dev format is JSON. */
function writeBlob(file: string, blob: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(blob), 'utf8');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return bytes;
}

function writeRaw(file: string, text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return bytes;
}

function readBlob(file: string): StoredBlob {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredBlob;
}

/** `secrets.enc` and everything named after it (`.bak`, `.tmp-*`). */
function family(file: string): string[] {
  const base = path.basename(file);
  return fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(base))
    .sort();
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-secrets-test-'));
}

function assertUnreadable(fn: () => unknown, stage: string, label: string): void {
  assert.throws(
    fn,
    (err: unknown) => {
      const e = err as { code?: unknown; stage?: unknown };
      return e.code === 'secrets_unreadable' && e.stage === stage;
    },
    `${label} must refuse an unreadable secrets file (stage ${stage})`,
  );
}

const ACCESSORS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['vaultKey()', () => vaultKey()],
  ['credentialKeychainKey()', () => credentialKeychainKey()],
  ['exportRecoveryKey()', () => exportRecoveryKey()],
  ['recoveryKeyFor(null)', () => recoveryKeyFor(null)],
  ['allProviderKeys()', () => allProviderKeys()],
  ['setProviderKey()', () => setProviderKey('ANTHROPIC_API_KEY', 'synthetic-provider-key')],
  ['embeddedDbCredentials()', () => embeddedDbCredentials()],
];

beforeEach(() => {
  __resetSecretsCacheForTests();
  __setSafeStorage(null);
  fs.rmSync(overrideFile, { force: true });
  for (const name of family(path.join(userData, 'secrets.enc'))) {
    fs.rmSync(path.join(userData, name), { force: true });
  }
});

describe('secrets.ts — only a missing file leads to new keys', () => {
  it('creates an absent file in one write, with both kernel keys', () => {
    const file = secretsFile();
    assert.equal(fs.existsSync(file), false);

    const key = vaultKey();
    const stored = readBlob(file);
    assert.equal(stored.vaultKey, key);
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.ok(stored.credentialKeychainKey, 'written together with the vault key');
    assert.equal(credentialKeychainKey(), stored.credentialKeychainKey);
    assert.deepEqual(family(file), ['secrets.enc'], 'no backup and no temp file on a first write');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });

  it('returns a valid blob as stored and leaves the file untouched', () => {
    const file = secretsFile();
    const bytes = writeBlob(file, FULL);
    assert.equal(vaultKey(), FULL.vaultKey);
    assert.equal(credentialKeychainKey(), FULL.credentialKeychainKey);
    assert.equal(exportRecoveryKey(), FULL.vaultKey);
    assert.equal(recoveryKeyFor(null), FULL.vaultKey, 'null names the current data folder');
    assert.deepEqual(allProviderKeys(), FULL.providerKeys);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(family(file), ['secrets.enc']);
  });

  it('a damaged file makes every accessor throw and stays byte-identical', () => {
    const file = secretsFile();
    const bytes = writeRaw(file, '{"vaultKey": "trunc');
    for (const [label, call] of ACCESSORS) {
      assertUnreadable(call, 'parse', label);
    }
    assert.deepEqual(fs.readFileSync(file), bytes, 'the file must not be replaced');
    assert.deepEqual(family(file), ['secrets.enc'], 'no backup, no temp file: nothing was written');
  });

  it('a keychain that refuses to decrypt makes every accessor throw and leaves the file alone', () => {
    __setSafeStorage({
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error('keychain denied');
      },
    });
    const file = secretsFile();
    const bytes = writeRaw(file, 'v10-synthetic-ciphertext');
    for (const [label, call] of ACCESSORS) {
      assertUnreadable(call, 'decrypt', label);
    }
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(family(file), ['secrets.enc']);
  });

  it('still reads a dev plaintext blob after OS encryption became available', () => {
    __setSafeStorage({
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error('Ciphertext does not appear to be encrypted.');
      },
    });
    const file = secretsFile();
    const bytes = writeBlob(file, FULL);
    assert.equal(vaultKey(), FULL.vaultKey);
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
});

describe('secrets.ts — rewrites are atomic and keep a backup', () => {
  it('migrates a legacy blob exactly once, returning the key it persisted', () => {
    const file = secretsFile();
    const legacy = { vaultKey: syntheticKey(21), providerKeys: { OPENAI_API_KEY: 'synthetic-provider-key' } };
    const before = writeBlob(file, legacy);

    const key = credentialKeychainKey();
    const stored = readBlob(file);
    assert.equal(key, stored.credentialKeychainKey, 'the caller gets the key that is on disk');
    assert.equal(stored.vaultKey, legacy.vaultKey);
    assert.deepEqual(stored.providerKeys, legacy.providerKeys);
    assert.deepEqual(fs.readFileSync(`${file}.bak`), before, 'the backup holds the previous bytes');
    assert.deepEqual(family(file), ['secrets.enc', 'secrets.enc.bak'], 'no temp file left behind');

    const afterFirst = fs.readFileSync(file);
    assert.equal(credentialKeychainKey(), key);
    assert.deepEqual(fs.readFileSync(file), afterFirst, 'the second call does not write again');
  });

  it('setProviderKey rewrites with a backup and keeps the vault key', () => {
    const file = secretsFile();
    const before = writeBlob(file, FULL);

    setProviderKey('ANTHROPIC_API_KEY', 'synthetic-second-key');
    const stored = readBlob(file);
    assert.equal(stored.vaultKey, FULL.vaultKey);
    assert.equal(stored.credentialKeychainKey, FULL.credentialKeychainKey);
    assert.equal(getProviderKey('ANTHROPIC_API_KEY'), 'synthetic-second-key');
    assert.deepEqual(allProviderKeys(), { ...FULL.providerKeys, ANTHROPIC_API_KEY: 'synthetic-second-key' });
    assert.deepEqual(fs.readFileSync(`${file}.bak`), before);
    assert.deepEqual(family(file), ['secrets.enc', 'secrets.enc.bak']);
  });

  it('removes temp files a crash left behind once the file has been read', () => {
    const file = secretsFile();
    writeBlob(file, FULL);
    writeRaw(`${file}.tmp-4242-00000000-0000-4000-8000-000000000000`, 'half-written');
    vaultKey();
    assert.deepEqual(family(file), ['secrets.enc']);
  });
});

describe('secrets.ts — a data-dir change during setup', () => {
  it('reveals the key of a chosen folder that holds a valid blob, the key setup then keeps', () => {
    // The wizard's Reveal button runs BEFORE `complete` applies the chosen data
    // dir. It asks for the key of that folder, so the blob already there is
    // what it shows, and binding the folder keeps that blob's keys.
    const cached = exportRecoveryKey(); // a key already handed out for userData
    const userDataFile = secretsFile();
    const userDataBytes = fs.readFileSync(userDataFile);

    const chosen = freshDir();
    const chosenFile = path.join(chosen, 'secrets.enc');
    const chosenBytes = writeBlob(chosenFile, FULL);

    const revealed = recoveryKeyFor(chosen);
    assert.equal(revealed, FULL.vaultKey, 'the key of the blob in the chosen folder');
    assert.notEqual(revealed, cached);
    assert.deepEqual(fs.readFileSync(chosenFile), chosenBytes, 'revealing reads, it does not write');
    assert.deepEqual(family(chosenFile), ['secrets.enc']);

    setDataDirOverride(chosen);
    setProviderKey('ANTHROPIC_API_KEY', 'synthetic-wizard-key');
    const stored = readBlob(chosenFile);
    assert.equal(stored.vaultKey, revealed, 'the key shown is the key in use');
    assert.equal(stored.credentialKeychainKey, FULL.credentialKeychainKey);
    assert.equal(stored.providerKeys['ANTHROPIC_API_KEY'], 'synthetic-wizard-key');
    assert.deepEqual(fs.readFileSync(`${chosenFile}.bak`), chosenBytes);
    assert.deepEqual(fs.readFileSync(userDataFile), userDataBytes, 'the userData blob is untouched');
    assert.equal(exportRecoveryKey(), revealed, 'the recovery key still names the key in use');
  });

  it('leaves that blob byte-identical through setup when no provider key is stored', () => {
    const chosen = freshDir();
    const chosenFile = path.join(chosen, 'secrets.enc');
    const chosenBytes = writeBlob(chosenFile, FULL);

    const revealed = recoveryKeyFor(chosen);
    assert.equal(revealed, FULL.vaultKey);
    assert.equal(fs.existsSync(secretsFile()), false, 'no keys were made up for the current folder');

    setDataDirOverride(chosen);
    assert.equal(vaultKey(), revealed, 'the kernel boots with the key that was shown');
    assert.equal(credentialKeychainKey(), FULL.credentialKeychainKey);
    assert.equal(exportRecoveryKey(), revealed);
    assert.deepEqual(fs.readFileSync(chosenFile), chosenBytes);
    assert.deepEqual(family(chosenFile), ['secrets.enc']);
  });

  it('reveals the new key an empty chosen folder receives, without writing there first', () => {
    const empty = freshDir();
    const emptyFile = path.join(empty, 'secrets.enc');

    const revealed = recoveryKeyFor(empty);
    assert.equal(Buffer.from(revealed, 'base64').length, 32);
    assert.notEqual(revealed, FULL.vaultKey);
    assert.deepEqual(fs.readdirSync(empty), [], 'the folder is not bound yet');

    setDataDirOverride(empty);
    setProviderKey('ANTHROPIC_API_KEY', 'synthetic-wizard-key');
    assert.equal(readBlob(emptyFile).vaultKey, revealed, 'the key shown is the key in use');
    assert.equal(vaultKey(), revealed);
    assert.equal(exportRecoveryKey(), revealed);
  });

  for (const [stage, text, keychain] of [
    ['parse', '{"vaultKey": "trunc', null],
    [
      'decrypt',
      'v10-synthetic-ciphertext',
      {
        isEncryptionAvailable: () => true,
        decryptString: () => {
          throw new Error('keychain denied');
        },
      },
    ],
  ] as const) {
    it(`reports a chosen folder's blob that fails at ${stage} instead of a key, and keeps it`, () => {
      __setSafeStorage(keychain);
      const chosen = freshDir();
      const chosenFile = path.join(chosen, 'secrets.enc');
      const bytes = writeRaw(chosenFile, text);

      assertUnreadable(() => recoveryKeyFor(chosen), stage, 'recoveryKeyFor(chosen)');
      assert.deepEqual(fs.readFileSync(chosenFile), bytes);
      assert.deepEqual(family(chosenFile), ['secrets.enc']);
      assert.equal(fs.existsSync(secretsFile()), false, 'no keys were made up for the current folder');

      // Binding the folder meets the same error as before: nothing replaces the file.
      setDataDirOverride(chosen);
      assertUnreadable(() => vaultKey(), stage, 'vaultKey()');
      assertUnreadable(() => setProviderKey('ANTHROPIC_API_KEY', 'synthetic-wizard-key'), stage, 'setProviderKey()');
      assert.deepEqual(fs.readFileSync(chosenFile), bytes);
      assert.deepEqual(family(chosenFile), ['secrets.enc']);
    });
  }

  it('an unreadable file does not block a fresh start in an empty folder, and is kept', () => {
    const damagedFile = secretsFile();
    const damaged = writeRaw(damagedFile, '{"vaultKey": "trunc');
    assertUnreadable(() => vaultKey(), 'parse', 'vaultKey()');

    const empty = freshDir();
    setDataDirOverride(empty);
    const key = vaultKey();
    assert.equal(readBlob(path.join(empty, 'secrets.enc')).vaultKey, key);
    assert.deepEqual(fs.readFileSync(damagedFile), damaged, 'the old file stays exactly as it was');
  });
});

/**
 * The embedded Postgres passwords (the bootstrap superuser's, the kernel
 * role's) live in the same blob. They are created lazily, like the credential
 * keychain key, and read back from the file before the database is
 * provisioned with them: a password the cluster knows but `secrets.enc` does
 * not would lock the shell out of its own database.
 */
describe('secrets.ts — embedded database credentials', () => {
  const HEX64 = /^[0-9a-f]{64}$/;

  it('generates two distinct random passwords once and persists them', () => {
    const creds = embeddedDbCredentials();
    assert.match(creds.superuserPassword, HEX64);
    assert.match(creds.kernelPassword, HEX64);
    assert.notEqual(creds.superuserPassword, creds.kernelPassword);
    assert.deepEqual(readBlob(secretsFile()).embeddedDb, creds);
    assert.deepEqual(embeddedDbCredentials(), creds, 'the second call returns the same values');
    __resetSecretsCacheForTests();
    assert.deepEqual(embeddedDbCredentials(), creds, 'and so does a fresh read of the file');
  });

  it('adds them to an existing blob once, keeping every other key', () => {
    const file = secretsFile();
    const before = writeBlob(file, FULL);
    const creds = embeddedDbCredentials();
    const stored = readBlob(file);
    assert.deepEqual(stored.embeddedDb, creds);
    assert.equal(stored.vaultKey, FULL.vaultKey);
    assert.equal(stored.credentialKeychainKey, FULL.credentialKeychainKey);
    assert.deepEqual(stored.providerKeys, FULL.providerKeys);
    assert.deepEqual(fs.readFileSync(`${file}.bak`), before, 'the rewrite kept a backup');

    const afterFirst = fs.readFileSync(file);
    embeddedDbCredentials();
    assert.deepEqual(fs.readFileSync(file), afterFirst, 'a second call does not write again');
  });

  it('returns stored credentials unchanged and does not rewrite the file', () => {
    const file = secretsFile();
    const stored = { superuserPassword: 'a'.repeat(64), kernelPassword: 'b'.repeat(64) };
    const bytes = writeBlob(file, { ...FULL, embeddedDb: stored });
    assert.deepEqual(embeddedDbCredentials(), stored);
    assert.deepEqual(fs.readFileSync(file), bytes);
  });

  it('refuses credentials that do not read back from the file', () => {
    // A codec that loses the field on the way back: the write went through,
    // but the file does not hold what the database would be provisioned with.
    const encode = (plain: string): Buffer =>
      Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`);
    __setSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: encode,
      decryptString: (cipher: Buffer) => {
        const plain = Buffer.from(cipher.toString('utf8').slice(4), 'base64').toString('utf8');
        const { embeddedDb: _dropped, ...rest } = JSON.parse(plain) as StoredBlob;
        return JSON.stringify(rest);
      },
    });
    writeRaw(secretsFile(), encode(JSON.stringify(FULL)).toString('utf8'));
    assert.throws(() => embeddedDbCredentials(), /read back/);
    assert.throws(() => embeddedDbCredentials(), /read back/, 'and the cache does not serve them later');
  });

  it('does not serve them from the cache when the read-back itself fails', () => {
    // The keychain opens the file it found but refuses the one just written.
    const encode = (prefix: string, plain: string): Buffer =>
      Buffer.from(`${prefix}${Buffer.from(plain, 'utf8').toString('base64')}`);
    __setSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => encode('new:', plain),
      decryptString: (cipher: Buffer) => {
        const text = cipher.toString('utf8');
        if (!text.startsWith('old:')) throw new Error('keychain denied');
        return Buffer.from(text.slice(4), 'base64').toString('utf8');
      },
    });
    writeRaw(secretsFile(), encode('old:', JSON.stringify(FULL)).toString('utf8'));
    assertUnreadable(() => embeddedDbCredentials(), 'decrypt', 'embeddedDbCredentials()');
    assertUnreadable(() => embeddedDbCredentials(), 'decrypt', 'a retry reads the file, not the cache');
  });

  it('never leave the shell through the recovery key', () => {
    const creds = embeddedDbCredentials();
    const recovery = exportRecoveryKey();
    assert.equal(recovery, readBlob(secretsFile()).vaultKey);
    assert.ok(!recovery.includes(creds.superuserPassword));
    assert.ok(!recovery.includes(creds.kernelPassword));
  });
});
