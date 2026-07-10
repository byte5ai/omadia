/**
 * Epic #470 W1 — forward egress proxy (spec §6). SECOND entrypoint in the daemon
 * package (`proxy.mjs` alongside `daemon.mjs`): one image, two services, so the
 * proxy never shares the daemon's docker credentials.
 *
 * THE PROXY IS THE ONLY PATH FROM A JOB CONTAINER TO THE WORLD. It is
 * default-deny: a CONNECT/HTTP request to a host that is not on the requesting
 * job's server-derived allowlist is refused and reported. Two planes:
 *
 *   data plane  (:3128, on `dev-egress`)  — CONNECT tunnels + absolute-form plain
 *     HTTP from job containers. Proxy-Authorization: Basic <jobId>:<proxyToken>.
 *   control plane (:3129, on `omadia`, bearer-authed) — the daemon PUTs/DELETEs a
 *     job's effective allowlist + one-time proxy token here BEFORE the container
 *     starts. The proxy NEVER takes an allowlist from the job (lesson (d)).
 *
 * The socket-free policy core (registry, decision, rebinding classifier, event
 * client) lives in `egressPolicy.mjs`; this file owns the sockets. Built on node's
 * `http`/`net` so the tests drive it over REAL sockets (lesson (g)).
 *
 * Resolve-once / connect-to-what-you-checked (lessons (a)/(c)): the target is
 * canonicalised once (`parseAuthority`), judged once (`decideRequest`), resolved
 * once AFTER an allow, every returned address classified with netClassify, and the
 * socket pinned to the vetted IP. A non-allowlisted name is refused BEFORE any DNS
 * lookup, so a job cannot exfiltrate over DNS.
 */

import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

import { isAuthorized, parseDaemonTokens } from './auth.mjs';
import {
  DEFAULT_ALLOWED_PORTS,
  JobRegistry,
  canonicalizeHost,
  classifyResolvedAddresses,
  createEventClient,
  decideRequest,
  parseAuthority,
  parseProxyAuthorization,
} from './egressPolicy.mjs';

/** Data-plane port (spec §6). */
export const DEFAULT_DATA_PORT = 3128;
/** Control-plane port (spec §6). */
export const DEFAULT_CONTROL_PORT = 3129;

/** Bounds (spec §6 "Bounded"). A hung upstream must never wedge the proxy. */
const DEFAULTS = Object.freeze({
  maxTunnels: 256,
  idleMs: 60_000,
  absoluteMs: 15 * 60_000,
  connectMs: 10_000,
  maxBodyBytes: 512 * 1024 * 1024,
  pruneIntervalMs: 30_000,
});

/** Hop-by-hop + proxy headers stripped before forwarding an absolute-form HTTP
 *  request upstream (RFC 7230 §6.1 plus the proxy credentials). */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Default DNS resolver: resolve a hostname to EVERY address so the rebinding
 * classifier sees them all. An IP literal is returned as-is (no lookup) — it is
 * still classified downstream, so a CONNECT to a raw internal IP is refused.
 *
 * @param {string} host
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
async function defaultResolve(host) {
  const fam = isIP(host);
  if (fam !== 0) return [{ address: host, family: fam }];
  return dnsLookup(host, { all: true });
}

/**
 * @typedef {object} ProxyDeps
 * @property {JobRegistry} registry
 * @property {readonly string[]} tokens Control-plane daemon bearer tokens.
 * @property {ReturnType<typeof createEventClient>} eventClient
 * @property {string} [internalHost] Canonical middleware host (internal destination rule).
 * @property {number} [internalPort]
 * @property {ReadonlySet<number>} [allowedPorts]
 * @property {(host: string) => Promise<Array<{ address: string, family?: number }>>} [resolve] DNS seam.
 * @property {Partial<typeof DEFAULTS>} [limits]
 * @property {{ warn?: (m: string) => void }} [logger]
 * @property {() => number} [now]
 */

/**
 * Build the data-plane and control-plane servers (not yet listening). Returned so
 * `main` (and the tests) bind ephemeral ports and close them cleanly.
 *
 * @param {ProxyDeps} deps
 */
