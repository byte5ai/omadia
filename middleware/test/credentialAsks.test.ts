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
  CredentialAskRejectedError,
  InMemoryCredentialAskStore,
  assertAskableCredential,
  isAskActionable,
  resolveAskOwner,
  validateNewAskInput,
  type CredentialAsk,
  type CredentialAskRejection,
} from '../src/credentials/asks.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal; // requester
const OWNER = makePrincipal('user', 'owner@example.com') as Principal;

function fakeSeal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function fakeUnseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

function rejectedWith(reason: CredentialAskRejection): (err: unknown) => boolean {
  return (err: unknown) => err instanceof CredentialAskRejectedError && err.reason === reason;
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
    assert.throws(
      () =>
        validateNewAskInput({
          credentialId: 'c1',
          requester: ALICE,
          owner: OWNER,
          purpose: '   ',
          mode: 'standing',
          askExpiresAt: new Date(),
        }),
      rejectedWith('invalid_input'),
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

  it('#778 S1: rejects an Invalid Date in either date field, for every mode', () => {
    const base = { credentialId: 'c1', requester: ALICE, owner: OWNER, purpose: 'p', askExpiresAt: new Date() };
    for (const mode of ['once', 'standing'] as const) {
      assert.throws(
        () => validateNewAskInput({ ...base, mode, requestedGrantExpiresAt: new Date('not-a-date') }),
        rejectedWith('invalid_input'),
        `${mode}: requestedGrantExpiresAt`,
      );
    }
    assert.throws(
      () => validateNewAskInput({ ...base, mode: 'standing', askExpiresAt: new Date(Number.NaN) }),
      rejectedWith('invalid_input'),
      'askExpiresAt',
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
    assert.throws(() => assertAskableCredential(revoked!), rejectedWith('revoked'));
  });

  it('#778 S1: accepts the minimal facts shape the Postgres store selects', () => {
    assert.doesNotThrow(() => assertAskableCredential({ id: 'c1', kind: 'personal', owner: OWNER }));
    assert.throws(() => assertAskableCredential({ id: 'c1', kind: 'personal', owner: undefined }), rejectedWith('not_askable'));
  });
});

describe('#778 S1 resolveAskOwner', () => {
  const facts = { id: 'c1', kind: 'personal' as const, owner: { kind: 'user' as const, userId: ' Owner@Example.com' } };

  it('derives the canonical owner when none is requested', () => {
    assert.deepEqual(resolveAskOwner(facts), OWNER);
  });

  it('accepts a requested owner equal after canonicalisation', () => {
    assert.deepEqual(resolveAskOwner(facts, { kind: 'user', userId: 'OWNER@EXAMPLE.COM ' }), OWNER);
  });

  it('rejects a requested owner of a different subject or kind', () => {
    assert.throws(() => resolveAskOwner(facts, ALICE), rejectedWith('owner_mismatch'));
    assert.throws(() => resolveAskOwner(facts, { kind: 'role', roleKey: 'owner@example.com' }), rejectedWith('owner_mismatch'));
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
    const otherOwner = makePrincipal('user', 'someone-else@example.com') as Principal;
    const mine = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const theirs = await credStore.createCredential({ name: 'q', kind: 'personal', owner: otherOwner, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const forOwner = await askStore.createAsk({
      credentialId: mine.id,
      requester: ALICE,
      purpose: 'mine',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    await askStore.createAsk({
      credentialId: theirs.id,
      requester: ALICE,
      purpose: 'theirs',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    const inbox = await askStore.listPendingForOwner(OWNER, new Date());
    assert.deepEqual(
      inbox.map((a) => a.id),
      [forOwner.id],
    );
  });

  it('#778 S1: a caller-supplied owner that is not the credential owner is rejected (owner_mismatch)', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    await assert.rejects(
      () =>
        askStore.createAsk({
          credentialId: cred.id,
          requester: ALICE,
          owner: makePrincipal('user', 'mallory@example.com') as Principal,
          purpose: 'need it',
          mode: 'standing',
          askExpiresAt: new Date(Date.now() + 60_000),
        }),
      rejectedWith('owner_mismatch'),
    );
    assert.deepEqual(await askStore.listForRequester(ALICE), [], 'a rejected ask must not be stored');
  });

  it('#778 S1: an omitted owner is derived from the credential and canonicalised', async () => {
    const credStore = await makeCredentialStore();
    // `InMemoryCredentialStore` stores the owner verbatim — a raw, mixed-case
    // spelling is exactly what the derivation has to canonicalise.
    const cred = await credStore.createCredential({
      name: 'p',
      kind: 'personal',
      owner: { kind: 'user', userId: '  Owner@Example.COM ' },
      secret: 's',
      createdBy: 'op',
    });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.deepEqual(ask.owner, OWNER);
  });

  it('#778 S1: a matching owner in a different spelling is accepted and stored canonically', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      owner: { kind: 'user', userId: 'OWNER@example.com' },
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.deepEqual(ask.owner, OWNER);
  });

  it('#778 S1: a role-owned personal credential is not askable — no session principal could ever answer it', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({
      name: 'p',
      kind: 'personal',
      owner: makePrincipal('role', 'finance') as Principal,
      secret: 's',
      createdBy: 'op',
    });
    const askStore = new InMemoryCredentialAskStore(credStore);
    await assert.rejects(
      () =>
        askStore.createAsk({
          credentialId: cred.id,
          requester: ALICE,
          purpose: 'need it',
          mode: 'standing',
          askExpiresAt: new Date(Date.now() + 60_000),
        }),
      rejectedWith('not_askable'),
    );
  });

  it('#778 S1: unknown / service / revoked credentials reject with typed reasons', async () => {
    const credStore = await makeCredentialStore();
    const service = await credStore.createCredential({ name: 's', kind: 'service', secret: 's', createdBy: 'op' });
    const revoked = await credStore.createCredential({ name: 'r', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    await credStore.revokeCredential(revoked.id, 'op');
    const askStore = new InMemoryCredentialAskStore(credStore);
    const input = { requester: ALICE, purpose: 'need it', mode: 'standing' as const, askExpiresAt: new Date(Date.now() + 60_000) };
    await assert.rejects(() => askStore.createAsk({ ...input, credentialId: 'nope' }), rejectedWith('unknown_credential'));
    await assert.rejects(() => askStore.createAsk({ ...input, credentialId: service.id }), rejectedWith('not_askable'));
    await assert.rejects(() => askStore.createAsk({ ...input, credentialId: revoked.id }), rejectedWith('revoked'));
  });

  it('#778 S1: approve() after the credential was revoked closes the ask as expired and mints no grant', async () => {
    const credStore = await makeCredentialStore();
    const cred = await credStore.createCredential({ name: 'p', kind: 'personal', owner: OWNER, secret: 's', createdBy: 'op' });
    const askStore = new InMemoryCredentialAskStore(credStore);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: ALICE,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    await credStore.revokeCredential(cred.id, 'op');

    const result = await askStore.approve(ask.id, 'owner@example.com', new Date());
    assert.equal(result, undefined);
    assert.equal((await askStore.getAsk(ask.id))?.status, 'expired');
    assert.deepEqual(await credStore.listGrantsForCredential(cred.id), []);
    assert.equal(await askStore.approve(ask.id, 'owner@example.com', new Date()), undefined, 'an expired ask stays closed');
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
