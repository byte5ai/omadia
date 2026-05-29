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
// ===========================================================================

import { createHash } from 'node:crypto';

import type {
  RegistryConfigEntry,
  RegistryIndexV1,
  RegistryManifestSummary,
  RegistryPluginEntry,
  RegistryVersionEntry,
} from '../api/registry-v1.js';
import type { PluginKind } from '../api/admin-v1.js';

const INDEX_PATH = '/registry/index.json';
const DEFAULT_TIMEOUT_MS = 15_000;
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
}

export interface RegistryClientDeps {
  registries: RegistryConfigEntry[];
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  timeoutMs?: number;
  maxIndexBytes?: number;
  maxArtifactBytes?: number;
}

export class RegistryClient {
  private registries: RegistryConfigEntry[];
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly maxIndexBytes: number;
  private readonly maxArtifactBytes: number;

  constructor(deps: RegistryClientDeps) {
    this.registries = deps.registries;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.log = deps.log ?? ((m) => console.log(m));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const res = await this.doFetch(url, reg.token, 'index');

    if (!res.ok) {
      throw new RegistryError(
        'registry.index_http',
        `${reg.name}: GET ${INDEX_PATH} → ${res.status}`,
      );
    }

    const buf = await this.readCapped(res, this.maxIndexBytes, 'index');
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
   * with a warning). A registry that fails is recorded in `errors`, not
   * thrown — the store must still render the registries that are reachable.
   */
  async listAll(): Promise<RegistryListResult> {
    const settled = await Promise.allSettled(
      this.registries.map(async (reg) => ({
        reg,
        index: await this.fetchIndex(reg),
      })),
    );

    const plugins: ResolvedRegistryPlugin[] = [];
    const errors: RegistryFetchError[] = [];
    const seen = new Map<string, string>(); // plugin id → winning registry name

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const reg = this.registries[i]!;
      if (outcome.status === 'rejected') {
        const err = outcome.reason;
        const code = err instanceof RegistryError ? err.code : 'registry.fetch';
        errors.push({ registry: reg.name, code, message: errMsg(err) });
        this.log(`[registry] ${reg.name} unreachable: ${errMsg(err)}`);
        continue;
      }
      for (const entry of outcome.value.index.plugins) {
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

    return { plugins, errors };
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

    const res = await this.doFetch(args.downloadUrl, reg.token, 'artifact');
    if (!res.ok) {
      throw new RegistryError(
        'registry.artifact_http',
        `${reg.name}: GET ${args.downloadUrl} → ${res.status}`,
      );
    }

    const buffer = await this.readCapped(
      res,
      this.maxArtifactBytes,
      'artifact',
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

  private async doFetch(
    url: string,
    token: string | undefined,
    kind: 'index' | 'artifact',
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept:
          kind === 'index' ? 'application/json' : 'application/octet-stream',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      const aborted =
        err instanceof Error && err.name === 'AbortError';
      throw new RegistryError(
        aborted ? 'registry.timeout' : 'registry.network',
        aborted
          ? `${kind} fetch timed out after ${this.timeoutMs}ms`
          : `${kind} fetch failed: ${errMsg(err)}`,
      );
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
