/**
 * #778 S3a — `CredentialBroker` against a REAL local HTTP upstream.
 *
 * The stub-fetch suite (`credentialBroker.test.ts`) proves the decision
 * logic; it cannot prove what happens on the wire. Every case here was a
 * leak or a hang on the pre-S3a broker: an echoing upstream handed the
 * secret straight back, a 302 carried an `X-Api-Key` to another host, a
 * trickling upstream held the call forever, a large body was buffered whole,
 * a lowercase `authorization` joined the injected one, and a thrown fetch
 * error for a query-param credential carried the secret-bearing URL.
 *
 * Servers bind `127.0.0.1` explicitly (the listen(0) v4/v6 flake). The
 * broker always addresses `https://api.example.com`; `routeTo` rewrites that
 * to the local server and otherwise uses the real global fetch, so redirect,
 * abort and streaming behaviour are undici's own.
 */

import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  InMemoryCredentialStore,
  makePrincipal,
  type Credential,
  type CredentialInjectionScheme,
  type EncryptedSecretMaterial,
  type Principal,
} from '@omadia/channel-sdk';

import {
  BrokerDenialError,
  CredentialBroker,
  type BrokerAuditEvent,
  type BrokerFetch,
  type CredentialBrokerDeps,
} from '../src/credentials/broker.js';
import { getBrokerMetrics, resetBrokerMetrics } from '../src/credentials/brokerMetrics.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const DECLARED_ORIGIN = 'https://api.example.com';
// Space, slash and plus make every encoding of it distinct from the raw form.
const SECRET = 'sk live/secret+value 42';
const BASIC_SECRET = 'svc-user:p@ss word/secret+42';
const MIB = 1024 * 1024;
const T = { timeout: 5000 };

function seal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function unseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

function encodingsOf(secret: string): string[] {
  const enc = encodeURIComponent(secret);
  return [secret, Buffer.from(secret, 'utf8').toString('base64'), enc, enc.replace(/%20/g, '+'), enc.toLowerCase()];
}

interface Upstream {
  readonly base: string;
  readonly port: number;
  readonly requests: IncomingMessage[];
  close(): Promise<void>;
}

const openServers: Server[] = [];

