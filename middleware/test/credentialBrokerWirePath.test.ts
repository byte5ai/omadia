/**
 * #778 S3a — `pathPrefixes` must hold for the path that goes on the WIRE.
 *
 * `normalizePathForMatch` resolves `..` with `path.posix`, but fetch re-parses
 * the URL with the WHATWG parser, which also resolves percent-encoded dot
 * segments (`%2e%2e`, `.%2E`), reads `\` as `/` and strips tab/LF/CR. Before
 * this fix `/v1/messages/%2e%2e/%2e%2e/admin/users` passed the prefix check
 * for `/v1/messages` and reached the upstream as `GET /admin/users` with the
 * Bearer secret, while the `allow` audit recorded the unresolved path.
 *
 * Every case runs against a REAL local upstream and undici's own fetch, so
 * "the upstream received nothing" is what undici did, not what a stub
 * assumed.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { InMemoryCredentialStore, makePrincipal, type Credential, type Principal } from '@omadia/channel-sdk';

import { BrokerDenialError, CredentialBroker, type BrokerAuditEvent } from '../src/credentials/broker.js';
import { getBrokerMetrics, resetBrokerMetrics } from '../src/credentials/brokerMetrics.js';

import { closeAllUpstreams, routeTo, seal, startUpstream, unseal, type Upstream } from './_helpers/brokerUpstream.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const SECRET = 'sk-live-wirepath-secret';
const T = { timeout: 5000 };

describe('#778 S3a CredentialBroker matches pathPrefixes on the wire path', () => {
  let store: InMemoryCredentialStore;
  let audits: BrokerAuditEvent[];

  beforeEach(() => {
    resetBrokerMetrics();
    store = new InMemoryCredentialStore(seal, unseal);
    audits = [];
  });

  afterEach(closeAllUpstreams);

  async function onceCredential(host = 'api.example.com', pathPrefixes = ['/v1/messages']): Promise<Credential> {
    const cred = await store.createCredential({
      name: `svc-${Math.random().toString(36).slice(2)}`,
      kind: 'service',
      secret: SECRET,
      createdBy: 'op',
      broker: { host, injectionScheme: 'bearer', allowedMethods: ['GET'], pathPrefixes },
    });
    await store.createGrant({
      credentialId: cred.id,
      principal: ALICE,
      mode: 'once',
      purpose: 't',
      grantedBy: 'op',
      expiresAt: new Date(Date.now() + 60_000),
    });
    return cred;
  }

  function okUpstream(): Promise<Upstream> {
    return startUpstream((_req, res) => res.end('{}'));
  }

  function broker(upstream: Upstream): CredentialBroker {
    return new CredentialBroker({ store, unseal, fetchImpl: routeTo(upstream.base), onAudit: (e) => audits.push(e) });
  }

  const ESCAPES: Array<{ label: string; path: string }> = [
    { label: 'percent-encoded %2e%2e', path: '/v1/messages/%2e%2e/%2e%2e/admin/users' },
    { label: 'mixed-case .%2E / .%2e', path: '/v1/messages/.%2E/.%2e/admin' },
    { label: 'upper-case %2E%2E', path: '/v1/messages/%2E%2E/%2E%2E/admin' },
    { label: 'half-encoded %2e.', path: '/v1/messages/%2e./%2e./admin' },
    { label: 'backslash traversal', path: '/v1/messages/..\\..\\admin' },
    { label: 'backslash authority', path: '/\\evil.example.com/v1/messages' },
    { label: 'embedded tab', path: '/v1/messages/.\t./.\t./admin' },
    { label: 'embedded newline', path: '/v1/messages/.\n./.\n./admin' },
    { label: 'embedded carriage return', path: '/v1/messages/..\r/..\r/admin' },
  ];

  for (const c of ESCAPES) {
    it(`refuses a ${c.label} escape before the once grant is consumed`, T, async () => {
      const upstream = await okUpstream();
      const cred = await onceCredential();

      await assert.rejects(
        broker(upstream).request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: c.path }),
        (err: unknown) => err instanceof BrokerDenialError && err.reason === 'path-not-allowed',
      );

      assert.equal(upstream.requests.length, 0, 'the secret must not reach the upstream');
      assert.ok(await store.activeGrant(cred.id, ALICE, new Date()), 'the once grant must still be active');
      assert.deepEqual(
        audits.map((e) => [e.kind, e.reason]),
        [['deny', 'path-not-allowed']],
      );
      assert.equal(getBrokerMetrics().allowed, 0);
    });
  }

  const ALLOWED: Array<{ label: string; path: string; wire: string }> = [
    { label: 'a dot segment that resolves back inside', path: '/v1/messages/%2e%2e/messages/1', wire: '/v1/messages/1' },
    { label: 'an encoded dot inside a name', path: '/v1/messages/a%2Eb', wire: '/v1/messages/a%2Eb' },
    { label: 'a GitLab-style encoded slash', path: '/v1/messages/group%2Fproject', wire: '/v1/messages/group%2Fproject' },
    { label: 'a space the parser encodes', path: '/v1/messages/a b', wire: '/v1/messages/a%20b' },
    { label: 'a query that looks like traversal', path: '/v1/messages/x?q=%2e%2e/admin', wire: '/v1/messages/x?q=%2e%2e/admin' },
  ];

  for (const c of ALLOWED) {
    it(`sends and audits exactly the wire path for ${c.label}`, T, async () => {
      const upstream = await okUpstream();
      const cred = await onceCredential();

      const res = await broker(upstream).request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: c.path });

      assert.equal(res.status, 200);
      assert.equal(upstream.requests.length, 1);
      assert.equal(upstream.requests[0]?.url, c.wire);
      const allow = audits.find((e) => e.kind === 'allow');
      assert.equal(allow?.path, c.wire.split('?')[0], 'the audited path must be the path that was sent');
    });
  }

  // The prefix is serialised like the wire path; before that, a declared
  // prefix with a space, a non-ASCII character or a brace refused every
  // request, because the wire only ever carries the percent-encoded form.
  const ENCODED_PREFIXES: Array<{ prefix: string; path: string; wire: string; sibling: string }> = [
    { prefix: '/drive/My Files', path: '/drive/My Files/a.txt', wire: '/drive/My%20Files/a.txt', sibling: '/drive/My Filesystem' },
    { prefix: '/v1/über', path: '/v1/über/x', wire: '/v1/%C3%BCber/x', sibling: '/v1/überall' },
    { prefix: '/api/{tenant}', path: '/api/{tenant}/users', wire: '/api/%7Btenant%7D/users', sibling: '/api/{tenant}x' },
  ];

  for (const c of ENCODED_PREFIXES) {
    it(`a declared prefix ${JSON.stringify(c.prefix)} allows its own wire path`, T, async () => {
      const upstream = await okUpstream();
      const cred = await onceCredential('api.example.com', [c.prefix]);

      const res = await broker(upstream).request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: c.path });

      assert.equal(res.status, 200);
      assert.equal(upstream.requests[0]?.url, c.wire);
      assert.equal(audits.find((e) => e.kind === 'allow')?.path, c.wire);
    });

    it(`a declared prefix ${JSON.stringify(c.prefix)} still refuses a sibling and a traversal`, T, async () => {
      const upstream = await okUpstream();
      const cred = await onceCredential('api.example.com', [c.prefix]);

      for (const path of [c.sibling, `${c.prefix}/%2e%2e/%2e%2e/admin`]) {
        await assert.rejects(
          broker(upstream).request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path }),
          (err: unknown) => err instanceof BrokerDenialError && err.reason === 'path-not-allowed',
          path,
        );
      }
      assert.equal(upstream.requests.length, 0);
      assert.ok(await store.activeGrant(cred.id, ALICE, new Date()), 'the once grant must still be active');
    });
  }

  for (const host of ['api.example.com:99999', 'op@api.example.com', 'api.example.com/v1']) {
    it(`denies a declared host that is not a plain host[:port] (${host}) before the once grant is consumed`, T, async () => {
      const upstream = await okUpstream();
      const cred = await onceCredential(host);

      await assert.rejects(
        broker(upstream).request(cred.id, ALICE, { host, method: 'GET', path: '/v1/messages' }),
        (err: unknown) => err instanceof BrokerDenialError && err.reason === 'invalid-broker-declaration',
      );

      assert.equal(upstream.requests.length, 0);
      assert.ok(await store.activeGrant(cred.id, ALICE, new Date()), 'the once grant must still be active');
      assert.deepEqual(
        audits.map((e) => [e.kind, e.reason]),
        [['deny', 'invalid-broker-declaration']],
      );
    });
  }
});