export function createProxy(deps) {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const allowedPorts = deps.allowedPorts ?? new Set(DEFAULT_ALLOWED_PORTS);
  const resolve = deps.resolve ?? defaultResolve;
  const limits = { ...DEFAULTS, ...(deps.limits ?? {}) };
  const ctx = {
    registry: deps.registry,
    internalHost: deps.internalHost,
    internalPort: deps.internalPort,
    allowedPorts,
  };
  /** Live tunnel count — the concurrency-cap denominator. */
  let activeTunnels = 0;

  /** Record an egress event; fills the safe defaults so every event has one shape.
   *  @param {Partial<import('./egressPolicy.mjs').EgressEvent> & { jobId: string, host: string, port: number, decision: 'allow' | 'deny' | 'close', verb: string }} partial */
  function emit(partial) {
    deps.eventClient.record({
      ts: new Date(now()).toISOString(),
      reason: null,
      resolvedIp: null,
      bytesIn: 0,
      bytesOut: 0,
      durationMs: 0,
      ...partial,
    });
  }

  // ---- data plane --------------------------------------------------------
  const dataServer = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  dataServer.on('connect', (req, socket, head) => {
    void handleConnect(req, socket, head).catch(() => {
      destroySocket(socket);
    });
  });
  // A client that errors before/after the CONNECT upgrade must not throw globally.
  dataServer.on('clientError', (_err, socket) => destroySocket(socket));

  /**
   * CONNECT tunnel: authorise → decide → (only now) resolve → classify → pin →
   * connect to the vetted IP → splice bytes with idle + absolute deadlines.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} clientSocket
   * @param {Buffer} head
   */
  async function handleConnect(req, clientSocket, head) {
    const auth = parseProxyAuthorization(req.headers['proxy-authorization']);
    const target = parseAuthority(req.url, 443);
    if (!target) {
      writeConnectStatus(clientSocket, 400, 'Bad Request');
      clientSocket.end();
      return;
    }
    const { host, port } = target;
    const decision = decideRequest(
      { jobId: auth?.jobId, proxyToken: auth?.proxyToken, host, port },
      ctx,
    );
    const jobId = auth?.jobId ?? 'unknown';
    if (decision.decision === 'deny') {
      emit({ jobId, verb: 'CONNECT', host, port, decision: 'deny', reason: decision.reason });
      if (decision.status === 407) {
        writeConnectStatus(clientSocket, 407, 'Proxy Authentication Required', {
          'Proxy-Authenticate': 'Basic realm="omadia-dev-egress"',
        });
      } else {
        writeConnectStatus(clientSocket, decision.status, 'Forbidden');
      }
      clientSocket.end();
      return;
    }

    // Concurrency cap (before we spend a DNS lookup / socket on it).
    if (activeTunnels >= limits.maxTunnels) {
      writeConnectStatus(clientSocket, 503, 'Service Unavailable');
      clientSocket.end();
      return;
    }

    // Resolve ONLY after the allowlist check — a non-allowlisted name never
    // reaches the resolver (spec §6 / DNS-exfil defence).
    let addresses;
    try {
      addresses = await resolve(host);
    } catch (err) {
      emit({ jobId, verb: 'CONNECT', host, port, decision: 'deny', reason: 'dns_error' });
      logger.warn?.(`[dev-egress-proxy] resolve failed for an allowlisted host: ${err instanceof Error ? err.message : String(err)}`);
      writeConnectStatus(clientSocket, 502, 'Bad Gateway');
      clientSocket.end();
      return;
    }
    const pinned = classifyResolvedAddresses(addresses, { allowInternal: decision.allowInternal });
    if (!pinned.ok) {
      emit({ jobId, verb: 'CONNECT', host, port, decision: 'deny', reason: pinned.reason });
      writeConnectStatus(clientSocket, pinned.reason === 'internal_ip' ? 403 : 502, 'Forbidden');
      clientSocket.end();
      return;
    }
    const pinnedIp = pinned.pinnedIp;

    // Connect to the VETTED IP, never the hostname — no re-resolution can slip a
    // different address in between check and connect (lesson (c)).
    const upstream = netConnect({ host: pinnedIp, port });
    activeTunnels += 1;
    const startedAt = now();
    let torndown = false;
    /** @type {NodeJS.Timeout | undefined} */
    let idleTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let absoluteTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let connectTimer;

    const teardown = () => {
      if (torndown) return;
      torndown = true;
      activeTunnels -= 1;
      if (idleTimer) clearTimeout(idleTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (connectTimer) clearTimeout(connectTimer);
      emit({
        jobId,
        verb: 'CONNECT',
        host,
        port,
        decision: 'close',
        resolvedIp: pinnedIp,
        bytesIn: upstream.bytesRead,
        bytesOut: upstream.bytesWritten,
        durationMs: now() - startedAt,
      });
      if (!upstream.destroyed) upstream.destroy();
      destroySocket(clientSocket);
    };

    // Connection deadline: a hung upstream (accepts the socket, never speaks) must
    // not wedge a tunnel slot. This deadline timer is NOT unref'd (lesson (e)).
    connectTimer = setTimeout(() => {
      writeConnectStatus(clientSocket, 504, 'Gateway Timeout');
      teardown();
    }, limits.connectMs);

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(teardown, limits.idleMs);
    };

    upstream.on('connect', () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      emit({ jobId, verb: 'CONNECT', host, port, decision: 'allow', resolvedIp: pinnedIp });
      writeConnectStatus(clientSocket, 200, 'Connection Established');
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      // Reset the idle deadline on traffic either way; hold a hard absolute cap.
      clientSocket.on('data', armIdle);
      upstream.on('data', armIdle);
      absoluteTimer = setTimeout(teardown, limits.absoluteMs);
      armIdle();
    });

    upstream.on('error', teardown);
    upstream.on('close', teardown);
    clientSocket.on('error', teardown);
    clientSocket.on('close', teardown);
  }

  /**
   * Absolute-form plain HTTP forward (`GET http://host/path`). Same authorise →
   * decide → resolve → classify → pin path, then a bounded forward to the pinned
   * IP. HTTPS never arrives here — it is a CONNECT tunnel.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleHttp(req, res) {
    const auth = parseProxyAuthorization(req.headers['proxy-authorization']);
    // Only absolute-form is a valid forward-proxy request; a relative path is a
    // client that thinks it is talking to an origin server.
    let parsed;
    try {
      parsed = new URL(req.url ?? '');
    } catch {
      sendJson(res, 400, { code: 'proxy.bad_request', message: 'absolute-form URL required' });
      return;
    }
    if (parsed.protocol !== 'http:') {
      sendJson(res, 400, { code: 'proxy.bad_request', message: 'only http absolute-form is forwarded; use CONNECT for https' });
      return;
    }
    const host = canonicalizeHost(parsed.hostname);
    const port = parsed.port ? Number(parsed.port) : 80;
    const decision = decideRequest({ jobId: auth?.jobId, proxyToken: auth?.proxyToken, host, port }, ctx);
    const jobId = auth?.jobId ?? 'unknown';
    if (decision.decision === 'deny') {
      emit({ jobId, verb: req.method ?? 'GET', host, port, decision: 'deny', reason: decision.reason });
      if (decision.status === 407) res.setHeader('proxy-authenticate', 'Basic realm="omadia-dev-egress"');
      sendJson(res, decision.status, { code: `proxy.${decision.reason}`, message: 'egress denied' });
      return;
    }

    let addresses;
    try {
      addresses = await resolve(host);
    } catch {
      emit({ jobId, verb: req.method ?? 'GET', host, port, decision: 'deny', reason: 'dns_error' });
      sendJson(res, 502, { code: 'proxy.dns_error', message: 'upstream resolution failed' });
      return;
    }
    const pinned = classifyResolvedAddresses(addresses, { allowInternal: decision.allowInternal });
    if (!pinned.ok) {
      emit({ jobId, verb: req.method ?? 'GET', host, port, decision: 'deny', reason: pinned.reason });
      sendJson(res, pinned.reason === 'internal_ip' ? 403 : 502, { code: `proxy.${pinned.reason}`, message: 'egress denied' });
      return;
    }
    const pinnedIp = pinned.pinnedIp;

    /** @type {Record<string, string | string[]>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers['host'] = port === 80 ? host : `${host}:${port}`;

    emit({ jobId, verb: req.method ?? 'GET', host, port, decision: 'allow', resolvedIp: pinnedIp });
    const startedAt = now();
    let bytesOut = 0;
    let bytesIn = 0;

    const upstreamReq = httpRequest(
      { host: pinnedIp, port, method: req.method, path: `${parsed.pathname}${parsed.search}`, headers, setHost: false },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, filterResponseHeaders(upstreamRes.headers));
        upstreamRes.on('data', (chunk) => {
          bytesIn += chunk.length;
        });
        upstreamRes.on('end', () => {
          emit({ jobId, verb: req.method ?? 'GET', host, port, decision: 'close', resolvedIp: pinnedIp, bytesIn, bytesOut, durationMs: now() - startedAt });
        });
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.setTimeout(limits.idleMs, () => upstreamReq.destroy(new Error('idle timeout')));
    const absoluteTimer = setTimeout(() => upstreamReq.destroy(new Error('absolute timeout')), limits.absoluteMs);
    const clearAbsolute = () => clearTimeout(absoluteTimer);
    upstreamReq.on('close', clearAbsolute);
    upstreamReq.on('error', () => {
      clearAbsolute();
      if (!res.headersSent) sendJson(res, 502, { code: 'proxy.upstream_error', message: 'upstream request failed' });
      else res.end();
    });
    // Bound the request body so a job cannot stream unbounded data through the proxy.
    req.on('data', (chunk) => {
      bytesOut += chunk.length;
      if (bytesOut > limits.maxBodyBytes) {
        upstreamReq.destroy(new Error('request body cap exceeded'));
        if (!res.headersSent) sendJson(res, 413, { code: 'proxy.body_too_large', message: 'request body exceeds cap' });
      }
    });
    req.pipe(upstreamReq);
  }

  // ---- control plane -----------------------------------------------------
  const controlServer = createServer((req, res) => {
    void handleControl(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { code: 'proxy.internal', message: 'internal error' });
      else res.end();
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleControl(req, res) {
    if (!isAuthorized(req.headers.authorization, deps.tokens)) {
      sendJson(res, 401, { code: 'proxy.unauthorized', message: 'missing or invalid bearer token' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://proxy.local');
    const m = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      sendJson(res, 404, { code: 'proxy.not_found', message: 'no such route' });
      return;
    }
    let jobId;
    try {
      jobId = decodeURIComponent(m[1] ?? '');
    } catch {
      sendJson(res, 400, { code: 'proxy.bad_job_id', message: 'jobId is not valid' });
      return;
    }

    if (req.method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { code: 'proxy.bad_body', message: 'invalid JSON body' });
        return;
      }
      const allowlist = body?.allowlist;
      const proxyToken = body?.proxyToken;
      const ttlSec = body?.ttlSec;
      try {
        const { expiresAt } = deps.registry.register(jobId, { allowlist, proxyToken, ttlSec });
        sendJson(res, 200, { jobId, registered: true, expiresAt: new Date(expiresAt).toISOString() });
      } catch (err) {
        // The middleware already validated the allowlist; a bad entry here is a
        // confused/hostile push — reject loudly, name only the reason.
        sendJson(res, 400, { code: 'proxy.bad_registration', message: err instanceof Error ? err.message : 'invalid registration' });
      }
      return;
    }

    if (req.method === 'DELETE') {
      const deleted = deps.registry.delete(jobId);
      sendJson(res, 200, { jobId, deleted });
      return;
    }

    sendJson(res, 405, { code: 'proxy.method_not_allowed', message: 'PUT or DELETE only' });
  }

  // Self-expiry backstop: prune expired registrations on a timer (unref'd — the
  // servers keep the loop alive) so a dead daemon leaves nothing authorised.
  const pruneTimer = setInterval(() => deps.registry.prune(), limits.pruneIntervalMs);
  pruneTimer.unref?.();
  dataServer.on('close', () => clearInterval(pruneTimer));

  return { dataServer, controlServer, get activeTunnels() { return activeTunnels; } };
}

/** Write a raw HTTP status line to a CONNECT client socket (no res object here).
 *  @param {import('node:stream').Duplex} socket @param {number} code
 *  @param {string} message @param {Record<string, string>} [headers] */
