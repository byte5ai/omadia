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
  exportRecoveryKey,
  getProviderKey,
  setProviderKey,
  vaultKey,
} from '../src/secrets.ts';

interface StoredBlob {
  vaultKey: string;
  credentialKeychainKey?: string;
  providerKeys: Record<string, string>;
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
  ['allProviderKeys()', () => allProviderKeys()],
  ['setProviderKey()', () => setProviderKey('ANTHROPIC_API_KEY', 'synthetic-provider-key')],
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
  it('does not write the key revealed on the last wizard step over a file in the chosen folder', () => {
    // The wizard's Reveal button reads the key BEFORE `complete` applies the
    // chosen data dir, so a path-agnostic cache used to write the userData blob
    // over whatever the chosen folder already held.
    const revealed = exportRecoveryKey();
    const userDataFile = secretsFile();
    const userDataBytes = fs.readFileSync(userDataFile);

    const chosen = freshDir();
    const chosenFile = path.join(chosen, 'secrets.enc');
    const chosenBytes = writeBlob(chosenFile, FULL);
    setDataDirOverride(chosen);

    setProviderKey('ANTHROPIC_API_KEY', 'synthetic-wizard-key');
    const stored = readBlob(chosenFile);
    assert.equal(stored.vaultKey, FULL.vaultKey, 'the chosen folder keeps its own vault key');
    assert.notEqual(stored.vaultKey, revealed);
    assert.equal(stored.credentialKeychainKey, FULL.credentialKeychainKey);
    assert.equal(stored.providerKeys['ANTHROPIC_API_KEY'], 'synthetic-wizard-key');
    assert.deepEqual(fs.readFileSync(`${chosenFile}.bak`), chosenBytes);
    assert.deepEqual(fs.readFileSync(userDataFile), userDataBytes, 'the userData blob is untouched');
    assert.equal(exportRecoveryKey(), FULL.vaultKey, 'the recovery key now names the key in use');
  });

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
