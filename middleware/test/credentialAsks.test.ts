/**
 * #578 Phase 3 — `InMemoryCredentialAskStore` and the ask data model
 * (`validateNewAskInput`, `isAskActionable`, `assertAskableCredential`).
 *
 * The Postgres round-trip (including the transactional approve and the
 * concurrent-approval race) is covered in `postgresCredentialAskStore.pg.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryCredentialStore, makePrincipal, type EncryptedSecretMaterial, type Principal } from '@omadia/channel-sdk';

import {
  InMemoryCredentialAskStore,
  assertAskableCredential,
  isAskActionable,
  validateNewAskInput,
  type CredentialAsk,
} from '../src/credentials/asks.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal; // requester
const OWNER = makePrincipal('user', 'owner@example.com') as Principal;

function fakeSeal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function fakeUnseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

function baseAsk(overrides: Partial<CredentialAsk> = {}): CredentialAsk {
  return {
    id: 'a1',
    credentialId: 'c1',
    requester: ALICE,
    owner: OWNER,
    purpose: 'test',
    mode: 'standing',
    askExpiresAt: new Date('2026-06-02T00:00:00Z'),
    status: 'pending',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

async function makeCredentialStore(): Promise<InMemoryCredentialStore> {
  return new InMemoryCredentialStore(fakeSeal, fakeUnseal);
}

describe('#578 validateNewAskInput', () => {
  it('rejects an empty purpose', () => {
    assert.throws(() =>
      validateNewAskInput({
        credentialId: 'c1',
        requester: ALICE,
        owner: OWNER,
        purpose: '   ',
        mode: 'standing',
        askExpiresAt: new Date(),
      }),
    );
  });

  it('rejects a "once" ask with no requestedGrantExpiresAt', () => {
    assert.throws(() =>
      validateNewAskInput({
        credentialId: 'c1',
        requester: ALICE,
        owner: OWNER,
        purpose: 'need it once',
        mode: 'once',
        askExpiresAt: new Date(),
      }),
    );
  });

  it('accepts a "once" ask that DOES carry a requestedGrantExpiresAt', () => {
    assert.doesNotThrow(() =>
      validateNewAskInput({
        credentialId: 'c1',
        requester: ALICE,
        owner: OWNER,
        purpose: 'need it once',
        mode: 'once',
        requestedGrantExpiresAt: new Date(Date.now() + 1000),
        askExpiresAt: new Date(),
      }),
    );
  });
});

describe('#578 isAskActionable', () => {
  const NOW = new Date('2026-06-01T12:00:00Z');

  it('a pending, unexpired ask is actionable', () => {
    assert.equal(isAskActionable(baseAsk({ askExpiresAt: new Date(NOW.getTime() + 1000) }), NOW), true);
  });

  it('an ask expires strictly at its expiry instant', () => {
    assert.equal(isAskActionable(baseAsk({ askExpiresAt: NOW }), NOW), false);
  });

  it('a resolved ask is never actionable again, expiry notwithstanding', () => {
    assert.equal(
      isAskActionable(baseAsk({ status: 'approved', askExpiresAt: new Date(NOW.getTime() + 60_000) }), NOW),
      false,
    );
  });
});

describe('#578 assertAskableCredential', () => {
  it('accepts a live personal credential', async () => {
    const store = await makeCredentialStore();
    const cred = await store.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    assert.doesNotThrow(() => assertAskableCredential(cred));
  });

  it('rejects a service credential — asks only make sense for personal ones', async () => {
    const store = await makeCredentialStore();
    const cred = await store.createCredential({ name: 's', kind: 'service', secret: 's', createdBy: 'op' });
    assert.throws(() => assertAskableCredential(cred));
  });

  it('rejects a revoked personal credential', async () => {
    const store = await makeCredentialStore();
    const cred = await store.createCredential({ name: 'p2', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    await store.revokeCredential(cred.id, 'op');
    const revoked = await store.getCredential(cred.id);
    assert.throws(() => assertAskableCredential(revoked!));
  });
});

describe('#578 InMemoryCredentialAskStore', () => {
  it('creates an ask against an askable credential', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(ask.status, 'pending');
  });

  it('refuses to create an ask against a service credential', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 's', kind: 'service', secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    await assert.rejects(() =>
      askStore.createAsk({
        credentialId: cred.id,
        requester: ALICE,
        owner: OWNER,
        purpose: 'need it',
        mode: 'standing',
        askExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
  });

  it('refuses to create an ask against an unknown credential', async () => {
    const credStore = await makeCredentialStore();
    const askStore = new InMemoryCredentialAskStore(credStore);
    await assert.rejects(() =>
      askStore.createAsk({
        credentialId: 'nope',
        requester: ALICE,
        owner: OWNER,
        purpose: 'need it',
        mode: 'standing',
        askExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
  });

  it('approve() creates a grant the requester can then use', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });

    const approved = await askStore.approve(ask.id, 'owner@example.com', new Date());
    assert.ok(approved);
    assert.equal(approved?.status, 'approved');
    assert.ok(approved?.grantId);

    const active = await credStore.activeGrant(cred.id, ALICE, new Date());
    assert.ok(active, 'approval must have created a usable grant');
  });

  it('deny() resolves the ask without creating a grant', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    const denied = await askStore.deny(ask.id, 'owner@example.com', new Date());
    assert.equal(denied?.status, 'denied');
    assert.equal(await credStore.activeGrant(cred.id, ALICE, new Date()), undefined);
  });

  it('approve() on an already-resolved ask returns undefined, not a second grant', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    await askStore.deny(ask.id, 'owner@example.com', new Date());
    const secondTry = await askStore.approve(ask.id, 'owner@example.com', new Date());
    assert.equal(secondTry, undefined);
  });

  it('approve() on an expired ask returns undefined', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 1000),
    });
    const result = await askStore.approve(ask.id, 'owner@example.com', new Date(Date.now() + 2000));
    assert.equal(result, undefined);
  });

  it('listPendingForOwner excludes an expired-but-still-"pending" ask', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 1000),
    });
    const pending = await askStore.listPendingForOwner(OWNER, new Date(Date.now() + 2000));
    assert.deepEqual(pending, []);
  });

  it('listPendingForOwner only shows asks addressed to that owner', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const otherOwner = makePrincipal('user', 'someone-else@example.com') as Principal;
    await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: otherOwner,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.deepEqual(await askStore.listPendingForOwner(OWNER, new Date()), []);
  });

  it('cancel() only lets the ORIGINAL requester withdraw', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: OWNER,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    const bob = makePrincipal('user', 'bob@example.com') as Principal;
    assert.equal(await askStore.cancel(ask.id, bob), false, 'a different principal must not cancel someone else\'s ask');
    assert.equal(await askStore.cancel(ask.id, ALICE), true);
    assert.equal(await askStore.cancel(ask.id, ALICE), false, 'cancelling twice changes nothing the second time');
  });
});
