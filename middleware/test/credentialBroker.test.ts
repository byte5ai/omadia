/**
 * #578 Phase 2 — `CredentialBroker`: the whole egress-stamping decision,
 * end to end, against `InMemoryCredentialStore`.
 *
 * Every deny path gets its own test (the check order in `broker.ts`'s
 * header exists precisely so each one is independently reachable). The
 * `host-not-allowed` test is the SSRF-prevention case: a broker that
 * trusted the declaration alone and skipped comparing it against the
 * request would turn "wrong destination" into a successful exfiltration.
 */

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  InMemoryCredentialStore,
  makePrincipal,
  type Credential,
  type CredentialGrant,
  type CredentialStore,
  type EncryptedSecretMaterial,
  type NewCredentialGrantInput,
  type NewCredentialInput,
  type Principal,
} from '@omadia/channel-sdk';

import { BrokerDenialError, CredentialBroker, type BrokerAuditEvent, type BrokerFetch } from '../src/credentials/broker.js';
import { resetBrokerMetrics, getBrokerMetrics } from '../src/credentials/brokerMetrics.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const BOB = makePrincipal('user', 'bob@example.com') as Principal;

// A trivial, reversible "cipher" for these tests — the real AES-GCM path is
// covered in credentialCrypto.test.ts. Here only the broker's OWN logic is
// under test.
function seal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function unseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

function stubFetch(): { fetch: BrokerFetch; calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: BrokerFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return {
      status: 200,
      headers: [['content-type', 'application/json']],
      text: async () => '{"ok":true}',
    };
  };
  return { fetch, calls };
}

const SERVICE_SECRET = 'sk-super-secret-token-value';

async function makeServiceCredential(
  store: CredentialStore,
  overrides: Partial<NewCredentialInput> = {},
): Promise<Credential> {
  return store.createCredential({
    name: overrides.name ?? `svc-${Math.random().toString(36).slice(2)}`,
    kind: 'service',
    secret: SERVICE_SECRET,
    createdBy: 'op',
    broker: {
      host: 'api.example.com',
      injectionScheme: 'bearer',
      allowedMethods: ['GET', 'POST'],
      pathPrefixes: ['/v1/messages'],
    },
    ...overrides,
  });
}

async function grant(
  store: CredentialStore,
  overrides: Partial<NewCredentialGrantInput> & { credentialId: string },
): Promise<CredentialGrant> {
  return store.createGrant({
    principal: ALICE,
    mode: 'standing',
    purpose: 'test',
    grantedBy: 'op',
    ...overrides,
  });
}

