/**
 * Which client a password sign-in attempt is charged to
 * (`AUTH_LOGIN_CLIENT_ADDRESS`, docs/security-architecture.md §10f).
 *
 * Trust boundary: this never reads `req.ip` / `req.ips`. The app runs with
 * `trust proxy = true`, which makes `req.ip` the LEFT-most `X-Forwarded-For`
 * entry — a value the client writes. A limiter keyed on it is a limiter the
 * caller resets with a header. Same rule as `loopbackOnly.ts` (§10).
 *
 *   socket         the TCP peer (`req.socket.remoteAddress`). Cannot be forged;
 *                  the default. Behind a proxy it is the proxy, so every
 *                  client shares one key.
 *   xff:<n>        the n-th `X-Forwarded-For` entry counted from the RIGHT:
 *                  the address the outermost of n trusted proxies that each
 *                  APPEND to the header saw. Entries further left are
 *                  client-written and never read. Fewer than n entries →
 *                  the socket peer.
 *   header:<name>  a header a trusted edge SETS (overwrites), such as
 *                  `Fly-Client-IP`. Absent → the socket peer.
 *
 * Whatever the policy yields must parse as an IP address (after stripping a
 * port, IPv6 brackets and the `::ffff:` prefix), or the socket peer is used:
 * junk strings can neither mint free keys nor reach a log line. IPv6 clients
 * are keyed by their /64 — one host controls its whole /64, so a per-address
 * key would let it rotate through 2^64 budgets.
 */

import { isIP } from 'node:net';

import type { Request } from 'express';

export type ClientAddressPolicy =
  | { readonly kind: 'socket' }
  | { readonly kind: 'xff'; readonly trustedHops: number }
  | { readonly kind: 'header'; readonly name: string };

/** The key when the socket has no address (an unconnected test socket). */
export const UNKNOWN_CLIENT = 'unknown';

/** Upper bound for `xff:<n>`: more trusted hops than this is a misconfiguration. */
export const MAX_TRUSTED_HOPS = 8;

/** RFC 9110 token characters an operator plausibly uses in a header name. */
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const XFF_RE = /^xff:(\d)$/;
const IPV4_WITH_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_IPV6_RE = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_TAIL_RE = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseClientAddressPolicy(raw: string): ClientAddressPolicy {
  const value = raw.trim();
  if (value === 'socket') return { kind: 'socket' };
  const xff = XFF_RE.exec(value);
  if (xff) {
    const hops = Number(xff[1]);
    if (hops >= 1 && hops <= MAX_TRUSTED_HOPS) return { kind: 'xff', trustedHops: hops };
  }
  if (value.startsWith('header:')) {
    const name = value.slice('header:'.length);
    if (HEADER_NAME_RE.test(name)) return { kind: 'header', name: name.toLowerCase() };
  }
  throw new Error(
    `AUTH_LOGIN_CLIENT_ADDRESS must be socket, xff:<1..${String(MAX_TRUSTED_HOPS)}> or header:<name> (got ${JSON.stringify(raw)})`,
  );
}

/** Boolean form for the zod schema, so a bad value is a config error, not a throw. */
export function isClientAddressPolicy(raw: string): boolean {
  try {
    parseClientAddressPolicy(raw);
    return true;
  } catch {
    return false;
  }
}

/** The policy in its env spelling, for the boot log line. */
export function describeClientAddressPolicy(policy: ClientAddressPolicy): string {
  switch (policy.kind) {
    case 'socket':
      return 'socket';
    case 'xff':
      return `xff:${String(policy.trustedHops)}`;
    case 'header':
      return `header:${policy.name}`;
  }
}

/** The client key for this request under `policy`. Never `req.ip`. */
export function clientAddressFor(
  req: Pick<Request, 'socket' | 'headers'>,
  policy: ClientAddressPolicy,
): string {
  const fallback = clientKeyFromAddress(req.socket.remoteAddress) ?? UNKNOWN_CLIENT;
  switch (policy.kind) {
    case 'socket':
      return fallback;
    case 'xff': {
      const entries = headerValue(req, 'x-forwarded-for')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (entries.length < policy.trustedHops) return fallback;
      return clientKeyFromAddress(entries[entries.length - policy.trustedHops]) ?? fallback;
    }
    case 'header':
      return clientKeyFromAddress(headerValue(req, policy.name)) ?? fallback;
  }
}

function headerValue(req: Pick<Request, 'headers'>, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : '';
}

/** An address as a limiter key: validated IPv4, or the /64 of an IPv6. */
function clientKeyFromAddress(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let address = raw.trim();
  const bracketed = BRACKETED_IPV6_RE.exec(address);
  if (bracketed?.[1] !== undefined) address = bracketed[1];
  const withPort = IPV4_WITH_PORT_RE.exec(address);
  if (withPort?.[1] !== undefined) address = withPort[1];
  if (address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    address = address.slice(7);
  }
  switch (isIP(address)) {
    case 4:
      return address;
    case 6:
      return ipv6Prefix64(address);
    default:
      return null;
  }
}

/** `2001:db8:aa:1::1` → `2001:db8:aa:1::/64`. Input is a valid IPv6 (isIP 6). */
function ipv6Prefix64(address: string): string | null {
  let text = address.split('%')[0]?.toLowerCase() ?? '';
  const v4 = IPV4_TAIL_RE.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, v4.index)}${high}:${low}`;
  }
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length > 1
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8) return null;
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}
