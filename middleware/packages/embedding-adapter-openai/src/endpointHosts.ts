/**
 * #1984 / ADR-0200 — the adapter sends texts and its API key only to a host
 * its manifest declares: `api.openai.com`, plus the hosts the operator listed
 * in `allowed_hosts` (`$config.allowed_hosts` in
 * `permissions.network.outbound`). A Base URL on any other host is refused at
 * activation, so a custom endpoint is an explicit, visible allow-list entry.
 *
 * Same rule as `@omadia/transcription-adapter-openai` (`endpointCheck.ts`);
 * the adapters are separate packages and share no runtime code.
 */
export const DEFAULT_DECLARED_HOST = 'api.openai.com';

/** Hosts of the `allowed_hosts` field: comma/space separated, hostnames or URLs. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!entry.includes('://')) return entry.toLowerCase();
      try {
        return new URL(entry).hostname.toLowerCase();
      } catch {
        return entry.toLowerCase();
      }
    });
}

/** The host of `url` when it is not declared, or undefined when it is. */
export function undeclaredHost(url: string, allowedHosts: readonly string[]): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  const declared = new Set([DEFAULT_DECLARED_HOST, ...allowedHosts]);
  return declared.has(host) ? undefined : host;
}
