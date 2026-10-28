// ===========================================================================
// RegistryClient — OSS-Core consumer of remote plugin registries.
// ---------------------------------------------------------------------------
// Fetches `index.json` from one or more configured registries, merges them
// (first-registry-wins on id collision), and downloads + sha256-verifies a
// specific ZIP artifact for installation. The downloaded buffer is handed
// straight to the EXISTING `PackageUploadService.ingest` pipeline — this
// client adds no validation/activation logic of its own.
//
// Trust model (MVP): sha256 pinned in the index + HTTPS/TLS. The artifact
// host is pinned to the registry host (a tampered index cannot redirect the
// download to an arbitrary origin). No per-artifact signing yet.
//
// Multi-registry from day one: `registries` is a list; private hubs are
// consumed by attaching a bearer `token`.
//
// #1458 — one registry must never hold the store hostage. Every index fetch
// runs under one deadline that covers the body too, the deadline stays below
// the web UI's server-side fetch budget, outcomes are cached (failures for a
// shorter time), and concurrent callers share one in-flight fetch.
// ===========================================================================

import { createHash } from 'node:crypto';

import type {
  RegistryConfigEntry,
  RegistryIndexV1,
  RegistryManifestSummary,
  RegistryPluginEntry,
  RegistryVersionEntry,
} from '../api/registry-v1.js';
import type { PluginKind, RegistrySourceStatus } from '../api/admin-v1.js';

const INDEX_PATH = '/registry/index.json';
/** #1458 — index deadline (headers AND body). The web UI aborts its
 *  server-side fetches after 10 s (`RSC_FETCH_TIMEOUT_MS`), and the store list
 *  waits for the slowest registry, so this has to finish well before that. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Upper bound for a configured index deadline — see DEFAULT_TIMEOUT_MS. */
export const MAX_INDEX_TIMEOUT_MS = 8_000;
/** Artifact downloads are explicit operator actions and up to 50 MiB, so they
 *  get their own, longer deadline (also covering the body). */
const DEFAULT_ARTIFACT_TIMEOUT_MS = 120_000;
/** Same budgets as the MCP registry client: a good index is reused for five
 *  minutes, a failed one is retried after a minute. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const DEFAULT_MAX_INDEX_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024; // 50 MiB

const VALID_KINDS: ReadonlySet<string> = new Set([
  'agent',
  'integration',
  'channel',
  'tool',
  'extension',
]);

export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/** A plugin entry tagged with the config-name of the registry it came from. */
export interface ResolvedRegistryPlugin {
  registry: string;
  entry: RegistryPluginEntry;
}

/** Non-fatal per-registry failure surfaced by `listAll` for graceful degrade. */
export interface RegistryFetchError {
  registry: string;
  code: string;
  message: string;
}

export interface RegistryListResult {
  plugins: ResolvedRegistryPlugin[];
  errors: RegistryFetchError[];
  /** #1482 — one entry per configured registry, in configured order. */
  sources: RegistrySourceStatus[];
}

export interface RegistryClientDeps {
  registries: RegistryConfigEntry[];
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Index deadline; clamped to `MAX_INDEX_TIMEOUT_MS`. */
  timeoutMs?: number;
  artifactTimeoutMs?: number;
  /** How long a fetched index is reused. 0 disables the cache. */
  cacheTtlMs?: number;
  /** How long a failed fetch is reused before the registry is asked again. */
  failureTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  maxIndexBytes?: number;
  maxArtifactBytes?: number;
}

/** The cached outcome of one registry's index fetch. */
type IndexOutcome =
  | { ok: true; index: RegistryIndexV1; checkedAt: number; expiresAt: number }
  | { ok: false; error: RegistryFetchError; checkedAt: number; expiresAt: number };

export class RegistryClient {
  private registries: RegistryConfigEntry[];
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly artifactTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  private readonly maxIndexBytes: number;
  private readonly maxArtifactBytes: number;
  /** registry name → last outcome. Cleared by `setRegistries`. */
  private readonly cache = new Map<string, IndexOutcome>();
  /** registry name → the fetch every concurrent caller waits on. */
  private readonly inflight = new Map<string, Promise<IndexOutcome>>();
  /** Bumped by `setRegistries`, so a fetch started against the old list can
   *  not write its outcome into the new cache. */
  private generation = 0;

