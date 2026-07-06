/**
 * MCP registry catalog client (epic #459 W3, issue #455). Modeled on the
 * plugin `RegistryClient`: injectable fetch, hard timeouts, bounded response
 * size, per-registry graceful degradation. Fetches a registry's server
 * catalog and normalizes entries into the shape the from-registry import
 * route needs.
 *
 * Wire format: primary target is the official MCP registry API
 * (`GET {url}/v0/servers`, entries in server.json shape with `remotes` and
 * `packages`); a plain `{ "servers": [...] }` document at the URL itself is
 * accepted too, so private/static catalogs work without implementing the
 * official API.
 */

export interface McpRegistryConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly authKind: 'none' | 'bearer';
  readonly token: string | null;
}

export interface McpCatalogEntry {
  /** Stable id within the registry (the server's namespaced name). */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: string | null;
  /** Derived connection candidate; null when the entry only ships packages
   *  we cannot translate into a transport (then it is browse-only). */
  readonly transport: 'http' | 'sse' | 'stdio' | null;
  readonly endpoint: string | null;
  readonly license: string | null;
  readonly author: string | null;
  readonly sourceUrl: string | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

export class McpRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpRegistryError';
  }
}

interface CacheSlot {
  readonly fetchedAtMs: number;
  readonly entries: readonly McpCatalogEntry[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Derive author from the namespaced name (`io.github.owner/server`) or the
 *  repository URL — the official registry has no dedicated author field. */
function deriveAuthor(name: string, repoUrl: string | null): string | null {
  const ghName = /^io\.github\.([^/]+)\//.exec(name);
  if (ghName?.[1]) return ghName[1];
  const ghRepo = repoUrl ? /github\.com\/([^/]+)\//.exec(repoUrl) : null;
  return ghRepo?.[1] ?? null;
}

function normalizeEntry(raw: Record<string, unknown>): McpCatalogEntry | null {
  // Official API wraps the server.json under `server`; accept both.
  const server = (raw['server'] ?? raw) as Record<string, unknown>;
  const name = str(server['name']);
  if (!name) return null;
  const repo = server['repository'] as Record<string, unknown> | undefined;
  const repoUrl = str(repo?.['url']);

  let transport: McpCatalogEntry['transport'] = null;
  let endpoint: string | null = null;
  const remotes = Array.isArray(server['remotes']) ? server['remotes'] : [];
  const remote = remotes.find(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object',
  );
  if (remote) {
    const kind = str(remote['type'] ?? remote['transport_type'] ?? remote['transport']);
    const url = str(remote['url']);
    if (url && kind) {
      transport = kind.includes('sse') ? 'sse' : 'http';
      endpoint = url;
    }
  }
  if (!endpoint) {
    const packages = Array.isArray(server['packages']) ? server['packages'] : [];
    const npmPkg = packages.find(
      (p): p is Record<string, unknown> =>
        !!p &&
        typeof p === 'object' &&
        (str((p as Record<string, unknown>)['registry_name'] ?? (p as Record<string, unknown>)['registry_type'] ?? (p as Record<string, unknown>)['registryType']) ?? '').includes('npm'),
    );
    const identifier = npmPkg ? str(npmPkg['name'] ?? npmPkg['identifier']) : null;
    if (identifier) {
      transport = 'stdio';
      endpoint = `npx -y ${identifier}`;
    }
  }

  return {
    id: name,
    name,
    description: str(server['description']),
    version:
      str(server['version']) ??
      str((server['version_detail'] as Record<string, unknown> | undefined)?.['version']),
    transport,
    endpoint,
    license: str(server['license']) ?? str(raw['license']),
    author: deriveAuthor(name, repoUrl),
    sourceUrl: repoUrl ?? str(server['website_url']),
  };
}

export interface McpRegistryClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly log?: (msg: string) => void;
}

export class McpRegistryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly cache = new Map<string, CacheSlot>();

  constructor(deps?: McpRegistryClientDeps) {
    this.fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = deps?.log ?? ((m) => console.log(m));
  }

  /** Fetch (or serve from the 5-minute cache) a registry's full catalog. */
  async catalog(registry: McpRegistryConfig): Promise<readonly McpCatalogEntry[]> {
    const cached = this.cache.get(registry.id);
    if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
      return cached.entries;
    }
    const entries = await this.fetchCatalog(registry);
    this.cache.set(registry.id, { fetchedAtMs: Date.now(), entries });
    return entries;
  }

  /** Case-insensitive substring search over name + description. */
  async search(registry: McpRegistryConfig, q: string): Promise<readonly McpCatalogEntry[]> {
    const entries = await this.catalog(registry);
    const needle = q.trim().toLowerCase();
    if (needle === '') return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        (e.description ?? '').toLowerCase().includes(needle),
    );
  }

  /** Resolve one entry by its catalog id — the from-registry import path. */
  async resolve(registry: McpRegistryConfig, entryId: string): Promise<McpCatalogEntry> {
    const entries = await this.catalog(registry);
    const hit = entries.find((e) => e.id === entryId);
    if (!hit) {
      throw new McpRegistryError(
        'catalog_entry_not_found',
        `entry "${entryId}" not found in registry "${registry.name}"`,
      );
    }
    return hit;
  }

  /** Test seam / operator action: drop the cache for one or all registries. */
  invalidate(registryId?: string): void {
    if (registryId) this.cache.delete(registryId);
    else this.cache.clear();
  }

  private async fetchCatalog(
    registry: McpRegistryConfig,
  ): Promise<readonly McpCatalogEntry[]> {
    const base = registry.url.replace(/\/+$/, '');
    const candidates = [`${base}/v0/servers?limit=100`, base];
    let lastError: McpRegistryError | null = null;
    for (const url of candidates) {
      try {
        const doc = await this.fetchJson(url, registry);
        const rawList = Array.isArray((doc as Record<string, unknown>)['servers'])
          ? ((doc as Record<string, unknown>)['servers'] as unknown[])
          : Array.isArray(doc)
            ? (doc as unknown[])
            : null;
        if (!rawList) {
          lastError = new McpRegistryError('bad_catalog_shape', `no servers array at ${url}`);
          continue;
        }
        const entries = rawList
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map(normalizeEntry)
          .filter((e): e is McpCatalogEntry => e !== null);
        this.log(
          `[mcpRegistry] "${registry.name}": ${String(entries.length)} catalog entries from ${url}`,
        );
        return entries;
      } catch (err) {
        lastError =
          err instanceof McpRegistryError
            ? err
            : new McpRegistryError('fetch_failed', String(err));
      }
    }
    throw lastError ?? new McpRegistryError('fetch_failed', 'no catalog endpoint reachable');
  }

  private async fetchJson(url: string, registry: McpRegistryConfig): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          ...(registry.authKind === 'bearer' && registry.token
            ? { authorization: `Bearer ${registry.token}` }
            : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new McpRegistryError('http_error', `${url} answered ${String(res.status)}`);
      }
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) {
        throw new McpRegistryError('catalog_too_large', `${url} exceeded the size limit`);
      }
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
