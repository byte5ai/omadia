/**
 * #2338 / ADR-0299 — is the Kroki renderer a reader inside the instance?
 *
 * `render_diagram` sends the whole diagram source, chart data included, to
 * `kroki_base_url`. A renderer the operator runs as part of the instance may
 * see everything the turn may show (owner decision 2026-11-27); then the tool
 * declares `side_effects: none` and the discretion integration egress lets it
 * run in any turn. A public or third-party endpoint stays checked like a write,
 * so a turn with a label from another conversation is refused there.
 *
 * Internal by its address, no flag needed: loopback, private IPv4 ranges,
 * IPv6 unique-local (Fly's private network `fdaa::/16`), and host names that
 * only resolve inside a private network (`.internal`, `.flycast`, `.local`,
 * `.svc`, a single label such as the compose service `kroki`). Any other host
 * is internal only when the operator says so (`kroki_internal`). The public
 * `kroki.io` service is never internal.
 */

const PUBLIC_KROKI_HOSTS: readonly string[] = ['kroki.io'];

const PRIVATE_NAME_SUFFIXES: readonly string[] = ['.internal', '.flycast', '.local', '.svc', '.cluster.local'];

function isPublicKroki(host: string): boolean {
  return PUBLIC_KROKI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isPrivateIPv6(host: string): boolean {
  const ip = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!ip.includes(':')) return false;
  // Loopback and unique-local fc00::/7 (fc.. and fd..).
  return ip === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(ip);
}

/** Whether `baseUrl` points at a renderer inside the instance. */
export function isInternalKrokiEndpoint(baseUrl: string, declaredInternal: boolean): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.length === 0 || isPublicKroki(host)) return false;
  if (host === 'localhost' || isPrivateIPv4(host) || isPrivateIPv6(host)) return true;
  if (PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  return declaredInternal;
}

/** A boolean setup value as the config accessor hands it over (`true` or `'true'`). */
export function configFlag(raw: unknown): boolean {
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}
