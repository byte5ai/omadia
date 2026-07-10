/**
 * Epic #470 W1 — egress-proxy socket layer, driven over REAL sockets (lesson (g):
 * a fake that models the API incompletely hides bugs). A real `net` echo server
 * stands in for an upstream TLS endpoint (CONNECT tunnel), a real `http` server
 * for absolute-form plain HTTP, and the proxy under test is the real
 * `createProxy` — the only seams are the DNS resolver (so a test can pin a name to
 * loopback or to an internal IP for the rebinding case) and the event client (a
 * capturing collaborator; the real client's flush is covered in
 * `egressPolicy.test.mjs`).
 *
 * Proven here:
 *   - default-deny: a non-allowlisted CONNECT is refused WITHOUT a DNS lookup
 *     (the resolver spy is never called) → a job cannot exfiltrate over DNS;
 *   - an allowlisted/internal destination tunnels end-to-end and logs allow+close;
 *   - rebinding: an allowlisted name resolving to an internal IP is refused;
 *   - bad proxy auth → 407; a disallowed port → 403 with no lookup;
 *   - the bearer-authed control plane registers/removes a job's allowlist and the
 *     change takes effect on the very next connection with no restart;
 *   - no event ever carries a URL path, a header, a credential, or the proxy token.
 */

import { strict as assert } from 'node:assert';
import { connect as netConnect, createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';

import { JobRegistry } from '../src/egressPolicy.mjs';
import { createProxy } from '../src/proxy.mjs';

const DAEMON_TOKEN = 'control-plane-token-000000000000000000';
const PROXY_TOKEN = 'job-proxy-token-abcdefghijklmnop';
const JOB_ID = 'job-e2e-1';

/** Keys no egress event may ever contain — the audit-log leak floor (spec §6). */
const FORBIDDEN_EVENT_KEYS = ['url', 'path', 'headers', 'header', 'body', 'authorization', 'proxyAuthorization', 'credential', 'token', 'proxyToken'];

/** Start a TCP echo server (stands in for an upstream TLS endpoint). */
function startTcpEcho() {
  const server = createTcpServer((socket) => socket.pipe(socket));
  return listen(server).then((port) => ({ port, close: () => closeServer(server) }));
}

/** Start an HTTP server that echoes the request path + a marker body. */
function startHttpUpstream() {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
    res.end(`upstream:${req.url}`);
  });
  return listen(server).then((port) => ({ port, close: () => closeServer(server) }));
}

/** @param {import('node:net').Server | import('node:http').Server} server */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(/** @type {any} */ (server.address()).port)));
}
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

/**
 * Boot a real proxy with capturing event sink + a resolver seam.
 * @param {{ internalHost?: string, internalPort?: number, jobs?: Array<{ jobId: string, allowlist: string[], proxyToken: string, ttlSec?: number }>, resolveMap?: Record<string, Array<{ address: string, family?: number }>> }} opts
 */
async function startProxy(opts = {}) {
  const events = [];
  const resolveCalls = [];
  const registry = new JobRegistry();
  for (const j of opts.jobs ?? []) {
    registry.register(j.jobId, { allowlist: j.allowlist, proxyToken: j.proxyToken, ttlSec: j.ttlSec ?? 180 });
  }
  const eventClient = { record: (e) => events.push(e), flush: async () => {}, stop: () => {} };
  const resolve = async (host) => {
    resolveCalls.push(host);
    return opts.resolveMap?.[host] ?? [{ address: '127.0.0.1', family: 4 }];
  };
  const proxy = createProxy({
    registry,
    tokens: [DAEMON_TOKEN],
    eventClient,
    internalHost: opts.internalHost,
    internalPort: opts.internalPort,
    resolve,
    logger: { warn() {} },
    limits: { connectMs: 2000, idleMs: 2000, absoluteMs: 5000 },
  });
  const dataPort = await listen(proxy.dataServer);
  const controlPort = await listen(proxy.controlServer);
  return {
    dataPort,
    controlPort,
    events,
    resolveCalls,
    registry,
    proxy,
    async close() {
      await closeServer(proxy.dataServer);
      await closeServer(proxy.controlServer);
    },
  };
}

/** Basic proxy-auth header value for a job. */
function basicAuth(jobId = JOB_ID, token = PROXY_TOKEN) {
  return `Basic ${Buffer.from(`${jobId}:${token}`).toString('base64')}`;
}

/**
 * Send a raw CONNECT through the proxy and resolve once the status line is parsed.
 * @returns {Promise<{ statusCode: number, socket: import('node:net').Socket, buffered: Buffer }>}
 */
function sendConnect(dataPort, authority, authHeader) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port: dataPort });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      const headerText = buf.subarray(0, idx).toString('utf8');
      const statusCode = Number(/^HTTP\/1\.1 (\d+)/.exec(headerText)?.[1] ?? 0);
      resolve({ statusCode, socket, buffered: buf.subarray(idx + 4) });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    let head = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
    if (authHeader) head += `Proxy-Authorization: ${authHeader}\r\n`;
    head += '\r\n';
    socket.write(head);
  });
}

