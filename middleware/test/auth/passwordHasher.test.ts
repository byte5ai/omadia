import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../src/auth/passwordHasher.js';

describe('passwordHasher (argon2id)', () => {
  it('produces an argon2id-encoded hash with stable parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.ok(
      hash.startsWith('$argon2id$'),
      `expected argon2id prefix, got: ${hash.slice(0, 16)}`,
    );
    // Parameters tuple should match passwordHasher.HASH_OPTIONS.
    assert.match(hash, /m=19456,t=2,p=1/);
  });

  it('verify roundtrips a correct password', async () => {
    const plain = 'a-good-passphrase-2026';
    const hash = await hashPassword(plain);
    assert.equal(await verifyPassword(hash, plain), true);
  });

  it('verify rejects a wrong password', async () => {
    const hash = await hashPassword('right one');
    assert.equal(await verifyPassword(hash, 'wrong one'), false);
  });

  it('verify returns false (no throw) on malformed hashes', async () => {
    assert.equal(await verifyPassword('', 'whatever'), false);
    assert.equal(await verifyPassword('not-a-hash', 'whatever'), false);
    assert.equal(await verifyPassword('$argon2id$totally-broken', 'whatever'), false);
  });

  it('hashPassword refuses empty input', async () => {
    await assert.rejects(() => hashPassword(''));
  });

  it('needsRehash returns false for a freshly minted hash', async () => {
    const hash = await hashPassword('x'.repeat(16));
    assert.equal(needsRehash(hash), false);
  });

  it('needsRehash tolerates malformed input', () => {
    assert.equal(needsRehash('not-a-hash'), false);
  });
});
