/**
 * #778 S3a — the request-side edge cases of `CredentialBroker`, against a
 * REAL local upstream and undici's own fetch.
 *
 * Each case is one where what the broker believed it sent and what undici
 * actually did diverged:
 *
 * - undici trims leading/trailing HTTP whitespace from header values, so a
 *   secret stored with a copy-paste newline or space went out trimmed and an
 *   echo of the trimmed value matched no scrub form.
 * - the WHATWG URL parser encodes `'` as `%27`, which `encodeURIComponent`
 *   leaves alone, so a query-param secret containing `'` went out in a form
 *   the scrub never built.
 * - undici refuses a header value outside `\t`, 0x20–0x7E, 0x80–0xFF, and a
 *   GET/HEAD with a body, locally, before any byte leaves. The broker had
 *   already consumed the `once` grant and audited `allow`, then reported
 *   `upstream-unreachable` for what was a caller error.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  InMemoryCredentialStore,
  makePrincipal,
  type Credential,
  type CredentialInjectionScheme,
  type Principal,
} from '@omadia/channel-sdk';

import { BrokerDenialError, CredentialBroker, type BrokerAuditEvent, type BrokerFetch } from '../src/credentials/broker.js';
import { getBrokerMetrics, resetBrokerMetrics } from '../src/credentials/brokerMetrics.js';

import { closeAllUpstreams, rawHeaderValues, routeTo, seal, startUpstream, unseal } from './_helpers/brokerUpstream.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const TRIMMED = 'sk-live-abcdefgh';
const T = { timeout: 5000 };

describe('#778 S3a CredentialBroker request edge cases against a real upstream', () => {
  let store: InMemoryCredentialStore;
  let audits: BrokerAuditEvent[];

  beforeEach(() => {
    resetBrokerMetrics();
    store = new InMemoryCredentialStore(seal, unseal);
    audits = [];
  });

  afterEach(closeAllUpstreams);

  async function credential(
    scheme: CredentialInjectionScheme,
    secret: string,
    opts: { injectionKey?: string; mode?: 'standing' | 'once' } = {},
  ): Promise<Credential> {
    const cred = await store.createCredential({
      name: `svc-${Math.random().toString(36).slice(2)}`,
      kind: 'service',
      secret,
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: scheme,
        ...(opts.injectionKey ? { injectionKey: opts.injectionKey } : {}),
        allowedMethods: ['GET', 'HEAD', 'POST'],
        pathPrefixes: ['/v1'],
      },
    });
    const mode = opts.mode ?? 'standing';
    await store.createGrant({
      credentialId: cred.id,
      principal: ALICE,
      mode,
      purpose: 't',
      grantedBy: 'op',
      ...(mode === 'once' ? { expiresAt: new Date(Date.now() + 60_000) } : {}),
    });
    return cred;
  }

  function broker(fetchImpl: BrokerFetch): CredentialBroker {
    return new CredentialBroker({ store, unseal, fetchImpl, onAudit: (e) => audits.push(e) });
  }

  /** Echo what the upstream decoded, the way a debugging endpoint would. */
  function echoAuth(): Promise<{ base: string }> {
    return startUpstream((req, res) => {
      const auth = String(req.headers.authorization ?? '');
      const basic = auth.startsWith('Basic ')
        ? Buffer.from(auth.slice(6), 'base64').toString('utf8').trim().split(':')[1]
        : undefined;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ auth, key: req.headers['x-api-key'], url: req.url, password: basic }));
    });
  }

  const PADDED_CASES: Array<{ scheme: CredentialInjectionScheme; secret: string; key?: string; leak: string }> = [
    { scheme: 'bearer', secret: `${TRIMMED}\n`, leak: TRIMMED },
    { scheme: 'bearer', secret: `\t${TRIMMED}`, leak: TRIMMED },
    { scheme: 'header', secret: `${TRIMMED} `, key: 'X-Api-Key', leak: TRIMMED },
    { scheme: 'basic-password', secret: 'svc-user:pa55word-secret\r\n', leak: 'pa55word-secret' },
  ];

  for (const c of PADDED_CASES) {
    it(`scrubs the wire (trimmed) form of a whitespace-padded secret (${c.scheme}, ${JSON.stringify(c.secret)})`, T, async () => {
      const upstream = await echoAuth();
      const cred = await credential(c.scheme, c.secret, { injectionKey: c.key });

      const res = await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
        host: 'api.example.com',
        method: 'GET',
        path: '/v1/anything',
      });

      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(res).includes(c.leak), `trimmed secret echoed back: ${res.body}`);
      assert.ok(res.body.includes('[REDACTED]'));
    });
  }

  it("scrubs the WHATWG-URL wire form of a query-param secret (' becomes %27)", T, async () => {
    const secret = "abc'defgh!ij";
    const upstream = await echoAuth();
    const cred = await credential('query-param', secret, { injectionKey: 'api_key' });

    const res = await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/x',
    });

    const echoed = JSON.parse(res.body) as { url: string };
    assert.equal(echoed.url, '/v1/x?api_key=[REDACTED]');
    assert.ok(!res.body.includes('defgh'));
  });

  it('drops caller header values undici would refuse locally, so the request still leaves', T, async () => {
    const upstream = await startUpstream((_req, res) => res.end('{}'));
    const cred = await credential('bearer', TRIMMED, { mode: 'once' });

    const res = await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/x',
      headers: {
        'User-Agent': 'bot \u{1F916}',
        Accept: 'a\u0001b',
        'Accept-Language': 'de\u007f',
        'If-None-Match': 'x\r\ny',
        'Content-Language': 'café',
        'Idempotency-Key': 'key\twith-tab',
      },
    });

    assert.equal(res.status, 200);
    const seen = upstream.requests[0];
    assert.ok(seen, 'the request must reach the upstream');
    assert.ok(!rawHeaderValues(seen, 'user-agent').some((v) => v.startsWith('bot')));
    assert.deepEqual(rawHeaderValues(seen, 'if-none-match'), []);
    assert.deepEqual(rawHeaderValues(seen, 'content-language'), ['café']);
    assert.deepEqual(rawHeaderValues(seen, 'idempotency-key'), ['key\twith-tab']);

    const allow = audits.find((e) => e.kind === 'allow');
    assert.deepEqual(
      [...(allow?.droppedHeaderNames ?? [])].sort(),
      ['accept', 'accept-language', 'if-none-match', 'user-agent'],
    );
    assert.ok(!JSON.stringify(audits).includes('bot'), 'audit carried a header value');
    assert.equal(getBrokerMetrics().allowed, 1);
  });

  it('an injectionKey that is also allow-listed puts exactly one value, the secret, on the wire', T, async () => {
    const upstream = await startUpstream((_req, res) => res.end('{}'));
    const cred = await credential('header', TRIMMED, { injectionKey: 'User-Agent' });

    await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/x',
      headers: { 'user-agent': 'forged-agent' },
    });

    const seen = upstream.requests[0];
    assert.ok(seen);
    assert.deepEqual(rawHeaderValues(seen, 'user-agent'), [TRIMMED]);
    assert.deepEqual(audits.find((e) => e.kind === 'allow')?.droppedHeaderNames, ['user-agent']);
  });

  for (const method of ['GET', 'get', 'HEAD']) {
    for (const body of ['', 'payload']) {
      it(`refuses a ${method} with body ${JSON.stringify(body)} before the once grant is consumed`, T, async () => {
        const upstream = await startUpstream((_req, res) => res.end('{}'));
        const cred = await credential('bearer', TRIMMED, { mode: 'once' });

        await assert.rejects(
          broker(routeTo(upstream.base)).request(cred.id, ALICE, { host: 'api.example.com', method, path: '/v1/x', body }),
          (err: unknown) => err instanceof BrokerDenialError && err.reason === 'invalid-request',
        );

        assert.equal(upstream.requests.length, 0);
        assert.ok(await store.activeGrant(cred.id, ALICE, new Date()), 'the once grant must still be active');
        assert.deepEqual(
          audits.map((e) => [e.kind, e.reason]),
          [['deny', 'invalid-request']],
        );
        const m = getBrokerMetrics();
        assert.equal(m.byReason['invalid-request'], 1);
        assert.equal(m.byReason['upstream-unreachable'], 0);
      });
    }
  }

  it('a POST with a body still goes out (control for the GET/HEAD refusal)', T, async () => {
    let received = '';
    const upstream = await startUpstream((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        received += chunk;
      });
      req.on('end', () => res.end('{}'));
    });
    const cred = await credential('bearer', TRIMMED, { mode: 'once' });

    const res = await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'POST',
      path: '/v1/x',
      body: 'payload',
    });

    assert.equal(res.status, 200);
    assert.equal(received, 'payload');
  });

  for (const bad of [
    { timeoutMs: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 2 ** 31 },
    { timeoutMs: 2 ** 32 },
    { maxResponseBytes: Number.NaN },
    { maxResponseBytes: -1 },
    { maxResponseBytes: Number.POSITIVE_INFINITY },
  ]) {
    it(`refuses a broker configured with ${JSON.stringify(bad, (_k, v: unknown) => (typeof v === 'number' ? String(v) : v))}`, () => {
      assert.throws(() => new CredentialBroker({ store, unseal, ...bad }), RangeError);
    });
  }
});