/** Wait for the next `data` chunk on a socket. */
function nextChunk(socket) {
  return new Promise((resolve) => socket.once('data', (c) => resolve(c)));
}

/** Poll until pred() is true or timeout. */
async function waitFor(pred, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Assert an event never leaks a URL/header/credential/token. */
function assertEventSafe(event, proxyToken = PROXY_TOKEN) {
  for (const k of Object.keys(event)) {
    assert.ok(!FORBIDDEN_EVENT_KEYS.includes(k), `event leaked forbidden key ${k}`);
  }
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes(proxyToken), 'event serialized the proxy token');
  assert.ok(!serialized.includes('Basic '), 'event serialized an auth header');
}

/** Do an absolute-form plain-HTTP GET through the proxy. */
function proxyGet(dataPort, absoluteUrl, authHeader) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: dataPort, method: 'GET', path: absoluteUrl, headers: authHeader ? { 'proxy-authorization': authHeader } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------

describe('egress proxy — CONNECT default-deny + DNS-exfil defence', () => {
  it('refuses a non-allowlisted host WITHOUT resolving it (no DNS exfil)', async () => {
    const p = await startProxy({ jobs: [{ jobId: JOB_ID, allowlist: ['good.test'], proxyToken: PROXY_TOKEN }] });
    try {
      const { statusCode, socket } = await sendConnect(p.dataPort, 'notallowed.test:443', basicAuth());
      socket.destroy();
      assert.equal(statusCode, 403);
      // The name never reached the resolver — the whole point of the DNS-exfil defence.
      assert.deepEqual(p.resolveCalls, []);
      await waitFor(() => p.events.some((e) => e.decision === 'deny'));
      const deny = p.events.find((e) => e.decision === 'deny');
      assert.equal(deny.reason, 'not_allowlisted');
      assert.equal(deny.host, 'notallowed.test');
      assert.equal(deny.jobId, JOB_ID);
      assert.equal(deny.resolvedIp, null);
      assertEventSafe(deny);
    } finally {
      await p.close();
    }
  });

  it('refuses a disallowed port with no lookup', async () => {
    const p = await startProxy({ jobs: [{ jobId: JOB_ID, allowlist: ['good.test'], proxyToken: PROXY_TOKEN }] });
    try {
      const { statusCode, socket } = await sendConnect(p.dataPort, 'good.test:22', basicAuth());
      socket.destroy();
      assert.equal(statusCode, 403);
      assert.deepEqual(p.resolveCalls, []);
      await waitFor(() => p.events.some((e) => e.reason === 'port_not_allowed'));
    } finally {
      await p.close();
    }
  });

  it('answers 407 when proxy auth is missing or wrong', async () => {
    const p = await startProxy({ jobs: [{ jobId: JOB_ID, allowlist: ['good.test'], proxyToken: PROXY_TOKEN }] });
    try {
      const none = await sendConnect(p.dataPort, 'good.test:443', null);
      none.socket.destroy();
      assert.equal(none.statusCode, 407);
      const wrong = await sendConnect(p.dataPort, 'good.test:443', basicAuth(JOB_ID, 'nope'));
      wrong.socket.destroy();
      assert.equal(wrong.statusCode, 407);
      assert.deepEqual(p.resolveCalls, []);
    } finally {
      await p.close();
    }
  });
});

describe('egress proxy — rebinding defence', () => {
  it('refuses an allowlisted name that resolves to an internal IP', async () => {
    const p = await startProxy({
      jobs: [{ jobId: JOB_ID, allowlist: ['rebind.test'], proxyToken: PROXY_TOKEN }],
      resolveMap: { 'rebind.test': [{ address: '10.0.0.5', family: 4 }] },
    });
    try {
      const { statusCode, socket } = await sendConnect(p.dataPort, 'rebind.test:443', basicAuth());
      socket.destroy();
      assert.equal(statusCode, 403);
      // The name WAS resolved (it passed the allowlist), then the resolved IP was refused.
      assert.deepEqual(p.resolveCalls, ['rebind.test']);
      await waitFor(() => p.events.some((e) => e.reason === 'internal_ip'));
      assertEventSafe(p.events.find((e) => e.reason === 'internal_ip'));
    } finally {
      await p.close();
    }
  });
});

