/**
 * #578 Phase 1 — the keychain's AES-256-GCM envelope and master-key
 * resolution.
 *
 * Mirrors the property `fileVault.ts` cares about (a tampered ciphertext or
 * auth tag must fail loudly, never decrypt to garbage silently) and the
 * production-mode refusal `resolveMasterKey` already enforces for the
 * provider vault — pinned again here because `resolveCredentialMasterKey`
 * wraps it under a DIFFERENT env var and dev-key filename, and a copy-paste
 * slip in that wiring (e.g. reading `VAULT_KEY` by accident) would silently
 * make the keychain share a key with the provider-secret vault.
 */

import { strict as assert } from 'node:assert';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { resolveCredentialMasterKey, sealSecret, unsealSecret } from '../src/credentials/crypto.js';

describe('#578 sealSecret / unsealSecret', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips plaintext', () => {
    const material = sealSecret('super-secret-value', key);
    assert.equal(unsealSecret(material, key), 'super-secret-value');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const a = sealSecret('same-plaintext', key);
    const b = sealSecret('same-plaintext', key);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  it('refuses to decrypt with the wrong key', () => {
    const material = sealSecret('secret', key);
    const wrongKey = Buffer.alloc(32, 9);
    assert.throws(() => unsealSecret(material, wrongKey));
  });

  it('refuses a tampered ciphertext (GCM auth tag catches it)', () => {
    const material = sealSecret('secret', key);
    const tamperedByte = Buffer.from(material.ciphertext, 'base64');
    tamperedByte[0] = (tamperedByte[0] ?? 0) ^ 0xff;
    const tampered = { ...material, ciphertext: tamperedByte.toString('base64') };
    assert.throws(() => unsealSecret(tampered, key));
  });

  it('refuses a tampered auth tag', () => {
    const material = sealSecret('secret', key);
    const tamperedTag = Buffer.from(material.tag, 'base64');
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff;
    const tampered = { ...material, tag: tamperedTag.toString('base64') };
    assert.throws(() => unsealSecret(tampered, key));
  });
});

describe('#578 resolveCredentialMasterKey', () => {
  let dir = '';
  const originalEnv = process.env.CREDENTIAL_KEYCHAIN_KEY;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omadia-credential-key-'));
    delete process.env.CREDENTIAL_KEYCHAIN_KEY;
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.CREDENTIAL_KEYCHAIN_KEY;
    else process.env.CREDENTIAL_KEYCHAIN_KEY = originalEnv;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('prefers CREDENTIAL_KEYCHAIN_KEY when set', async () => {
    const raw = Buffer.alloc(32, 3);
    process.env.CREDENTIAL_KEYCHAIN_KEY = raw.toString('base64');
    const result = await resolveCredentialMasterKey(dir);
    assert.equal(result.source, 'env');
    assert.ok(result.key.equals(raw));
  });

  it('rejects an env key that does not decode to exactly 32 bytes', async () => {
    process.env.CREDENTIAL_KEYCHAIN_KEY = Buffer.alloc(16, 1).toString('base64');
    await assert.rejects(() => resolveCredentialMasterKey(dir));
  });

  it('creates a dev key file on first use, then reuses it', async () => {
    const first = await resolveCredentialMasterKey(dir);
    assert.equal(first.source, 'dev-file-created');
    const second = await resolveCredentialMasterKey(dir);
    assert.equal(second.source, 'dev-file-existed');
    assert.ok(first.key.equals(second.key), 'the second call must read back the SAME key, not mint a new one');
  });

  it('writes its dev key to a DIFFERENT file than the provider vault, so a shared data dir does not collide', async () => {
    await resolveCredentialMasterKey(dir);
    const files = await fsp.readdir(dir);
    assert.ok(files.includes('.dev-credential-keychain.key'));
    assert.ok(!files.includes('.dev-vault.key'), 'must not touch the provider-vault key file');
  });

  it('refuses to fall back to a dev key file when productionMode is true', async () => {
    await assert.rejects(() => resolveCredentialMasterKey(dir, true));
    const files = await fsp.readdir(dir).catch((): string[] => []);
    assert.ok(!files.includes('.dev-credential-keychain.key'), 'must not create a dev key in production mode');
  });
});