async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Upstream> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function routeTo(base: string): BrokerFetch {
  return (url, init) =>
    globalThis.fetch(url.replace(DECLARED_ORIGIN, base), init) as unknown as ReturnType<BrokerFetch>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('#778 S3a CredentialBroker egress against a real upstream', () => {
  let store: InMemoryCredentialStore;
  let audits: BrokerAuditEvent[];

  beforeEach(() => {
    resetBrokerMetrics();
    store = new InMemoryCredentialStore(seal, unseal);
    audits = [];
  });

  afterEach(async () => {
    await Promise.all(
      openServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function credential(
    scheme: CredentialInjectionScheme,
    secret = SECRET,
    injectionKey?: string,
  ): Promise<Credential> {
    const cred = await store.createCredential({
      name: `svc-${Math.random().toString(36).slice(2)}`,
      kind: 'service',
      secret,
      createdBy: 'op',
      broker: {
        host: 'api.example.com',
        injectionScheme: scheme,
        ...(injectionKey ? { injectionKey } : {}),
        allowedMethods: ['GET', 'POST'],
        pathPrefixes: ['/v1'],
      },
    });
    await store.createGrant({ credentialId: cred.id, principal: ALICE, mode: 'standing', purpose: 't', grantedBy: 'op' });
    return cred;
  }

  function broker(fetchImpl: BrokerFetch, extra: Partial<CredentialBrokerDeps> = {}): CredentialBroker {
    return new CredentialBroker({ store, unseal, fetchImpl, onAudit: (e) => audits.push(e), ...extra });
  }

  const ECHO_CASES: Array<{ scheme: CredentialInjectionScheme; secret: string; key?: string; extra: string[] }> = [
    { scheme: 'bearer', secret: SECRET, extra: [] },
    { scheme: 'header', secret: SECRET, key: 'X-Api-Key', extra: [] },
    { scheme: 'query-param', secret: SECRET, key: 'api_key', extra: [] },
    { scheme: 'basic-password', secret: BASIC_SECRET, extra: encodingsOf('p@ss word/secret+42') },
  ];

  for (const c of ECHO_CASES) {
    it(`scrubs an echoing upstream in every encoding (${c.scheme})`, T, async () => {
      const upstream = await startUpstream((req, res) => {
        const echo = {
          url: req.url,
          headers: req.headers,
          reflected: encodingsOf(c.secret),
          password: c.scheme === 'basic-password' ? c.secret.split(':')[1] : undefined,
        };
        res.setHeader('x-echo-auth', String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''));
        res.setHeader('x-echo-url', String(req.url));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(echo));
      });
      const cred = await credential(c.scheme, c.secret, c.key);

      const res = await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
        host: 'api.example.com',
        method: 'GET',
        path: '/v1/anything?x=1',
      });

      assert.equal(res.status, 200);
      const serialized = JSON.stringify(res);
      for (const form of [...encodingsOf(c.secret), ...c.extra]) {
        assert.ok(!serialized.includes(form), `leaked form ${JSON.stringify(form)} in ${serialized}`);
      }
      assert.ok(res.body.includes('[REDACTED]'));
      const echoHeader = c.scheme === 'query-param' ? 'x-echo-url' : 'x-echo-auth';
      assert.ok(res.headers[echoHeader]?.includes('[REDACTED]'), `${echoHeader} not scrubbed`);
    });
  }

  it('does not follow a 302 to another host, and scrubs the Location', T, async () => {
    const elsewhere = await startUpstream((_req, res) => res.end('should never be reached'));
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${elsewhere.base}/steal?api_key=${encodeURIComponent(SECRET)}`);
      res.end();
    });
    const cred = await credential('header', SECRET, 'X-Api-Key');

    const res = await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/redirect',
    });

    assert.equal(res.status, 302);
    assert.equal(elsewhere.requests.length, 0, 'the redirect target must never be contacted');
    assert.ok(res.headers.location?.startsWith(elsewhere.base));
    assert.ok(!JSON.stringify(res).includes(encodeURIComponent(SECRET)));
    assert.ok(res.headers.location?.includes('[REDACTED]'));
  });

  it('aborts an upstream that sends headers and then trickles forever', T, async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('a');
      const timer = setInterval(() => res.write('a'), 50);
      res.on('close', () => clearInterval(timer));
    });
    const cred = await credential('bearer');
    const started = Date.now();

    await assert.rejects(
      broker(routeTo(upstream.base), { timeoutMs: 200 }).request(cred.id, ALICE, {
        host: 'api.example.com',
        method: 'GET',
        path: '/v1/slow',
      }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'upstream-timeout',
    );
    assert.ok(Date.now() - started < 2000);
    const m = getBrokerMetrics();
    assert.equal(m.byReason['upstream-timeout'], 1);
    assert.equal(m.allowed, 0);
    assert.equal(m.requests, m.allowed + m.denied);
  });

  it('aborts an upstream that never sends headers', T, async () => {
    const upstream = await startUpstream(() => undefined);
    const cred = await credential('bearer');
    await assert.rejects(
      broker(routeTo(upstream.base), { timeoutMs: 200 }).request(cred.id, ALICE, {
        host: 'api.example.com',
        method: 'GET',
        path: '/v1/hang',
      }),
      (err: unknown) => err instanceof BrokerDenialError && err.reason === 'upstream-timeout',
    );
  });

  it('caps a 50 MB body without buffering it', T, async () => {
    const total = 50 * MIB;
    const chunk = Buffer.alloc(64 * 1024, 'a');
    let written = 0;
    let serverDone!: () => void;
    const closed = new Promise<void>((resolve) => {
      serverDone = resolve;
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let stopped = false;
      res.on('close', () => {
        stopped = true;
        serverDone();
      });
      const pump = (): void => {
        while (!stopped && written < total) {
          written += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        if (!stopped) res.end();
      };
      pump();
    });
    const cred = await credential('bearer');

    const res = await broker(routeTo(upstream.base), { maxResponseBytes: MIB }).request(cred.id, ALICE, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/big',
    });
    await closed;

    assert.equal(res.truncated, true);
    assert.ok(Buffer.byteLength(res.body, 'utf8') <= MIB);
    assert.ok(written < 16 * MIB, `server pushed ${String(written)} bytes — the body was drained, not cancelled`);
  });

  for (const c of [
    { scheme: 'bearer' as const, key: undefined, injected: 'authorization', forged: 'authorization' },
    { scheme: 'header' as const, key: 'X-Api-Key', injected: 'x-api-key', forged: 'x-api-key' },
  ]) {
    it(`a caller '${c.forged}' cannot duplicate the injected header, and ambient headers are dropped (${c.scheme})`, T, async () => {
      const upstream = await startUpstream((_req, res) => res.end('{}'));
      const cred = await credential(c.scheme, SECRET, c.key);

      await broker(routeTo(upstream.base)).request(cred.id, ALICE, {
        host: 'api.example.com',
        method: 'GET',
        path: '/v1/x',
        headers: {
          [c.forged]: 'Bearer forged',
          Cookie: 'session=stolen',
          Host: 'evil.example',
          'Proxy-Authorization': 'Basic Zm9vOmJhcg==',
          'X-HTTP-Method-Override': 'DELETE',
          'Accept-Encoding': 'compress',
          Accept: 'application/json',
        },
      });

      const seen = upstream.requests[0];
      assert.ok(seen);
      const values: string[] = [];
      for (let i = 0; i < seen.rawHeaders.length; i += 2) {
        if (seen.rawHeaders[i]?.toLowerCase() === c.injected) values.push(seen.rawHeaders[i + 1] ?? '');
      }
      const expected = c.scheme === 'bearer' ? `Bearer ${SECRET}` : SECRET;
      assert.deepEqual(values, [expected]);
      assert.equal(seen.headers.cookie, undefined);
      assert.equal(seen.headers['proxy-authorization'], undefined);
      assert.equal(seen.headers['x-http-method-override'], undefined);
      assert.notEqual(seen.headers.host, 'evil.example');
      assert.ok(!String(seen.headers['accept-encoding'] ?? '').includes('compress'));
      assert.equal(seen.headers.accept, 'application/json');

      const allow = audits.find((e) => e.kind === 'allow');
      assert.deepEqual(
        [...(allow?.droppedHeaderNames ?? [])].sort(),
        [c.forged, 'cookie', 'host', 'proxy-authorization', 'x-http-method-override', 'accept-encoding'].sort(),
      );
      const auditJson = JSON.stringify(audits);
      for (const value of ['forged', 'stolen', 'evil.example', 'Zm9vOmJhcg', 'DELETE', SECRET]) {
        assert.ok(!auditJson.includes(value), `audit carried a header value: ${value}`);
      }
    });
  }

  it('an unreachable upstream denies as upstream-unreachable without the secret-bearing URL', T, async () => {
    const closedPort = await startUpstream(() => undefined);
    await closedPort.close();
    const cred = await credential('query-param', SECRET, 'api_key');

    const err = await broker(routeTo(closedPort.base))
      .request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' })
      .then(
        () => assert.fail('expected a denial'),
        (e: unknown) => e,
      );

    assertSanitizedDispatchError(err);
  });

  it('a fetch error whose message and cause carry the URL is not propagated', T, async () => {
    const cred = await credential('query-param', SECRET, 'api_key');
    const throwing: BrokerFetch = (url) => {
      throw new Error(`failed ${url}`, { cause: { url } });
    };

    const err = await broker(throwing)
      .request(cred.id, ALICE, { host: 'api.example.com', method: 'GET', path: '/v1/x' })
      .then(
        () => assert.fail('expected a denial'),
        (e: unknown) => e,
      );

    assertSanitizedDispatchError(err);
  });

  function assertSanitizedDispatchError(err: unknown): void {
    assert.ok(err instanceof BrokerDenialError);
    assert.equal(err.reason, 'upstream-unreachable');
    assert.equal(err.cause, undefined);
    for (const text of [err.message, err.stack ?? '', inspect(err, { depth: 10 })]) {
      for (const form of encodingsOf(SECRET)) assert.ok(!text.includes(form), `error leaked ${form}`);
    }
    const deny = audits.find((e) => e.kind === 'deny');
    assert.equal(deny?.reason, 'upstream-unreachable');
    assert.ok(!JSON.stringify(audits).includes(encodeURIComponent(SECRET)));
    const m = getBrokerMetrics();
    assert.equal(m.requests, 1);
    assert.equal(m.requests, m.allowed + m.denied);
    assert.equal(m.byReason['upstream-unreachable'], 1);
  }
});