describe('egress proxy — end-to-end tunnel through the vetted IP', () => {
  it('tunnels bytes to an allowed destination and logs allow + close', async () => {
    const upstream = await startTcpEcho();
    // Reach it via the single internal destination (its loopback address is
    // legitimately internal, so allowInternal skips the rebind check — the same
    // path the middleware LLM proxy is reached on). Resolver pins to loopback.
    const p = await startProxy({
      internalHost: 'mw.internal',
      internalPort: upstream.port,
      jobs: [{ jobId: JOB_ID, allowlist: [], proxyToken: PROXY_TOKEN }],
      resolveMap: { 'mw.internal': [{ address: '127.0.0.1', family: 4 }] },
    });
    try {
      const { statusCode, socket } = await sendConnect(p.dataPort, `mw.internal:${upstream.port}`, basicAuth());
      assert.equal(statusCode, 200);
      socket.write('ping-through-tunnel');
      const echoed = await nextChunk(socket);
      assert.equal(echoed.toString('utf8'), 'ping-through-tunnel');
      socket.destroy();
      await waitFor(() => p.events.some((e) => e.decision === 'allow') && p.events.some((e) => e.decision === 'close'));
      const allow = p.events.find((e) => e.decision === 'allow');
      assert.equal(allow.resolvedIp, '127.0.0.1');
      assert.equal(allow.host, 'mw.internal');
      const close = p.events.find((e) => e.decision === 'close');
      assert.ok(close.bytesOut >= 'ping-through-tunnel'.length);
      assert.ok(close.durationMs >= 0);
      assertEventSafe(allow);
      assertEventSafe(close);
    } finally {
      await p.close();
      await upstream.close();
    }
  });
});

describe('egress proxy — absolute-form plain HTTP forward', () => {
  it('forwards a GET to the pinned IP and relays the response', async () => {
    const upstream = await startHttpUpstream();
    const p = await startProxy({
      internalHost: 'mw.internal',
      internalPort: upstream.port,
      jobs: [{ jobId: JOB_ID, allowlist: [], proxyToken: PROXY_TOKEN }],
      resolveMap: { 'mw.internal': [{ address: '127.0.0.1', family: 4 }] },
    });
    try {
      const res = await proxyGet(p.dataPort, `http://mw.internal:${upstream.port}/hello`, basicAuth());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, 'upstream:/hello');
      await waitFor(() => p.events.some((e) => e.decision === 'allow'));
      const allow = p.events.find((e) => e.decision === 'allow');
      assert.equal(allow.verb, 'GET');
      assertEventSafe(allow);
    } finally {
      await p.close();
      await upstream.close();
    }
  });

  it('denies a non-allowlisted plain-HTTP host with no lookup', async () => {
    const p = await startProxy({ jobs: [{ jobId: JOB_ID, allowlist: ['good.test'], proxyToken: PROXY_TOKEN }] });
    try {
      const res = await proxyGet(p.dataPort, 'http://evil.test/steal', basicAuth());
      assert.equal(res.statusCode, 403);
      assert.deepEqual(p.resolveCalls, []);
    } finally {
      await p.close();
    }
  });
});

describe('egress proxy — control plane (daemon-token, per-job allowlist push)', () => {
  it('rejects an unauthenticated control request', async () => {
    const p = await startProxy();
    try {
      const res = await controlPut(p.controlPort, JOB_ID, { allowlist: ['a.test'], proxyToken: PROXY_TOKEN, ttlSec: 60 }, 'wrong');
      assert.equal(res.statusCode, 401);
    } finally {
      await p.close();
    }
  });

  it('registers an allowlist that takes effect on the next connection, then deletes it', async () => {
    const p = await startProxy();
    try {
      // Before registration: the job is unknown → 407.
      const before = await sendConnect(p.dataPort, 'later.test:443', basicAuth());
      before.socket.destroy();
      assert.equal(before.statusCode, 407);

      // Register via the control plane (as the daemon would).
      const put = await controlPut(p.controlPort, JOB_ID, { allowlist: ['later.test'], proxyToken: PROXY_TOKEN, ttlSec: 60 }, DAEMON_TOKEN);
      assert.equal(put.statusCode, 200);
      assert.equal(put.body.registered, true);
      assert.equal(p.registry.get(JOB_ID)?.proxyToken, PROXY_TOKEN);

      // Now the same host is allowed — no restart (acceptance: takes effect next job).
      const after = await sendConnect(p.dataPort, 'later.test:443', basicAuth());
      after.socket.destroy();
      assert.notEqual(after.statusCode, 407);

      // Delete removes it.
      const del = await controlDelete(p.controlPort, JOB_ID, DAEMON_TOKEN);
      assert.equal(del.statusCode, 200);
      assert.equal(p.registry.get(JOB_ID), null);
    } finally {
      await p.close();
    }
  });

  it('rejects a registration whose allowlist carries an IP literal', async () => {
    const p = await startProxy();
    try {
      const res = await controlPut(p.controlPort, JOB_ID, { allowlist: ['169.254.169.254'], proxyToken: PROXY_TOKEN, ttlSec: 60 }, DAEMON_TOKEN);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.message, /IP literal/);
    } finally {
      await p.close();
    }
  });
});

/** PUT /jobs/:id on the control plane. */
function controlPut(controlPort, jobId, body, token) {
  return controlRequest(controlPort, 'PUT', `/jobs/${jobId}`, token, body);
}
function controlDelete(controlPort, jobId, token) {
  return controlRequest(controlPort, 'DELETE', `/jobs/${jobId}`, token);
}
function controlRequest(controlPort, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: controlPort,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
