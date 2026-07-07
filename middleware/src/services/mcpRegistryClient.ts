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
  /** Catalog-API dialect (issue #455 W7). Defaults to 'generic'. */
  readonly kind?: 'official' | 'smithery' | 'generic';
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
    // Catalog entries are UNTRUSTED (codex fold): only well-formed https
    // remotes become endpoints — a catalog must not be able to point the
    // middleware at plain-http, custom schemes, or metadata addresses.
    if (url && kind) {
      try {
        const parsed = new URL(url);
        // https only, and the host must clear the untrusted-remote block —
        // an untrusted catalog must not yield an internal/metadata endpoint.
        if (parsed.protocol === 'https:' && isUntrustedRemoteHostSafe(parsed.hostname)) {
          transport = kind.includes('sse') ? 'sse' : 'http';
          endpoint = url;
        }
      } catch {
        /* malformed remote URL → browse-only entry */
      }
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
    // Strict npm-name grammar (codex fold): refuses flags ("-e …"), paths,
    // and shell metacharacters. Non-conforming entries stay browse-only.
    if (identifier && NPM_NAME_RE.test(identifier) && identifier.length <= 214) {
      transport = 'stdio';
      // `--` separator: the identifier can never be read as an npx option.
      endpoint = `npx -y -- ${identifier}`;
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
    sourceUrl: safeHttpUrl(repoUrl ?? str(server['website_url'])),
  };
}

/**
 * Smithery list entry (issue #455 W7). The listing has no connection URL, so
 * the endpoint is resolved per-server at connect time (`resolveSmithery`). We
 * mark it http-connectable when the registry reports it as remote/deployed;
 * the actual deploymentUrl is fetched lazily. `qualifiedName` is the id.
 */
/** Official registry lists every version of a server; keep one row per name,
 *  preferring the entry flagged latest, else the first seen (issue #455 W7). */
function dedupOfficialToLatest(
  rawList: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const server = (raw['server'] ?? raw) as Record<string, unknown>;
    const name = str(server['name']);
    if (!name) continue;
    const meta = (raw['_meta'] ?? {}) as Record<string, unknown>;
    const isLatest =
      meta['isLatest'] === true ||
      (meta['io.modelcontextprotocol.registry/official'] as Record<string, unknown> | undefined)?.[
        'isLatest'
      ] === true;
    if (isLatest || !byName.has(name)) byName.set(name, raw);
  }
  return [...byName.values()];
}

function normalizeSmitheryEntry(raw: Record<string, unknown>): McpCatalogEntry | null {
  const qualifiedName = str(raw['qualifiedName']);
  if (!qualifiedName) return null;
  const remote = raw['remote'] === true || raw['isDeployed'] === true;
  return {
    id: qualifiedName,
    name: str(raw['displayName']) ?? qualifiedName,
    description: str(raw['description']),
    version: null,
    // Remote Smithery servers are streamable-http; endpoint deferred to connect.
    transport: remote ? 'http' : null,
    endpoint: null,
    license: null,
    author: str(raw['owner']) ?? str(raw['namespace']),
    sourceUrl: safeHttpUrl(str(raw['homepage'])),
  };
}

/** Hostname aliases for cloud-metadata endpoints — refused even before DNS,
 *  since a name can front a link-local address (codex fold). */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

/** Sync host classification, no DNS. Returns a refusal reason or null. */
function classifyHostSync(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
  if (METADATA_HOSTNAMES.has(h)) return `metadata hostname refused: ${h}`;
  // Link-local (covers 169.254.169.254 IMDS) + IPv6 link-local.
  if (/^169\.254\./.test(v4) || /^fe[89ab][0-9a-f]:/.test(h)) {
    return `link-local/metadata address refused: ${h}`;
  }
  return null;
}

/** True for a resolved IP in a range a server-side fetch must never reach. */
function isBlockedResolvedIp(ip: string): boolean {
  const v = ip.toLowerCase();
  const v4 = v.startsWith('::ffff:') ? v.slice('::ffff:'.length) : v;
  // Link-local / IMDS.
  if (/^169\.254\./.test(v4) || /^fe[89ab][0-9a-f]:/.test(v)) return true;
  return false;
}

/** True for a resolved IP an UNTRUSTED (catalog-sourced) endpoint must never
 *  reach — the full internal set, not just link-local. */
function isPrivateResolvedIp(ip: string): boolean {
  const v = ip.toLowerCase();
  const v4 = v.startsWith('::ffff:') ? v.slice('::ffff:'.length) : v;
  if (isBlockedResolvedIp(ip)) return true;
  if (/^127\./.test(v4) || v4 === '::1') return true;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(v4)) return true;
  if (v4 === '0.0.0.0' || /^fc[0-9a-f]|^fd[0-9a-f]/.test(v)) return true; // unspecified + ULA
  return false;
}

