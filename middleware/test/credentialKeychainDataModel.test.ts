/**
 * #578 Phase 1 — the credential keychain's data model and in-memory store.
 *
 * The Postgres round-trip (and its unique/foreign-key error mapping) is
 * pinned in `postgresCredentialStore.pg.test.ts`. This file covers the
 * properties that must hold regardless of backend: the two CHECK-constraint
 * equivalents `validateNewGrantInput` enforces in application code (a "once"
 * grant needs an expiry; a grant needs a stated purpose), the `isGrantActive`
 * decision function every backend defers to, and the in-memory store's own
 * behaviour (duplicate names, idempotent revoke/consume, principal
 * canonicalisation).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  fingerprintSecret,
  InMemoryCredentialStore,
  isGrantActive,
  makePrincipal,
  validateNewGrantInput,
  type CredentialGrant,
  type EncryptedSecretMaterial,
  type Principal,
} from '@omadia/channel-sdk';

const ALICE = makePrincipal('user', 'Alice@Example.com') as Principal;
const SHOUTY_ALICE = makePrincipal('user', 'ALICE@EXAMPLE.COM') as Principal;

// A trivial, reversible "cipher" — XOR is not real encryption, but these
// tests only need seal/unseal to round-trip so the store's OWN logic (not
// AES-GCM, which is covered in credentialCrypto.test.ts) is what's exercised.
function fakeSeal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function fakeUnseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

function makeStore(): InMemoryCredentialStore {
  return new InMemoryCredentialStore(fakeSeal, fakeUnseal);
}

function baseGrant(overrides: Partial<CredentialGrant> = {}): CredentialGrant {
  return {
    id: 'g1',
    credentialId: 'c1',
    principal: ALICE,
    mode: 'standing',
    purpose: 'test',
    grantedBy: 'operator',
    grantedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('#578 fingerprintSecret', () => {
  it('is deterministic for the same secret', () => {
    assert.equal(fingerprintSecret('shh'), fingerprintSecret('shh'));
  });

  it('differs for different secrets', () => {
    assert.notEqual(fingerprintSecret('shh-1'), fingerprintSecret('shh-2'));
  });

  it('never contains the secret itself — the whole point of a log surrogate', () => {
    const secret = 'super-secret-value-please-do-not-leak';
    assert.ok(!fingerprintSecret(secret).includes(secret));
  });
});

describe('#578 validateNewGrantInput', () => {
  it('rejects an empty purpose', () => {
    assert.throws(() =>
      validateNewGrantInput({
        credentialId: 'c1',
        principal: ALICE,
        mode: 'standing',
        purpose: '   ',
        grantedBy: 'operator',
      }),
    );
  });

  it('rejects a "once" grant with no expiry', () => {
    assert.throws(() =>
      validateNewGrantInput({
        credentialId: 'c1',
        principal: ALICE,
        mode: 'once',
        purpose: 'one-off lookup',
        grantedBy: 'operator',
      }),
    );
  });

  it('accepts a "standing" grant with no expiry', () => {
    assert.doesNotThrow(() =>
      validateNewGrantInput({
        credentialId: 'c1',
        principal: ALICE,
        mode: 'standing',
        purpose: 'ongoing sync',
        grantedBy: 'operator',
      }),
    );
  });

  it('accepts a "once" grant that DOES carry an expiry', () => {
    assert.doesNotThrow(() =>
      validateNewGrantInput({
        credentialId: 'c1',
        principal: ALICE,
        mode: 'once',
        purpose: 'one-off lookup',
        grantedBy: 'operator',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
  });
});

describe('#578 isGrantActive', () => {
  const NOW = new Date('2026-06-01T12:00:00Z');

  it('a standing grant with no expiry is active', () => {
    assert.equal(isGrantActive(baseGrant(), NOW), true);
  });

  it('a revoked grant is never active, expiry notwithstanding', () => {
    const grant = baseGrant({ expiresAt: new Date(NOW.getTime() + 1000), revokedAt: NOW });
    assert.equal(isGrantActive(grant, NOW), false);
  });

  it('a grant expires strictly at its expiry instant (boundary, not just past it)', () => {
    const grant = baseGrant({ expiresAt: NOW });
    assert.equal(isGrantActive(grant, NOW), false, 'expiresAt === now must already read as expired');
  });

  it('a grant one millisecond before its expiry is still active', () => {
    const grant = baseGrant({ expiresAt: new Date(NOW.getTime() + 1) });
    assert.equal(isGrantActive(grant, NOW), true);
  });

  it('a consumed "once" grant is inactive even before its expiry', () => {
    const grant = baseGrant({
      mode: 'once',
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: new Date(NOW.getTime() - 1000),
    });
    assert.equal(isGrantActive(grant, NOW), false);
  });

  it('an UNconsumed "once" grant before its expiry is active', () => {
    const grant = baseGrant({ mode: 'once', expiresAt: new Date(NOW.getTime() + 60_000) });
    assert.equal(isGrantActive(grant, NOW), true);
  });
});

describe('#578 InMemoryCredentialStore', () => {
  it('round-trips a secret through seal/unseal without storing it in the returned metadata', async () => {
    const store = makeStore();
    const cred = await store.createCredential({
      name: 'github-token',
      kind: 'personal',
      owner: ALICE,
      secret: 'ghp_abc123',
      createdBy: 'alice',
    });
    assert.ok(!JSON.stringify(cred).includes('ghp_abc123'), 'plaintext must not appear in the metadata');
    assert.equal(await store.unsealForTest(cred.id), 'ghp_abc123');
  });

  it('refuses a duplicate name among live credentials', async () => {
    const store = makeStore();
    await store.createCredential({ name: 'dup', kind: 'service', secret: 's1', createdBy: 'op' });
    await assert.rejects(() =>
      store.createCredential({ name: 'dup', kind: 'service', secret: 's2', createdBy: 'op' }),
    );
  });

  it('allows reusing a name after the credential holding it was revoked', async () => {
    const store = makeStore();
    const first = await store.createCredential({ name: 'dup', kind: 'service', secret: 's1', createdBy: 'op' });
    await store.revokeCredential(first.id, 'op');
    await assert.doesNotReject(() =>
      store.createCredential({ name: 'dup', kind: 'service', secret: 's2', createdBy: 'op' }),
    );
  });

  it('getCredentialByName ignores a revoked credential; getCredential(id) still finds it', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 'x', kind: 'service', secret: 's', createdBy: 'op' });
    await store.revokeCredential(cred.id, 'op');
    assert.equal(await store.getCredentialByName('x'), undefined);
    assert.ok(await store.getCredential(cred.id));
  });

  it('reports honestly whether a revoke did anything', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 'y', kind: 'service', secret: 's', createdBy: 'op' });
    assert.equal(await store.revokeCredential(cred.id, 'op'), true);
    assert.equal(await store.revokeCredential(cred.id, 'op'), false, 'a second revoke changes nothing');
    assert.equal(await store.revokeCredential('does-not-exist', 'op'), false);
  });

  it('getSecretMaterial is undefined for an unknown id, never throws', async () => {
    const store = makeStore();
    assert.equal(await store.getSecretMaterial('nope'), undefined);
  });

  it('createGrant refuses an unknown credential', async () => {
    const store = makeStore();
    await assert.rejects(() =>
      store.createGrant({
        credentialId: 'nope',
        principal: ALICE,
        mode: 'standing',
        purpose: 'test',
        grantedBy: 'op',
      }),
    );
  });

  it('createGrant enforces validateNewGrantInput before touching storage', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 'z', kind: 'service', secret: 's', createdBy: 'op' });
    await assert.rejects(() =>
      store.createGrant({
        credentialId: cred.id,
        principal: ALICE,
        mode: 'once',
        purpose: 'test',
        grantedBy: 'op',
        // no expiresAt — must be rejected before a row is ever considered
      }),
    );
    assert.deepEqual(await store.listGrantsForCredential(cred.id), []);
  });

  it('markGrantConsumed is idempotent: true once, false thereafter', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 'w', kind: 'service', secret: 's', createdBy: 'op' });
    const grant = await store.createGrant({
      credentialId: cred.id,
      principal: ALICE,
      mode: 'once',
      purpose: 'test',
      grantedBy: 'op',
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await store.markGrantConsumed(grant.id, new Date()), true);
    assert.equal(await store.markGrantConsumed(grant.id, new Date()), false);
  });

  it('activeGrant matches a principal across the #333 user-canonicalisation rule', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 'v', kind: 'service', secret: 's', createdBy: 'op' });
    await store.createGrant({
      credentialId: cred.id,
      principal: ALICE,
      mode: 'standing',
      purpose: 'test',
      grantedBy: 'op',
    });
    const found = await store.activeGrant(cred.id, SHOUTY_ALICE, new Date());
    assert.ok(found, 'a differently-cased spelling of the same user must still match');
  });

  it('activeGrant re-canonicalises a RAW, not-yet-canonical principal literal', async () => {
    // `makePrincipal` already canonicalises at construction, so comparing two
    // `makePrincipal`-built principals cannot prove the store's OWN
    // canonicalisation does anything — it would pass even if
    // `principalsMatch` compared raw refs. A raw object literal (as a store
    // reconstructing a Principal from a differently-spelled external source
    // might produce) is the only input shape that actually exercises it.
    const store = makeStore();
    const cred = await store.createCredential({ name: 'v-raw', kind: 'service', secret: 's', createdBy: 'op' });
    await store.createGrant({
      credentialId: cred.id,
      principal: ALICE,
      mode: 'standing',
      purpose: 'test',
      grantedBy: 'op',
    });
    const rawShouty: Principal = { kind: 'user', userId: 'ALICE-RAW-NOT-CANONICAL@EXAMPLE.COM' };
    const aliceRaw: Principal = { kind: 'user', userId: 'alice-raw-not-canonical@example.com' };
    await store.createGrant({
      credentialId: cred.id,
      principal: aliceRaw,
      mode: 'standing',
      purpose: 'test',
      grantedBy: 'op',
    });
    const found = await store.activeGrant(cred.id, rawShouty, new Date());
    assert.ok(found, 'a raw, differently-cased principal literal must still match the canonical grant');
  });

  it('activeGrant returns undefined once the only grant is revoked', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 'u', kind: 'service', secret: 's', createdBy: 'op' });
    const grant = await store.createGrant({
      credentialId: cred.id,
      principal: ALICE,
      mode: 'standing',
      purpose: 'test',
      grantedBy: 'op',
    });
    await store.revokeGrant(grant.id, 'op');
    assert.equal(await store.activeGrant(cred.id, ALICE, new Date()), undefined);
  });

  it('listGrantsForPrincipal only returns that principal\'s grants', async () => {
    const store = makeStore();
    const cred = await store.createCredential({ name: 't', kind: 'service', secret: 's', createdBy: 'op' });
    const bob = makePrincipal('user', 'bob@example.com') as Principal;
    await store.createGrant({ credentialId: cred.id, principal: ALICE, mode: 'standing', purpose: 'p', grantedBy: 'op' });
    await store.createGrant({ credentialId: cred.id, principal: bob, mode: 'standing', purpose: 'p', grantedBy: 'op' });
    const aliceGrants = await store.listGrantsForPrincipal(ALICE);
    assert.equal(aliceGrants.length, 1);
    assert.deepEqual(aliceGrants[0]?.principal, ALICE);
  });
});