function writeConnectStatus(socket, code, message, headers = {}) {
  if (socket.destroyed || socket.writableEnded) return;
  let head = `HTTP/1.1 ${code} ${message}\r\n`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  try {
    socket.write(head);
  } catch {
    // client already gone — nothing to report.
  }
}

/** Filter hop-by-hop headers out of an upstream response before relaying it.
 *  @param {import('node:http').IncomingHttpHeaders} headers */
function filterResponseHeaders(headers) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding' || lower === 'te' || lower === 'trailer' || lower === 'upgrade') continue;
    out[k] = v;
  }
  return out;
}

/** Destroy a duplex socket defensively. @param {import('node:stream').Duplex} socket */
function destroySocket(socket) {
  try {
    if (!socket.destroyed) socket.destroy();
  } catch {
    // already torn down.
  }
}

/** Read a bounded JSON body from a control-plane request.
 *  @param {import('node:http').IncomingMessage} req @param {number} [maxBytes] */
async function readJsonBody(req, maxBytes = 256 * 1024) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Send a JSON response.
 *  @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Wire the proxy from the environment and start both planes. Data plane binds all
 * interfaces on `dev-egress`; control plane binds the `omadia` interface. Refuses
 * to start without a valid daemon token (control-plane auth) — spec §8 secure
 * defaults.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(env = process.env) {
  const tokens = parseDaemonTokens(env.DEV_RUNNER_DAEMON_TOKEN);
  const internalUrl = env.OMADIA_INTERNAL_API_URL;
  let internalHost;
  let internalPort;
  if (internalUrl) {
    const u = new URL(internalUrl);
    internalHost = canonicalizeHost(u.hostname);
    internalPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  }

  const registry = new JobRegistry();
  // Events go to the middleware's phone-home surface. NOTE (spec §6): the exact
  // route below is NOT built in this unit — the client is defined and wired per
  // instruction; the middleware egress-events surface is a separate deliverable.
  const eventsUrl = internalUrl ? `${internalUrl.replace(/\/+$/, '')}/api/v1/dev/internal/egress-events` : undefined;
  const eventClient = createEventClient({ url: eventsUrl, token: tokens[0] });

  const proxy = createProxy({ registry, tokens, eventClient, internalHost, internalPort });

  const dataPort = env.DEV_EGRESS_DATA_PORT ? Number(env.DEV_EGRESS_DATA_PORT) : DEFAULT_DATA_PORT;
  const controlPort = env.DEV_EGRESS_CONTROL_PORT ? Number(env.DEV_EGRESS_CONTROL_PORT) : DEFAULT_CONTROL_PORT;
  const dataBind = env.DEV_EGRESS_DATA_BIND ?? '0.0.0.0';
  const controlBind = env.DEV_EGRESS_CONTROL_BIND ?? '0.0.0.0';

  await new Promise((resolve) => proxy.dataServer.listen(dataPort, dataBind, () => resolve(undefined)));
  await new Promise((resolve) => proxy.controlServer.listen(controlPort, controlBind, () => resolve(undefined)));
  console.log(`[dev-egress-proxy] data plane on ${dataBind}:${dataPort}, control plane on ${controlBind}:${controlPort}`);
  return proxy;
}

// Run main() only when executed as the entrypoint, so importing this module in a
// test never starts a listening server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[dev-egress-proxy] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
