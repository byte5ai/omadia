import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import {
  NetForbiddenError,
  NetRateLimitError,
  type NetAccessor,
  type NetConnectOptions,
} from '@omadia/plugin-api';

/**
 * Per-plugin raw-TCP egress accessor — the line-protocol sibling of
 * `httpAccessor`. Enforces:
 *   - An allow-list of concrete `{ host, port }` targets, resolved by the
 *     caller from the plugin's manifest (`permissions.network.outbound_tcp`)
 *     against its operator config. `connect` permits ONLY an exact host+port
 *     match — case-insensitive host, numeric port.
 *   - A per-minute rolling connection budget (token bucket), mirroring the
 *     HTTP accessor's 60/min default.
 *
 * Why exact-match against operator config rather than a static manifest
 * hostname list (as `httpAccessor` uses): a generic mail plugin cannot know
 * the SMTP host at authoring time — the operator enters it at install. Pinning
 * egress to exactly that value keeps internal relays (private IPs) reachable
 * without the SSRF surface a free-form raw-socket API would open.
 *
 * Returned to the caller seam as `undefined` when the resolved allow-list is
 * empty (no `outbound_tcp` declared, or its config refs are unset) — in that
 * case `ctx.net` is left unset, exactly like `ctx.http`.
 */

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** Hard ceiling on how long we wait for the socket to come up. SMTP servers
 *  answer in well under a second on the happy path; a stuck connect must not
 *  pin a tool handler open indefinitely. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Ceiling on simultaneously-open sockets per plugin — a backstop against a
 *  plugin holding many long-lived connections (slow-loris-style resource hold).
 *  SMTP sessions are short, so a handful is plenty. */
const DEFAULT_MAX_CONCURRENT = 8;

/**
 * Egress addresses we refuse even though the design otherwise permits private
 * IPs (operator-chosen internal relays are legitimate). The cloud-metadata
 * service lives on the IPv4 link-local block `169.254.0.0/16` (the well-known
 * `169.254.169.254`); nothing legitimately runs SMTP/IMAP there, and reaching
 * it is a classic SSRF pivot. We also block IPv6 link-local (`fe80::/10`) and
 * IPv4-mapped forms of the same. Loopback and RFC-1918 ranges stay reachable —
 * an operator may well run a relay on localhost or an internal subnet.
 */
function isBlockedEgressIp(ip: string): boolean {
  const v = ip.toLowerCase();
  // IPv4 link-local (covers 169.254.169.254 metadata), incl. v4-mapped IPv6.
  const v4 = v.startsWith('::ffff:') ? v.slice('::ffff:'.length) : v;
  if (/^169\.254\./.test(v4)) return true;
  // IPv6 link-local fe80::/10 → fe80..febf.
  if (/^fe[89ab][0-9a-f]:/.test(v)) return true;
  return false;
}

export interface NetTarget {
  readonly host: string;
  readonly port: number;
}

export function createNetAccessor(opts: {
  agentId: string;
  /** Concrete, already-config-resolved targets the plugin may reach. */
  allowed: readonly NetTarget[];
  /** Override the default 60 connections/min cap. Tests only. */
  rateLimitPerMinute?: number;
  /** Override the per-connection timeout. Tests only. */
  connectTimeoutMs?: number;
  /** Override the max simultaneously-open sockets. Tests only. */
  maxConcurrent?: number;
  /** Test seam — inject socket factories so a unit test need not bind a port. */
  connectFns?: {
    net: typeof netConnect;
    tls: typeof tlsConnect;
  };
  /** Test seam — inject the DNS resolver so a unit test need not hit real DNS. */
  lookupFn?: (host: string) => Promise<string>;
}): NetAccessor {
  const { agentId, allowed } = opts;
  const limit = opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const openNet = opts.connectFns?.net ?? netConnect;
  const openTls = opts.connectFns?.tls ?? tlsConnect;
  const resolveHost =
    opts.lookupFn ?? (async (host: string) => (await dnsLookup(host)).address);

  // Normalise the allow-list once: lower-cased host, integer port.
  const allowSet = new Set(
    allowed.map((t) => `${t.host.trim().toLowerCase()}:${t.port}`),
  );

  const bucket = new TokenBucket(limit, 60_000);
  let openCount = 0;

  return {
    async connect(options: NetConnectOptions): Promise<Socket> {
      const host = options.host.trim().toLowerCase();
      const port = Number(options.port);
      const target = `${host}:${port}`;

      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(`ctx.net: invalid port '${String(options.port)}'`);
      }
      if (!allowSet.has(target)) {
        throw new NetForbiddenError(agentId, target);
      }
      if (openCount >= maxConcurrent) {
        throw new NetRateLimitError(agentId);
      }
      if (!bucket.tryConsume()) {
        throw new NetRateLimitError(agentId);
      }

      // Resolve the hostname ONCE and dial the resolved IP literal. This closes
      // the gap between the (string) allow-list check and the OS dial: the IP we
      // classify is exactly the IP we connect to, so a DNS rebind between the
      // two cannot slip a different address through (mirrors the http path's
      // guarded dispatcher). The original hostname is kept as the TLS SNI /
      // servername so certificate validation still matches.
      const dialHost = options.host.trim();
      let address: string;
      if (isIP(dialHost) !== 0) {
        address = dialHost;
      } else {
        try {
          address = await resolveHost(dialHost);
        } catch {
          throw new Error(`ctx.net: could not resolve host '${dialHost}'`);
        }
      }
      if (isBlockedEgressIp(address)) {
        // Link-local / cloud-metadata target — never a legitimate mail server.
        throw new NetForbiddenError(agentId, `${target} (resolves to ${address})`);
      }

      openCount += 1;
      let settled = false;
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const servername = options.servername ?? dialHost;
          const socket = options.tls
            ? openTls({ host: address, port, servername })
            : openNet({ host: address, port });

          const release = (): void => {
            if (!settled) {
              settled = true;
              openCount -= 1;
            }
          };
          const onReady = (): void => {
            cleanup();
            socket.setTimeout(0); // hand a clean, un-timered socket to the caller
            // Decrement the open counter when the socket finally closes, so the
            // concurrency cap tracks live sockets rather than connect attempts.
            socket.once('close', release);
            resolve(socket);
          };
          const onError = (err: Error): void => {
            cleanup();
            release();
            socket.destroy();
            reject(err);
          };
          const onTimeout = (): void => {
            cleanup();
            release();
            socket.destroy();
            reject(new Error(`ctx.net: connection to '${target}' timed out`));
          };
          const cleanup = (): void => {
            socket.removeListener('error', onError);
            socket.removeListener('timeout', onTimeout);
            socket.removeListener('connect', onReady);
            socket.removeListener('secureConnect', onReady);
          };

          socket.setTimeout(connectTimeoutMs);
          socket.once('error', onError);
          socket.once('timeout', onTimeout);
          // tls sockets fire 'secureConnect' once the handshake completes; plain
          // sockets fire 'connect'. We listen for the relevant one.
          socket.once(options.tls ? 'secureConnect' : 'connect', onReady);
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          openCount -= 1;
        }
        throw err;
      }
    },
  };
}

/** Simple rolling-window token bucket — copied from httpAccessor to keep the
 *  two egress paths independent (a flood on one must not starve the other). */
class TokenBucket {
  private count = 0;
  private windowStart = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}

  tryConsume(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.count = 0;
      this.windowStart = now;
    }
    if (this.count >= this.capacity) return false;
    this.count++;
    return true;
  }
}
