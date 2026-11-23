// @ts-check
/**
 * Spec 2042 — the canvas WebSocket through the web-ui front.
 *
 * `/.well-known/omadia-ui` on this front advertises `wss://<this host>/omadia-ui/canvas`:
 * the canvas socket authenticates with the session cookie, and that cookie
 * belongs to the host the person signed in on (this one, through
 * `/bot-api/*`). A socket to the middleware's own host would carry no
 * cookie. Next's route handlers cannot upgrade a connection, and its own
 * `upgrade` listener leaves an unknown path hanging, so this module takes the
 * upgrade of exactly that path before Next sees it and relays it to the
 * middleware (`MIDDLEWARE_URL`), cookies included. Every other upgrade stays
 * Next's.
 *
 * Plain JavaScript on purpose: it runs next to the standalone `server.js`,
 * which has no TypeScript at runtime (`omadia-server.mjs` installs it).
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** The canvas socket's path on both the front and the middleware. */
export const CANVAS_WS_PATH = '/omadia-ui/canvas';

/** How long the middleware may take to answer the upgrade. */
export const UPSTREAM_UPGRADE_TIMEOUT_MS = 15_000;

/** Never relayed: this hop's own connection management (RFC 9110 §7.6.1),
 *  `host` (the upstream's own) and the scheme, which this hop declares. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'x-forwarded-proto',
]);

/**
 * Whether a request URL is the canvas socket (query allowed, nothing below it).
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isCanvasUpgrade(url) {
  if (!url) return false;
  const path = url.split('?')[0];
  return path === CANVAS_WS_PATH;
}

/**
 * The headers sent upstream: the client's, minus this hop's own, with the
 * declared scheme (`WEB_UI_PUBLIC_SCHEME`, like `/bot-api/*`) so a client
 * cannot choose it.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {'http' | 'https'} scheme
 * @returns {Record<string, string | string[]>}
 */
export function upstreamHeaders(headers, scheme) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(key)) continue;
    out[key] = value;
  }
  out['x-forwarded-proto'] = scheme;
  if (typeof headers.host === 'string' && out['x-forwarded-host'] === undefined) {
    out['x-forwarded-host'] = headers.host;
  }
  return out;
}

/**
 * The head of a raw HTTP/1.1 response.
 * @param {number} status
 * @param {string} message
 * @param {readonly string[]} rawHeaders name/value pairs, as `IncomingMessage.rawHeaders`
 * @returns {string}
 */
function responseHead(status, message, rawHeaders) {
  let head = `HTTP/1.1 ${String(status)} ${message}\r\n`;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  return `${head}\r\n`;
}

/**
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} message
 */
function refuse(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${String(status)} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Relay one upgrade to the middleware. A `101` joins the two sockets; any
 * other answer (`401` without a session, `404`, `503`) reaches the client as
 * it came, so a refusal is visible instead of a hang.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{ middlewareUrl: string, scheme: 'http' | 'https', log?: (line: string) => void, timeoutMs?: number }} options
 */
export function proxyCanvasUpgrade(req, socket, head, options) {
  const log = options.log ?? ((line) => console.warn(line));
  let target;
  try {
    target = new URL(req.url ?? CANVAS_WS_PATH, options.middlewareUrl);
  } catch {
    log(`[canvas-ws-proxy] MIDDLEWARE_URL is not a URL; refusing the upgrade`);
    refuse(socket, 502, 'Bad Gateway');
    return;
  }
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = request(target, {
    method: req.method ?? 'GET',
    headers: upstreamHeaders(req.headers, options.scheme),
  });
  upstream.setTimeout(options.timeoutMs ?? UPSTREAM_UPGRADE_TIMEOUT_MS, () => {
    log(`[canvas-ws-proxy] the middleware did not answer the upgrade in time`);
    upstream.destroy();
    refuse(socket, 504, 'Gateway Timeout');
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());

  upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    if (socket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    socket.write(responseHead(res.statusCode ?? 101, res.statusMessage ?? 'Switching Protocols', res.rawHeaders));
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstream.on('response', (res) => {
    upstream.setTimeout(0);
    // Node hands the body over de-chunked, and this connection ends with it.
    /** @type {string[]} */
    const raw = [];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
      const name = res.rawHeaders[i] ?? '';
      if (['connection', 'transfer-encoding'].includes(name.toLowerCase())) continue;
      raw.push(name, res.rawHeaders[i + 1] ?? '');
    }
    socket.write(responseHead(res.statusCode ?? 502, res.statusMessage ?? '', [...raw, 'Connection', 'close']));
    res.pipe(socket);
  });

  upstream.on('error', (err) => {
    log(`[canvas-ws-proxy] upgrade relay failed: ${err.message}`);
    refuse(socket, 502, 'Bad Gateway');
  });
  upstream.end();
}

/**
 * Take the canvas upgrades of `server` before any other `upgrade` listener
 * (Next's) sees them. Returns the server.
 * @template {import('node:http').Server} S
 * @param {S} server
 * @param {() => { middlewareUrl: string, scheme: 'http' | 'https' }} resolve read per upgrade, so a runtime env change applies
 * @returns {S}
 */
export function attachCanvasWsProxy(server, resolve) {
  const emit = server.emit;
  /** @type {typeof server.emit} */
  const relayingEmit = function (event, ...args) {
    if (event === 'upgrade') {
      const [req, socket, head] = /** @type {[import('node:http').IncomingMessage, import('node:stream').Duplex, Buffer]} */ (args);
      if (isCanvasUpgrade(req.url)) {
        proxyCanvasUpgrade(req, socket, head, resolve());
        return true;
      }
    }
    return emit.call(this, event, ...args);
  };
  server.emit = relayingEmit;
  return server;
}

/**
 * The relay's settings from the environment, the same ones `/bot-api/*` uses.
 * @returns {{ middlewareUrl: string, scheme: 'http' | 'https' }}
 */
export function canvasWsProxyEnv() {
  return {
    middlewareUrl: process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979',
    scheme: process.env['WEB_UI_PUBLIC_SCHEME']?.trim().toLowerCase() === 'https' ? 'https' : 'http',
  };
}
