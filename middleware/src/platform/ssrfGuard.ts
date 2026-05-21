import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

/**
 * SSRF guard for #91 — protects audit/scanner plugins running in
 * `public-web` mode, where `ctx.http` may reach arbitrary user-supplied
 * hosts.
 *
 * A hostname allow-check alone is not enough: a public hostname can resolve
 * to a private address (DNS rebinding). The defence has two layers:
 *
 *   1. A literal-IP pre-check in the accessor — `http://10.0.0.5/` never
 *      triggers DNS, so the accessor rejects non-public literal IPs up front.
 *   2. `createGuardedAgent()` — an undici dispatcher whose custom `lookup`
 *      resolves the hostname, rejects the connection if ANY resolved address
 *      is non-public, and hands undici exactly the validated address. undici
 *      then connects to that address, so a rebind between validation and
 *      connect cannot happen.
 */

export class HttpBlockedAddressError extends Error {
  constructor(agentId: string, host: string, reason: string) {
    super(`plugin '${agentId}' is not permitted to reach '${host}' — ${reason}`);
    this.name = 'HttpBlockedAddressError';
  }
}

/**
 * True iff `ip` is a literal, globally-routable public address. Loopback,
 * private, link-local, ULA, CGNAT, multicast, reserved and unspecified
 * ranges return false. A string that is not a literal IP returns false.
 */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const v4 = parseIpv4(ip);
    return v4 !== null && isPublicIpv4(v4);
  }
  if (kind === 6) {
    const bytes = parseIpv6(ip);
    return bytes !== null && isPublicIpv6(bytes);
  }
  return false;
}

function isPublicIpv4(o: readonly [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 0) return false; // 0.0.0.0/8 — "this network"
  if (a === 10) return false; // 10.0.0.0/8 — private
  if (a === 127) return false; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 — link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 — private
  if (a === 192 && b === 0 && o[2] === 0) return false; // 192.0.0.0/24 — IETF protocol
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 — CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 — benchmarking
  if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return true;
}

function isPublicIpv6(b: Uint8Array): boolean {
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  if (isAllZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isPublicIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
  }
  if (isAllZero(b, 0, 16)) return false; // :: — unspecified
  if (isAllZero(b, 0, 15) && b[15] === 1) return false; // ::1 — loopback
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false; // fe80::/10 — link-local
  if ((b[0]! & 0xfe) === 0xfc) return false; // fc00::/7 — unique-local
  if (b[0] === 0xff) return false; // ff00::/8 — multicast
  return true;
}

function isAllZero(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (b[i] !== 0) return false;
  }
  return true;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/**
 * Parse a literal IPv6 address into its 16 bytes. Handles `::` compression,
 * an embedded IPv4 tail (`::ffff:1.2.3.4`) and a zone id (`fe80::1%eth0`).
 * Returns null on anything malformed. Callers should pass strings already
 * confirmed as IPv6 by `node:net.isIP`.
 */
function parseIpv6(ip: string): Uint8Array | null {
  const zone = ip.indexOf('%');
  let s = zone >= 0 ? ip.slice(0, zone) : ip;

  // Rewrite an embedded IPv4 tail into two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const rear = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - rear.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...rear];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

/**
 * An undici dispatcher whose connect step refuses any hostname that resolves
 * to a non-public address. Pass it as the `dispatcher` of a `fetch` call.
 * Used only in `public-web` audit mode — the static-allow-list modes trust
 * the operator/manifest to have named their hosts deliberately.
 */
export function createGuardedAgent(): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) {
            callback(err, '', 0);
            return;
          }
          if (addresses.length === 0) {
            callback(new Error(`no address for '${hostname}'`), '', 0);
            return;
          }
          for (const a of addresses) {
            if (!isPublicIp(a.address)) {
              callback(
                new Error(
                  `SSRF guard: '${hostname}' resolves to non-public address ${a.address}`,
                ),
                '',
                0,
              );
              return;
            }
          }
          if (options.all === true) {
            callback(null, addresses);
          } else {
            callback(null, addresses[0]!.address, addresses[0]!.family);
          }
        });
      },
    },
  });
}
