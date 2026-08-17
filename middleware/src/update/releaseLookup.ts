import { isNewerVersion } from './semver.js';

/**
 * "Is there a newer omadia release?" — GitHub Releases lookup (#432, slice 2).
 *
 * Cached and offline-tolerant by construction. A self-hosted omadia may sit on
 * an air-gapped or proxied network where api.github.com is simply unreachable;
 * that must degrade to "we don't know" on the admin page, never to a failing
 * status endpoint. Equally, the unauthenticated GitHub REST budget is 60
 * requests/hour PER IP — shared by every operator behind the same NAT — so the
 * result is cached for `ttlMs` and a failed refresh keeps serving the last
 * known-good answer, flagged `stale`.
 */

export interface LatestRelease {
  /** Release tag exactly as GitHub reports it, e.g. `v0.74.0`. */
  readonly tag: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly prerelease: boolean;
}

export interface ReleaseLookupResult {
  readonly release: LatestRelease | null;
  /** Epoch ms of the lookup that produced `release`; null if never succeeded. */
  readonly checkedAt: number | null;
  /** True when the last refresh failed and `release` is a cached older answer
   *  (or null because no lookup has ever succeeded). */
  readonly stale: boolean;
  /** Human-readable reason the last refresh failed, when it did. */
  readonly error?: string;
}

export interface ReleaseLookupOptions {
  /** `owner/repo`. Defaults to the public omadia repository. */
  readonly repo?: string;
  /** Cache lifetime for a successful lookup. Default 30 minutes. */
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /** Optional PAT — only needed for a private fork or a hot NAT. */
  readonly token?: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface ReleaseLookup {
  /** Cached read; refreshes when the TTL expired or `force` is set. Never
   *  rejects — transport failures surface as `stale` + `error`. */
  get(force?: boolean): Promise<ReleaseLookupResult>;
}

const DEFAULT_REPO = 'byte5ai/omadia';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

interface GithubReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  prerelease?: unknown;
}

/** Narrow the GitHub payload without trusting any field. A release without a
 *  usable tag is treated as "no release", not as a partially-filled object. */
function toRelease(payload: unknown, repo: string): LatestRelease | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as GithubReleasePayload;
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  if (tag.length === 0) return null;
  return {
    tag,
    url:
      typeof raw.html_url === 'string' && raw.html_url.length > 0
        ? raw.html_url
        : `https://github.com/${repo}/releases/tag/${tag}`,
    publishedAt:
      typeof raw.published_at === 'string' ? raw.published_at : '',
    prerelease: raw.prerelease === true,
  };
}

export function createReleaseLookup(
  options: ReleaseLookupOptions = {},
): ReleaseLookup {
  const repo = options.repo ?? DEFAULT_REPO;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  let cached: LatestRelease | null = null;
  let checkedAt: number | null = null;
  let lastError: string | undefined;
  // Collapse concurrent callers (admin page poll + status endpoint) onto one
  // request so a slow GitHub does not multiply against the rate limit.
  let inFlight: Promise<ReleaseLookupResult> | null = null;

  function snapshot(stale: boolean): ReleaseLookupResult {
    return {
      release: cached,
      checkedAt,
      stale,
      ...(stale && lastError !== undefined ? { error: lastError } : {}),
    };
  }

  async function refresh(): Promise<ReleaseLookupResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const res = await doFetch(
        `https://api.github.com/repos/${repo}/releases/latest`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'omadia-self-update',
            ...(options.token !== undefined && options.token.length > 0
              ? { authorization: `Bearer ${options.token}` }
              : {}),
          },
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        lastError = `github_status_${res.status}`;
        return snapshot(true);
      }
      const parsed = toRelease(await res.json(), repo);
      if (parsed === null) {
        lastError = 'github_payload_unusable';
        return snapshot(true);
      }
      cached = parsed;
      checkedAt = now();
      lastError = undefined;
      return snapshot(false);
    } catch (err) {
      // Offline, DNS failure, proxy refusal, abort — all the same to the caller.
      lastError = err instanceof Error ? err.message : String(err);
      return snapshot(true);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(force = false): Promise<ReleaseLookupResult> {
      const fresh =
        checkedAt !== null && now() - checkedAt < ttlMs && lastError === undefined;
      if (!force && fresh) return snapshot(false);
      inFlight ??= refresh().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

/** Convenience for the status endpoint: does `latest` beat `current`? */
export function releaseIsNewer(
  currentVersion: string,
  release: LatestRelease | null,
): boolean {
  if (release === null) return false;
  return isNewerVersion(currentVersion, release.tag);
}