describe('#578 CredentialBroker', () => {
  let store: InMemoryCredentialStore;
  let audits: BrokerAuditEvent[];
  let broker: CredentialBroker;
  let fetchStub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    resetBrokerMetrics();
    store = new InMemoryCredentialStore(seal, unseal);
    audits = [];
    fetchStub = stubFetch();
    broker = new CredentialBroker({
      store,
      unseal,
      fetchImpl: fetchStub.fetch,
      onAudit: (event) => audits.push(event),
    });
  });

  it('allows a matching request and stamps a bearer token onto the outbound call', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });

    const res = await broker.request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'get',
      path: '/v1/messages/123',
    });

    assert.equal(res.status, 200);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0]?.url, 'https://api.example.com/v1/messages/123');
    assert.equal(fetchStub.calls[0]?.headers.Authorization, `Bearer ${SERVICE_SECRET}`);
    assert.equal(getBrokerMetrics().allowed, 1);
  });

  it('the caller never receives the secret in the response', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    const res = await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    assert.ok(!JSON.stringify(res).includes(SERVICE_SECRET));
  });

  it('a caller-supplied Authorization header cannot override or discover the injected one', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/messages',
      headers: { Authorization: 'Bearer forged-value' },
    });
    assert.equal(fetchStub.calls[0]?.headers.Authorization, `Bearer ${SERVICE_SECRET}`);
  });

  it('header injection scheme uses the declared injectionKey', async () => {
    const cred = await store.createCredential({
      name: 'header-svc',
      kind: 'service',
      secret: 'the-api-key',
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: 'header',
        injectionKey: 'X-Api-Key',
        allowedMethods: ['GET'],
        pathPrefixes: ['/v1'],
      },
    });
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' });
    assert.equal(fetchStub.calls[0]?.headers['X-Api-Key'], 'the-api-key');
  });

  it('basic-password scheme base64-encodes the secret as the whole Basic credential', async () => {
    const cred = await store.createCredential({
      name: 'basic-svc',
      kind: 'service',
      secret: 'user:pass',
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: 'basic-password',
        allowedMethods: ['GET'],
        pathPrefixes: ['/v1'],
      },
    });
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' });
    assert.equal(fetchStub.calls[0]?.headers.Authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('query-param scheme appends the secret to the URL, preserving existing query params', async () => {
    const cred = await store.createCredential({
      name: 'qp-svc',
      kind: 'service',
      secret: 'qp-secret',
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: 'query-param',
        injectionKey: 'api_key',
        allowedMethods: ['GET'],
        pathPrefixes: ['/v1'],
      },
    });
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x?limit=5' });
    assert.equal(fetchStub.calls[0]?.url, 'https://api.example.com/v1/x?limit=5&api_key=qp-secret');
  });

  it('query-param scheme URL-encodes a secret containing reserved characters', async () => {
    const trickySecret = 'qp secret&value=1';
    const cred = await store.createCredential({
      name: 'qp-tricky-svc',
      kind: 'service',
      secret: trickySecret,
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: 'query-param',
        injectionKey: 'api key', // also reserved, to prove the KEY is encoded too
        allowedMethods: ['GET'],
        pathPrefixes: ['/v1'],
      },
    });
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' });
    const url = fetchStub.calls[0]?.url ?? '';
    assert.ok(!url.includes('&value=1'), 'an unencoded "&" in the secret must not start a new query param');
    assert.equal(
      url,
      `https://api.example.com/v1/x?${encodeURIComponent('api key')}=${encodeURIComponent(trickySecret)}`,
    );
  });

  it('a "once" grant that fails host/path checks is NOT consumed — the check order in the module header', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id, mode: 'once', expiresAt: new Date(Date.now() + 60_000) });

    // Wrong host: must deny WITHOUT burning the single-use grant.
    await assert.rejects(() =>
      broker.request(cred.id, ALICE, { host: 'evil.example.com', method: 'GET', path: '/v1/messages' }),
    );
    // The correctly-addressed request must still succeed — the grant survived.
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    assert.equal(fetchStub.calls.length, 1);
  });

  it('denies: unknown credential', async () => {
    await assert.rejects(
      () => broker.request('nope', ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'credential-not-found',
    );
    assert.equal(fetchStub.calls.length, 0);
  });

  it('denies: revoked credential', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await store.revokeCredential(cred.id, 'op');
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'credential-revoked',
    );
  });

  it('denies: a `personal` credential — the broker only serves `service` credentials', async () => {
    const cred = await store.createCredential({
      name: 'personal-cred',
      kind: 'personal',
      owner: ALICE,
      secret: 's',
      createdBy: 'op',
    });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'not-a-service-credential',
    );
  });

  it('denies: a `service` credential with no broker declaration', async () => {
    const cred = await store.createCredential({ name: 'no-decl', kind: 'service', secret: 's', createdBy: 'op' });
    await grant(store, { credentialId: cred.id });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'not-a-service-credential',
    );
  });

  it('denies: no grant at all for this principal', async () => {
    const cred = await makeServiceCredential(store);
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'no-active-grant',
    );
  });

  it('denies: a grant exists but for a DIFFERENT principal', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id, principal: BOB });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'no-active-grant',
    );
  });

  it('denies: an expired grant', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id, expiresAt: new Date(Date.now() - 1000) });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'no-active-grant',
    );
  });

  it('denies (SSRF prevention): the request names a host DIFFERENT from the credential\'s declared host', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'evil.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'host-not-allowed',
    );
    assert.equal(fetchStub.calls.length, 0, 'must never dispatch to the wrong host');
  });

  it('denies: a method not in allowedMethods', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'DELETE', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'method-not-allowed',
    );
  });

  it('denies: a path outside every declared prefix', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/admin' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'path-not-allowed',
    );
  });

  it('denies (traversal): a path that normalises OUTSIDE the declared prefix, even though the raw string starts with it', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await assert.rejects(
      () =>
        broker.request(cred.id, ALICE, {
          host: 'api.example.com',
          method: 'GET',
          path: '/v1/messages/../../admin',
        }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'path-not-allowed',
    );
    assert.equal(fetchStub.calls.length, 0);
  });

  it('denies: a header-scheme credential missing its injectionKey', async () => {
    const cred = await store.createCredential({
      name: 'bad-header-svc',
      kind: 'service',
      secret: 's',
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: 'header',
        allowedMethods: ['GET'],
        pathPrefixes: ['/v1'],
      },
    });
    await grant(store, { credentialId: cred.id });
    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'invalid-broker-declaration',
    );
    assert.equal(fetchStub.calls.length, 0);
  });

  it('a "once" grant is consumed after use — a second attempt denies', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id, mode: 'once', expiresAt: new Date(Date.now() + 60_000) });

    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    assert.equal(fetchStub.calls.length, 1);

    await assert.rejects(
      () => broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'no-active-grant',
    );
    assert.equal(fetchStub.calls.length, 1, 'the once grant must not permit a second dispatch');
  });

  it('a "standing" grant permits repeated use', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id, mode: 'standing' });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    assert.equal(fetchStub.calls.length, 2);
  });

  it('a lost race on a "once" grant denies with grant-consumed-concurrently, never double-dispatches', async () => {
    const cred = await makeServiceCredential(store);
    const g = await grant(store, { credentialId: cred.id, mode: 'once', expiresAt: new Date(Date.now() + 60_000) });

    // Simulate a concurrent winner: something else consumes the grant AFTER
    // this test's `activeGrant` read would already have happened inside the
    // broker but BEFORE the broker's own `markGrantConsumed` call — by
    // wrapping the store so `activeGrant` consumes the grant "on behalf of
    // another caller" the instant it is read.
    const raceyStore: CredentialStore = {
      createCredential: store.createCredential.bind(store),
      getCredential: store.getCredential.bind(store),
      getCredentialByName: store.getCredentialByName.bind(store),
      listCredentials: store.listCredentials.bind(store),
      revokeCredential: store.revokeCredential.bind(store),
      getSecretMaterial: store.getSecretMaterial.bind(store),
      createGrant: store.createGrant.bind(store),
      getGrant: store.getGrant.bind(store),
      listGrantsForCredential: store.listGrantsForCredential.bind(store),
      listGrantsForPrincipal: store.listGrantsForPrincipal.bind(store),
      revokeGrant: store.revokeGrant.bind(store),
      markGrantConsumed: store.markGrantConsumed.bind(store),
      activeGrant: async (credentialId, principal, now) => {
        const found = await store.activeGrant(credentialId, principal, now);
        if (found) await store.markGrantConsumed(found.id, now);
        return found;
      },
    };
    const raceyBroker = new CredentialBroker({ store: raceyStore, unseal, fetchImpl: fetchStub.fetch });

    await assert.rejects(
      () => raceyBroker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'grant-consumed-concurrently',
    );
    assert.equal(fetchStub.calls.length, 0, 'the lost side of the race must never dispatch');
    assert.ok(g.id, 'sanity: the grant was created');
  });

  it('fails closed when the store throws (simulated outage)', async () => {
    const throwingStore: CredentialStore = {
      createCredential: () => {
        throw new Error('db down');
      },
      getCredential: () => {
        throw new Error('db down');
      },
      getCredentialByName: () => {
        throw new Error('db down');
      },
      listCredentials: () => {
        throw new Error('db down');
      },
      revokeCredential: () => {
        throw new Error('db down');
      },
      getSecretMaterial: () => {
        throw new Error('db down');
      },
      createGrant: () => {
        throw new Error('db down');
      },
      getGrant: () => {
        throw new Error('db down');
      },
      listGrantsForCredential: () => {
        throw new Error('db down');
      },
      listGrantsForPrincipal: () => {
        throw new Error('db down');
      },
      revokeGrant: () => {
        throw new Error('db down');
      },
      markGrantConsumed: () => {
        throw new Error('db down');
      },
      activeGrant: () => {
        throw new Error('db down');
      },
    };
    const outageBroker = new CredentialBroker({ store: throwingStore, unseal, fetchImpl: fetchStub.fetch });
    await assert.rejects(
      () => outageBroker.request('any-id', ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'store-unavailable',
    );
    assert.equal(fetchStub.calls.length, 0);
  });

  it('the underlying store error message never reaches the thrown denial', async () => {
    const leakyStore: CredentialStore = {
      createCredential: store.createCredential.bind(store),
      getCredential: () => {
        throw new Error(SERVICE_SECRET);
      },
      getCredentialByName: store.getCredentialByName.bind(store),
      listCredentials: store.listCredentials.bind(store),
      revokeCredential: store.revokeCredential.bind(store),
      getSecretMaterial: store.getSecretMaterial.bind(store),
      createGrant: store.createGrant.bind(store),
      getGrant: store.getGrant.bind(store),
      listGrantsForCredential: store.listGrantsForCredential.bind(store),
      listGrantsForPrincipal: store.listGrantsForPrincipal.bind(store),
      revokeGrant: store.revokeGrant.bind(store),
      markGrantConsumed: store.markGrantConsumed.bind(store),
      activeGrant: store.activeGrant.bind(store),
    };
    const leakyBroker = new CredentialBroker({ store: leakyStore, unseal, fetchImpl: fetchStub.fetch });
    try {
      await leakyBroker.request('any-id', ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' });
      assert.fail('expected a rejection');
    } catch (err) {
      assert.ok(err instanceof BrokerDenialError);
      assert.ok(!err.message.includes(SERVICE_SECRET));
    }
  });

  it('emits an audit event for every denial, never containing the secret', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await assert.rejects(() =>
      broker.request(cred.id, ALICE, { host: 'evil.example.com', method: 'GET', path: '/v1/messages' }),
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.kind, 'deny');
    assert.equal(audits[0]?.reason, 'host-not-allowed');
    assert.ok(!JSON.stringify(audits[0]).includes(SERVICE_SECRET));
  });

  it('emits an audit event for an allow too, carrying only the fingerprint', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.kind, 'allow');
    assert.equal(audits[0]?.credentialFingerprint, cred.fingerprint);
    assert.ok(!JSON.stringify(audits[0]).includes(SERVICE_SECRET));
  });

  it('records metrics for both allow and deny outcomes', async () => {
    const cred = await makeServiceCredential(store);
    await grant(store, { credentialId: cred.id });
    await broker.request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/messages' });
    await assert.rejects(() =>
      broker.request(cred.id, ALICE, { host: 'evil.example.com', method: 'GET', path: '/v1/messages' }),
    );
    const m = getBrokerMetrics();
    assert.equal(m.allowed, 1);
    assert.equal(m.denied, 1);
    assert.equal(m.byReason['host-not-allowed'], 1);
  });
});
