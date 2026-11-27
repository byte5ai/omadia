import type { PluginConnectionVerdict } from '@omadia/plugin-api';
import { fetch as undiciFetch } from 'undici';

/**
 * #1984 / ADR-0200 — the adapter sends raw audio and its API key only to a
 * host its manifest declares: `api.openai.com`, plus the hosts the operator
 * listed in `allowed_hosts` (`$config.allowed_hosts` in
 * `permissions.network.outbound`). A Base URL or realtime URL on any other
 * host is refused at activation, so a custom endpoint is an explicit,
 * visible allow-list entry.
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

/** The kernel waits 5 s; give up before that. */
const PROBE_TIMEOUT_MS = 4_000;

const INCONCLUSIVE: PluginConnectionVerdict = { status: 'inconclusive' };

/** `<base>/v1/models`, whether the Base URL carries `/v1` or not. */
function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/models`;
}

/**
 * #1974 — the kernel-run connection probe (#1453). `GET /v1/models` with the
 * key costs nothing and answers 401 for a wrong key:
 *  - 401, or a 403 whose body names authentication ⇒ `rejected`
 *  - 2xx                                            ⇒ `connected`
 *  - anything else                                  ⇒ `inconclusive`
 * Never throws.
 */
export async function probeOpenAiKey(
  baseUrl: string,
  apiKey: string,
): Promise<PluginConnectionVerdict> {
  try {
    const response = await undiciFetch(modelsUrl(baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (response.ok) return { status: 'connected', title: 'Verbunden' };
    const body = (await response.text().catch(() => '')).toLowerCase();
    if (response.status === 401) return rejected('http_401');
    const saysAuth =
      body.includes('unauthenticated') ||
      body.includes('authentication') ||
      body.includes('invalid_token') ||
      body.includes('invalid api key');
    return response.status === 403 && saysAuth ? rejected('http_403_auth') : INCONCLUSIVE;
  } catch {
    return INCONCLUSIVE;
  }
}

function rejected(cause: 'http_401' | 'http_403_auth'): PluginConnectionVerdict {
  return {
    status: 'rejected',
    cause,
    title: 'API-Key abgelehnt',
    detail: 'Der Endpoint hat den API-Key abgelehnt — neuen Key im Setup-Formular eintragen.',
  };
}
