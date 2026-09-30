/**
 * Which client a password sign-in attempt is charged to
 * (`AUTH_LOGIN_CLIENT_ADDRESS`, `AUTH_LOGIN_IPV6_PREFIX`,
 * docs/security-architecture.md §10f).
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
 * The result says whether the key is `shared`: the socket peer — the
 * `socket` policy, or the fallback of the other two — is a proxy in every
 * shipped topology (web-ui, the platform edge, loopback on the desktop), so
 * the limiter must not brake it as if it were one client. An address a
 * trusted hop vouched for is one client (or one NAT).
 *
 * Whatever the policy yields must parse as an IP address (after stripping a
 * port, IPv6 brackets and the `::ffff:` prefix), or the socket peer is used:
 * junk strings can neither mint free keys nor reach a log line. IPv6 clients
 * are keyed by a prefix, /64 by default — one host controls its whole /64,
 * so a per-address key would let it rotate through 2^64 budgets.
 */

import { isIP } from 'node:net';

import type { Request } from 'express';

export type ClientAddressPolicy =
  | { readonly kind: 'socket' }
  | { readonly kind: 'xff'; readonly trustedHops: number }
  | { readonly kind: 'header'; readonly name: string };

/** The limiter's view of who is asking. */
export interface ClientAddress {
  /** A validated IPv4 address, an IPv6 prefix (`2001:db8:1:2::/64`) or `unknown`. */
  readonly key: string;
  /** True for the socket peer: a proxy that every client behind it shares. */
  readonly shared: boolean;
}

/** The key when the socket has no address (an unconnected test socket). */
export const UNKNOWN_CLIENT = 'unknown';

/** Upper bound for `xff:<n>`: more trusted hops than this is a misconfiguration. */
export const MAX_TRUSTED_HOPS = 8;

/** `AUTH_LOGIN_IPV6_PREFIX`: IPv6 clients are keyed by this many leading bits. */
export const DEFAULT_IPV6_PREFIX_BITS = 64;
export const MIN_IPV6_PREFIX_BITS = 32;
export const MAX_IPV6_PREFIX_BITS = 64;

/** RFC 9110 token characters an operator plausibly uses in a header name. */
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const XFF_RE = /^xff:(\d)$/;
const IPV4_WITH_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_IPV6_RE = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_TAIL_RE = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const GROUP_BITS = 16;
const IPV6_GROUPS = 8;

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

/** The client this request is charged to under `policy`. Never `req.ip`. */
export function clientAddressFor(
  req: Pick<Request, 'socket' | 'headers'>,
  policy: ClientAddressPolicy,
  ipv6PrefixBits: number = DEFAULT_IPV6_PREFIX_BITS,
): ClientAddress {
  const bits = clampPrefixBits(ipv6PrefixBits);
  const peer: ClientAddress = {
    key: clientKeyFromAddress(req.socket.remoteAddress, bits) ?? UNKNOWN_CLIENT,
    shared: true,
  };
  const vouched = (raw: string | undefined): ClientAddress => {
    const key = clientKeyFromAddress(raw, bits);
    return key === null ? peer : { key, shared: false };
  };
  switch (policy.kind) {
    case 'socket':
      return peer;
    case 'xff': {
      const entries = headerValue(req, 'x-forwarded-for')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (entries.length < policy.trustedHops) return peer;
      return vouched(entries[entries.length - policy.trustedHops]);
    }
    case 'header':
      return vouched(headerValue(req, policy.name));
  }
}

/** The config schema enforces the range; this keeps a direct caller inside it too. */
function clampPrefixBits(bits: number): number {
  if (!Number.isFinite(bits)) return DEFAULT_IPV6_PREFIX_BITS;
  return Math.min(MAX_IPV6_PREFIX_BITS, Math.max(MIN_IPV6_PREFIX_BITS, Math.trunc(bits)));
}

function headerValue(req: Pick<Request, 'headers'>, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : '';
}

/** An address as a limiter key: validated IPv4, or the prefix of an IPv6. */
function clientKeyFromAddress(raw: string | undefined, ipv6PrefixBits: number): string | null {
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
      return ipv6Prefix(address, ipv6PrefixBits);
    default:
      return null;
  }
}

/**
 * `2001:db8:aa:1ff::1` at 64 → `2001:db8:aa:1ff::/64`, at 56 →
 * `2001:db8:aa:100::/56`. Input is a valid IPv6 (isIP 6); bits in 32..64.
 */
function ipv6Prefix(address: string, bits: number): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const kept = groups.slice(0, Math.ceil(bits / GROUP_BITS)).map((group, i) => {
    const bitsLeft = bits - i * GROUP_BITS;
    const mask = bitsLeft >= GROUP_BITS ? 0xffff : (0xffff << (GROUP_BITS - bitsLeft)) & 0xffff;
    return (group & mask).toString(16);
  });
  return `${kept.join(':')}::/${String(bits)}`;
}

/** The eight 16-bit groups of a valid IPv6 address (zone dropped, IPv4 tail folded in). */
function ipv6Groups(address: string): number[] | null {
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
      ? [...head, ...Array<string>(IPV6_GROUPS - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== IPV6_GROUPS) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}