  constructor(deps: RegistryClientDeps) {
    this.registries = deps.registries;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.log = deps.log ?? ((m) => console.log(m));
    const wanted = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (wanted > MAX_INDEX_TIMEOUT_MS) {
      this.log(
        `[registry] index timeout ${wanted}ms exceeds the store budget — using ${MAX_INDEX_TIMEOUT_MS}ms`,
      );
    }
    this.timeoutMs = Math.min(wanted, MAX_INDEX_TIMEOUT_MS);
    this.artifactTimeoutMs = deps.artifactTimeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS;
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.failureTtlMs = deps.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.maxIndexBytes = deps.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
    this.maxArtifactBytes = deps.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  hasRegistries(): boolean {
    return this.registries.length > 0;
  }

  /**
   * Replace the configured registry list at runtime. Called at boot and after
   * every admin mutation of the `RegistryConfigStore`, so the client reflects
   * the current admin state without a process restart.
   */
  setRegistries(registries: RegistryConfigEntry[]): void {
    this.registries = registries;
    // A changed url or token must be fetched again, not served from the cache.
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
  }

  /** Snapshot of the configured registry names (display/diagnostics only). */
  registryNames(): string[] {
    return this.registries.map((r) => r.name);
  }

  /** Lookup a configured registry by its stable `name`. */
  getRegistry(name: string): RegistryConfigEntry | undefined {
    return this.registries.find((r) => r.name === name);
  }

  /**
   * Fetch + parse one registry's `index.json`. Throws `RegistryError` on a
   * network/HTTP/parse failure. Callers that must degrade gracefully should
   * use `listAll` instead.
   */
  async fetchIndex(reg: RegistryConfigEntry): Promise<RegistryIndexV1> {
    const url = joinUrl(reg.url, INDEX_PATH);
    const buf = await this.request(url, reg.token, 'index', this.timeoutMs, (res) => {
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new RegistryError(
          'registry.index_http',
          `${reg.name}: GET ${INDEX_PATH} → ${res.status}`,
        );
      }
      return this.readCapped(res, this.maxIndexBytes, 'index');
    });

    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      throw new RegistryError(
        'registry.index_parse',
        `${reg.name}: index.json is not valid JSON (${errMsg(err)})`,
      );
    }
    return this.parseIndex(raw, reg.name);
  }

  /**
   * Fetch every configured registry in parallel and merge. First registry in
   * the configured order wins on plugin-id collision (the loser is dropped
   * with a warning). A registry that fails is recorded in `errors` and
   * `sources`, not thrown — the store must still render the registries that
   * are reachable. Outcomes come from the cache when they are fresh enough.
   */
  async listAll(): Promise<RegistryListResult> {
    const registries = this.registries;
    const outcomes = await Promise.all(
      registries.map((reg) => this.indexOutcome(reg)),
    );

    const plugins: ResolvedRegistryPlugin[] = [];
    const errors: RegistryFetchError[] = [];
    const sources: RegistrySourceStatus[] = [];
    const seen = new Map<string, string>(); // plugin id → winning registry name

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]!;
      const reg = registries[i]!;
      const checked_at = new Date(outcome.checkedAt).toISOString();
      if (!outcome.ok) {
        errors.push(outcome.error);
        sources.push({
          name: reg.name,
          ok: false,
          checked_at,
          error: { code: outcome.error.code, message: outcome.error.message },
        });
        continue;
      }
      sources.push({
        name: reg.name,
        ok: true,
        checked_at,
        plugin_count: outcome.index.plugins.length,
      });
      for (const entry of outcome.index.plugins) {
        const owner = seen.get(entry.id);
        if (owner) {
          this.log(
            `[registry] id collision: '${entry.id}' from '${reg.name}' ignored (already provided by '${owner}')`,
          );
          continue;
        }
        seen.set(entry.id, reg.name);
        plugins.push({ registry: reg.name, entry });
      }
    }

    return { plugins, errors, sources };
  }

  /** One registry's index, from the cache, from a fetch already in flight,
   *  or freshly fetched. Never rejects: a failure is an outcome too. */
  private indexOutcome(reg: RegistryConfigEntry): Promise<IndexOutcome> {
    const cached = this.cache.get(reg.name);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached);
    const pending = this.inflight.get(reg.name);
    if (pending) return pending;

    const generation = this.generation;
    const fetched = this.fetchIndex(reg).then(
      (index): IndexOutcome => {
        const checkedAt = this.now();
        return { ok: true, index, checkedAt, expiresAt: checkedAt + this.cacheTtlMs };
      },
      (err: unknown): IndexOutcome => {
        const checkedAt = this.now();
        const code = err instanceof RegistryError ? err.code : 'registry.fetch';
        const message = describeError(err);
        // Logged once per real fetch, not once per cached read.
        this.log(`[registry] ${reg.name} unreachable: ${message}`);
        return {
          ok: false,
          error: { registry: reg.name, code, message },
          checkedAt,
          expiresAt: checkedAt + this.failureTtlMs,
        };
      },
    );
    const settled = fetched.then((outcome) => {
      if (generation === this.generation) {
        this.inflight.delete(reg.name);
        this.cache.set(reg.name, outcome);
      }
      return outcome;
    });
    this.inflight.set(reg.name, settled);
    return settled;
  }

  /**
   * Download a specific artifact and verify its sha256 against the expected
   * value from the index. The download host is pinned to the registry host.
   * Returns the verified buffer ready for `PackageUploadService.ingest`.
   */
  async fetchPackage(args: {
    registry: string;
    downloadUrl: string;
    sha256: string;
  }): Promise<{ buffer: Buffer; sha256: string }> {
    const reg = this.getRegistry(args.registry);
    if (!reg) {
      throw new RegistryError(
        'registry.unknown',
        `no configured registry named '${args.registry}'`,
      );
    }

    this.assertHostPinned(reg, args.downloadUrl);

    try {
      return await this.downloadVerified(reg, args);
    } catch (err) {
      // The cached index pointed here; a missing or changed artifact means it
      // is out of date — the next lookup must fetch it again.
      this.invalidate(reg.name);
      throw err;
    }
  }

  /** Drop one registry's cached outcome. */
  invalidate(name: string): void {
    this.cache.delete(name);
  }

  private async downloadVerified(
    reg: RegistryConfigEntry,
    args: { downloadUrl: string; sha256: string },
  ): Promise<{ buffer: Buffer; sha256: string }> {
    const buffer = await this.request(
      args.downloadUrl,
      reg.token,
      'artifact',
      this.artifactTimeoutMs,
      (res) => {
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          throw new RegistryError(
            'registry.artifact_http',
            `${reg.name}: GET ${args.downloadUrl} → ${res.status}`,
          );
        }
        return this.readCapped(res, this.maxArtifactBytes, 'artifact');
      },
    );
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual.toLowerCase() !== args.sha256.toLowerCase()) {
      throw new RegistryError(
        'registry.sha256_mismatch',
        `${reg.name}: artifact sha256 mismatch (expected ${args.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      );
    }
    return { buffer, sha256: actual };
  }

  // ----- internals --------------------------------------------------------

  /** Reject a download_url whose host differs from the registry's host. */
  private assertHostPinned(reg: RegistryConfigEntry, downloadUrl: string): void {
    let regHost: string;
    let dlHost: string;
    try {
      regHost = new URL(reg.url).host;
      dlHost = new URL(downloadUrl).host;
    } catch {
      throw new RegistryError(
        'registry.bad_url',
        `${reg.name}: malformed registry or download URL`,
      );
    }
    if (regHost !== dlHost) {
      throw new RegistryError(
        'registry.host_mismatch',
        `${reg.name}: download host '${dlHost}' does not match registry host '${regHost}'`,
      );
    }
  }

  /**
   * GET `url` and hand the response to `read`, all under ONE deadline. The
   * timer used to stop at the response headers, so a registry that sent
   * headers and then stalled the body held the request open (#1458).
   */
  private async request<T>(
    url: string,
    token: string | undefined,
    kind: 'index' | 'artifact',
    timeoutMs: number,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fail = (err: unknown): RegistryError =>
      controller.signal.aborted
        ? new RegistryError('registry.timeout', `${kind} fetch timed out after ${timeoutMs}ms`)
        : new RegistryError('registry.network', `${kind} fetch failed: ${describeError(err)}`);
    try {
      const headers: Record<string, string> = {
        Accept:
          kind === 'index' ? 'application/json' : 'application/octet-stream',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (err) {
        throw fail(err);
      }
      try {
        return await read(res);
      } catch (err) {
        if (err instanceof RegistryError) throw err;
        throw fail(err);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a response body, rejecting once it would exceed `cap` bytes. */
  private async readCapped(
    res: Response,
    cap: number,
    kind: 'index' | 'artifact',
  ): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) {
      throw new RegistryError(
        'registry.too_large',
        `${kind} declares ${declared} bytes, exceeds cap ${cap}`,
      );
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > cap) {
      throw new RegistryError(
        'registry.too_large',
        `${kind} is ${ab.byteLength} bytes, exceeds cap ${cap}`,
      );
    }
    return Buffer.from(ab);
  }

  /**
   * Defensive parse of a raw index payload. The top-level shape is enforced
   * strictly; individual plugin/version entries that are malformed are
   * dropped with a warning so one bad entry cannot break the whole catalog.
   */
  private parseIndex(raw: unknown, registryName: string): RegistryIndexV1 {
    if (!isObject(raw)) {
      throw new RegistryError(
        'registry.index_shape',
        `${registryName}: index is not an object`,
      );
    }
    if (raw['schema_version'] !== '1') {
      throw new RegistryError(
        'registry.index_version',
        `${registryName}: unsupported schema_version ${String(raw['schema_version'])}`,
      );
    }
    const reg = isObject(raw['registry']) ? raw['registry'] : {};
    const rawPlugins = Array.isArray(raw['plugins']) ? raw['plugins'] : [];

    const plugins: RegistryPluginEntry[] = [];
    let dropped = 0;
    for (const p of rawPlugins) {
      const entry = this.parsePluginEntry(p);
      if (entry) plugins.push(entry);
      else dropped++;
    }
    if (dropped > 0) {
      this.log(
        `[registry] ${registryName}: dropped ${dropped} malformed plugin entr${dropped === 1 ? 'y' : 'ies'}`,
      );
    }

    return {
      schema_version: '1',
      registry: {
        name: asString(reg['name'], registryName),
        url: asString(reg['url'], ''),
      },
      generated_at: asString(raw['generated_at'], ''),
      plugins,
    };
  }

  private parsePluginEntry(raw: unknown): RegistryPluginEntry | null {
    if (!isObject(raw)) return null;
    const id = asString(raw['id'], '');
    const name = asString(raw['name'], '');
    const kind = asString(raw['kind'], '');
    if (!id || !name || !VALID_KINDS.has(kind)) return null;

    const versions: RegistryVersionEntry[] = [];
    const rawVersions = Array.isArray(raw['versions']) ? raw['versions'] : [];
    for (const v of rawVersions) {
      const parsed = this.parseVersionEntry(v);
      if (parsed) versions.push(parsed);
    }
    if (versions.length === 0) return null;

    const latest =
      asString(raw['latest_version'], '') ||
      versions[0]!.version;

    return {
      id,
      name,
      kind: kind as PluginKind,
      domain: asString(raw['domain'], `unknown.${id}`),
      description: asString(raw['description'], ''),
      ...(isObject(raw['description_localized'])
        ? {
            description_localized: Object.fromEntries(
              Object.entries(raw['description_localized'] as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string' && v.length > 0)
                .map(([k, v]) => [k, v as string]),
            ),
          }
        : {}),
      categories: asStringArray(raw['categories']),
      authors: parseAuthors(raw['authors']),
      license: asString(raw['license'], 'Unknown'),
      icon_url: typeof raw['icon_url'] === 'string' ? raw['icon_url'] : null,
      latest_version: latest,
      versions,
    };
  }

  private parseVersionEntry(raw: unknown): RegistryVersionEntry | null {
    if (!isObject(raw)) return null;
    const version = asString(raw['version'], '');
    const sha256 = asString(raw['sha256'], '');
    const download_url = asString(raw['download_url'], '');
    if (!version || !/^[0-9a-f]{64}$/i.test(sha256) || !download_url) {
      return null;
    }
    const summary = isObject(raw['manifest_summary'])
      ? (raw['manifest_summary'] as RegistryManifestSummary)
      : {};
    return {
      version,
      compat_core: asString(raw['compat_core'], '>=1.0 <2.0'),
      sha256,
      size_bytes: asNumber(raw['size_bytes'], 0),
      download_url,
      published_at: asString(raw['published_at'], ''),
      manifest_summary: summary,
    };
  }
}

// ----- small helpers -------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function parseAuthors(
  v: unknown,
): Array<{ name: string; email?: string; url?: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ name: string; email?: string; url?: string }> = [];
  for (const a of v) {
    if (!isObject(a)) continue;
    const name = asString(a['name'], '');
    if (!name) continue;
    const author: { name: string; email?: string; url?: string } = { name };
    if (typeof a['email'] === 'string') author.email = a['email'];
    if (typeof a['url'] === 'string') author.url = a['url'];
    out.push(author);
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * #1482 — `err.message` plus its `cause`. Node's fetch reports a refused
 * connection, a DNS miss or a refused redirect as a bare "fetch failed" and
 * puts the reason in `err.cause`; without it the log could not say why.
 */
export function describeError(err: unknown): string {
  const message = errMsg(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return message;
  const causeMessage =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const code =
    isObject(cause) && typeof cause['code'] === 'string' ? cause['code'] : '';
  const detail =
    causeMessage && code && !causeMessage.includes(code)
      ? `${code}: ${causeMessage}`
      : causeMessage || code;
  return detail && detail !== message ? `${message} (${detail})` : message;
}