/**
 * Validate a catalog-sourced connection endpoint before it is persisted
 * (codex W7 fold): https-only, the literal host must clear the untrusted-remote
 * block, AND the resolved addresses must all be public — so a public-looking
 * hostname that DNS-resolves to internal infrastructure is refused at import,
 * not connected to at discover time. Redirect validation at the MCP client
 * layer is a separate broader item (noted on #463).
 */
async function assertUntrustedEndpointSafe(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new McpRegistryError('mcp_catalog_entry_not_importable', `bad endpoint URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:' || !isUntrustedRemoteHostSafe(parsed.hostname)) {
    throw new McpRegistryError('blocked_host', `endpoint host refused: ${parsed.hostname}`);
  }
  try {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(parsed.hostname, { all: true });
    for (const r of results) {
      if (isPrivateResolvedIp(r.address)) {
        throw new McpRegistryError(
          'blocked_host',
          `endpoint host "${parsed.hostname}" resolves to a private address (${r.address})`,
        );
      }
    }
  } catch (err) {
    if (err instanceof McpRegistryError) throw err;
    // Unresolvable: the connect attempt will fail loudly anyway.
  }
}

/** Accept only http(s) URLs for display/provenance fields; drop anything else
 *  (javascript:, data:, …) so a catalog-controlled string can never become a
 *  live href (codex W7 fold). */
function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Registry URLs are OPERATOR configuration (same trust class as an SMTP relay
 * in `netAccessor.ts`): private/loopback hosts stay reachable because a
 * private registry on the intranet is a legitimate setup. What we refuse is
 * the link-local/cloud-metadata block — a classic SSRF pivot. The check is
 * two-layer (codex fold): the literal host string AND the RESOLVED address, so
 * a hostname or DNS alias that points at link-local is caught too.
 */
async function assertFetchableRegistryUrl(raw: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpRegistryError('invalid_url', `not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpRegistryError('invalid_url', `unsupported protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const syncReason = classifyHostSync(host);
  if (syncReason) throw new McpRegistryError('blocked_host', syncReason);
  // Resolve and re-check: a DNS alias (metadata.google.internal, or an
  // attacker-controlled name resolving to 169.254.x) only shows its true
  // target after resolution.
  try {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(host, { all: true });
    for (const r of results) {
      if (isBlockedResolvedIp(r.address)) {
        throw new McpRegistryError(
          'blocked_host',
          `host "${host}" resolves to a link-local/metadata address (${r.address})`,
        );
      }
    }
  } catch (err) {
    if (err instanceof McpRegistryError) throw err;
    // DNS failure is surfaced by the fetch itself; don't hard-fail here.
  }
}

/**
 * Catalog-provided remote endpoints are UNTRUSTED (a registry we browsed, not
 * operator config). Stricter than the registry URL: loopback, private, and
 * link-local hosts are all refused, so an untrusted catalog cannot point the
 * middleware at internal infrastructure at discover/test-call time. Sync
 * (normalizeEntry is sync) — literal + hostname classes only; the
 * connect-time guard in the runtime layer is the resolved-IP backstop.
 */
function isUntrustedRemoteHostSafe(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (classifyHostSync(h) !== null) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (h.endsWith('.internal') || h.endsWith('.local')) return false;
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
  // Loopback + RFC-1918 + CGNAT literals.
  if (/^127\./.test(v4) || v4 === '::1') return false;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)) return false;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(v4)) return false;
  return true;
}

/** Stream the body up to `cap` bytes; abort with a typed error beyond it. */
async function readTextCapped(res: Response, cap: number, url: string): Promise<string> {
  const lengthHeader = Number(res.headers.get('content-length'));
  if (Number.isFinite(lengthHeader) && lengthHeader > cap) {
    throw new McpRegistryError('catalog_too_large', `${url} exceeded the size limit`);
  }
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > cap) {
      throw new McpRegistryError('catalog_too_large', `${url} exceeded the size limit`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new McpRegistryError('catalog_too_large', `${url} exceeded the size limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** npm package-name grammar (scoped or unscoped). The first char of each
 *  segment must NOT be a hyphen or dot (codex fold): `-y`/`--foo`-shaped
 *  identifiers would be parsed by npx as CLI options, not package names. The
 *  stdio endpoint additionally uses `npx -y -- <identifier>` so the `--`
 *  separator makes the identifier un-optionable even if the grammar ever
 *  loosened. */
const NPM_NAME_RE = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;

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

  /** Resolve one entry by its catalog id — the from-registry import path.
   *  For Smithery the listing carries no endpoint, so this does the second
   *  fetch to the per-server detail endpoint to obtain the deploymentUrl. */
  async resolve(registry: McpRegistryConfig, entryId: string): Promise<McpCatalogEntry> {
    const entries = await this.catalog(registry);
    const hit = entries.find((e) => e.id === entryId);
    if (!hit) {
      throw new McpRegistryError(
        'catalog_entry_not_found',
        `entry "${entryId}" not found in registry "${registry.name}"`,
      );
    }
    const resolved =
      registry.kind === 'smithery' && hit.endpoint === null && hit.transport !== null
        ? await this.resolveSmitheryEndpoint(registry, hit)
        : hit;
    // Resolved-IP SSRF check before the endpoint is handed to the import route
    // (codex W7 fold): covers every marketplace import path uniformly, so a
    // public-looking host that resolves to internal infrastructure is refused
    // now rather than connected to at discover time.
    if ((resolved.transport === 'http' || resolved.transport === 'sse') && resolved.endpoint) {
      await assertUntrustedEndpointSafe(resolved.endpoint);
    }
    return resolved;
  }

  /** Second-hop fetch for Smithery: GET {url}/servers/{qualifiedName} →
   *  connections[].deploymentUrl. The resolved host still passes the
   *  untrusted-remote guard, and https is required. */
  private async resolveSmitheryEndpoint(
    registry: McpRegistryConfig,
    entry: McpCatalogEntry,
  ): Promise<McpCatalogEntry> {
    const base = registry.url.replace(/\/+$/, '');
    const doc = (await this.fetchJson(
      `${base}/servers/${encodeURIComponent(entry.id)}`,
      registry,
    )) as Record<string, unknown>;
    const connections = Array.isArray(doc['connections']) ? doc['connections'] : [];
    const httpConn = connections.find(
      (c): c is Record<string, unknown> =>
        !!c && typeof c === 'object' && str((c as Record<string, unknown>)['deploymentUrl']) !== null,
    );
    const url = str(httpConn?.['deploymentUrl']) ?? str(doc['deploymentUrl']);
    if (!url) {
      throw new McpRegistryError(
        'mcp_catalog_entry_not_importable',
        `Smithery entry "${entry.id}" exposes no deployment URL`,
      );
    }
    // Sync host classification here; the resolved-IP check runs once in
    // resolve() for every marketplace path (see assertUntrustedEndpointSafe).
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !isUntrustedRemoteHostSafe(parsed.hostname)) {
        throw new McpRegistryError('blocked_host', `Smithery endpoint refused: ${url}`);
      }
    } catch (err) {
      if (err instanceof McpRegistryError) throw err;
      throw new McpRegistryError('mcp_catalog_entry_not_importable', `bad Smithery URL: ${url}`);
    }
    return { ...entry, endpoint: url };
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
    // Kind selects the list endpoint + normalizer. Smithery has its own API;
    // official/generic share the official-shape parser (which also reads a
    // plain { servers:[...] } document).
    const candidates =
      registry.kind === 'smithery'
        ? [`${base}/servers?pageSize=100`, `${base}/servers`]
        : [`${base}/v0/servers?limit=100`, base];
    const normalize = registry.kind === 'smithery' ? normalizeSmitheryEntry : normalizeEntry;
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
        // isLatest dedup for the official registry (issue #455 W7 fix): the
        // list carries multiple versions of the same name; keep the newest so
        // browse shows one row per server.
        const filtered =
          registry.kind === 'smithery'
            ? rawList
            : dedupOfficialToLatest(rawList as Array<Record<string, unknown>>);
        const entries = filtered
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map(normalize)
          .filter((e): e is McpCatalogEntry => e !== null);
        this.log(
          `[mcpRegistry] "${registry.name}" (${registry.kind ?? 'generic'}): ${String(entries.length)} catalog entries from ${url}`,
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
    await assertFetchableRegistryUrl(url);
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
        // A redirect could bounce the (token-carrying) request to a host the
        // operator never configured — refuse instead of following (codex fold).
        redirect: 'error',
      });
      if (!res.ok) {
        throw new McpRegistryError('http_error', `${url} answered ${String(res.status)}`);
      }
      // Enforce the size cap WHILE streaming, not after buffering the full
      // body (codex fold) — a broken registry cannot balloon process memory.
      const text = await readTextCapped(res, MAX_CATALOG_BYTES, url);
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
