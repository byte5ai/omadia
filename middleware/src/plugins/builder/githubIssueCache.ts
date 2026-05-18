import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * GitHub issue cache (concept plan: docs/plans/native-issue-reporting.md).
 *
 * Two responsibilities:
 *
 *   1. Cache the `open` / `closed` state of issues the operator tracks
 *      as workaround triggers, so opening a store page does not hit the
 *      GitHub REST API on every render. The cache TTL is 1 hour by
 *      default; ETag-aware requests refresh stale entries cheaply via
 *      304 responses.
 *
 *   2. Look up an existing builder-bot issue by fingerprint before we
 *      suggest creating a new one, so the operator never spams the
 *      upstream repo with duplicates of the same underlying bug. A
 *      `pending_until` window serializes concurrent fingerprint
 *      lookups so two operators triggering the same failure at once do
 *      not both create issues — the second caller waits for the first.
 *
 * The cache speaks to GitHub via an injectable `fetch` so unit tests
 * can fully mock the network. The default fetch uses the global
 * `fetch` and adds no auth header (concept plan: v1 is browser-submit
 * only; PAT mode is deferred until vault persistence lands in v1.2b).
 *
 * Backoff: on a 403 rate-limit response the `Retry-After` (or
 * X-RateLimit-Reset) value is persisted as `backoff_until`. Subsequent
 * lookups within that window short-circuit to the cached `state`
 * without making a network call, surfacing a `staleness` flag the UI
 * uses to disable the manual "Check now" button with a tooltip.
 */

export type IssueState = 'open' | 'closed';

export interface CachedIssueStatus {
  state: IssueState;
  closedAt: number | null;
  cachedAt: number;
  /** True when the entry was returned from cache without contacting
   *  GitHub (either fresh, or because a backoff window is active). */
  fromCache: boolean;
  /** True when a backoff window blocked an upstream refresh. The UI
   *  uses this to disable the manual refresh button. */
  rateLimited: boolean;
}

export interface IssueRefHit {
  number: number;
  state: IssueState;
  url: string;
  fingerprint: string;
}

/**
 * Subset of the global Fetch API we use. Defined narrowly so test
 * doubles do not have to implement the whole spec.
 */
export type CacheFetch = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface GithubIssueCacheOptions {
  /** Path to the SQLite database that already contains the v2 schema. */
  dbPath: string;
  /** TTL for `getIssueStatus` cache entries. Default 1 hour. */
  ttlMs?: number;
  /** Pending lock duration for fingerprint search. Default 60 seconds. */
  pendingLockMs?: number;
  /** Fetch implementation. Defaults to global fetch. */
  fetch?: CacheFetch;
  /** Clock injection point for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PENDING_LOCK_MS = 60 * 1000;

export class GithubIssueCache {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly ttlMs: number;
  private readonly pendingLockMs: number;
  private readonly fetchImpl: CacheFetch;
  private readonly now: () => number;
  /** In-memory inflight tracking so two callers on the same node do not
   *  even hit the DB for a duplicate fingerprint lookup. */
  private readonly inflightSearches = new Map<string, Promise<IssueRefHit | null>>();

  constructor(opts: GithubIssueCacheOptions) {
    this.dbPath = opts.dbPath;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.pendingLockMs = opts.pendingLockMs ?? DEFAULT_PENDING_LOCK_MS;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async open(): Promise<void> {
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    this.db = db;
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return Promise.resolve();
  }

  /**
   * Look up the current status of an issue. Hits the GitHub REST API
   * only when the cached entry is older than `ttlMs` AND we are not
   * currently inside a rate-limit backoff window.
   */
  async getIssueStatus(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<CachedIssueStatus | null> {
    const db = this.required();
    const now = this.now();
    const row = db
      .prepare(
        `SELECT state, closed_at, cached_at, etag, backoff_until
         FROM github_issue_cache
         WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?`,
      )
      .get(owner, repo, issueNumber) as
      | {
          state: string;
          closed_at: number | null;
          cached_at: number;
          etag: string | null;
          backoff_until: number | null;
        }
      | undefined;

    // Backoff active → return what we have (or `null` if we have
    // nothing), without contacting GitHub.
    if (row && row.backoff_until && row.backoff_until > now) {
      return {
        state: normalizeState(row.state),
        closedAt: row.closed_at,
        cachedAt: row.cached_at,
        fromCache: true,
        rateLimited: true,
      };
    }

    // Fresh cache hit.
    if (row && now - row.cached_at < this.ttlMs) {
      return {
        state: normalizeState(row.state),
        closedAt: row.closed_at,
        cachedAt: row.cached_at,
        fromCache: true,
        rateLimited: false,
      };
    }

    // Refresh against GitHub. Use ETag for cheap 304s.
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'omadia-builder/1',
    };
    if (row?.etag) headers['If-None-Match'] = row.etag;
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${String(issueNumber)}`;
    const response = await this.fetchImpl(url, { headers });

    // 304 — same state as we already have; just bump cached_at.
    if (response.status === 304 && row) {
      db.prepare(
        `UPDATE github_issue_cache
         SET cached_at = ?, backoff_until = NULL
         WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?`,
      ).run(now, owner, repo, issueNumber);
      return {
        state: normalizeState(row.state),
        closedAt: row.closed_at,
        cachedAt: now,
        fromCache: false,
        rateLimited: false,
      };
    }

    // 403 / rate limit. Persist Retry-After so future calls do not
    // hammer the same endpoint.
    if (response.status === 403 || response.status === 429) {
      const backoffUntil = parseRetryAfter(response, now);
      if (row) {
        db.prepare(
          `UPDATE github_issue_cache
           SET backoff_until = ?
           WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?`,
        ).run(backoffUntil, owner, repo, issueNumber);
        return {
          state: normalizeState(row.state),
          closedAt: row.closed_at,
          cachedAt: row.cached_at,
          fromCache: true,
          rateLimited: true,
        };
      }
      // No cached row — there is nothing we can return. Persist a
      // stub so the next caller respects the backoff.
      db.prepare(
        `INSERT OR IGNORE INTO github_issue_cache
           (repo_owner, repo_name, issue_number, state, closed_at, cached_at, etag, backoff_until)
         VALUES (?, ?, ?, 'open', NULL, ?, NULL, ?)`,
      ).run(owner, repo, issueNumber, now, backoffUntil);
      return null;
    }

    if (response.status === 404) {
      // Issue does not exist. Cache the negative so we do not retry.
      db.prepare(
        `INSERT OR REPLACE INTO github_issue_cache
           (repo_owner, repo_name, issue_number, state, closed_at, cached_at, etag, backoff_until)
         VALUES (?, ?, ?, 'open', NULL, ?, NULL, NULL)`,
      ).run(owner, repo, issueNumber, now);
      return null;
    }

    if (!response.ok) {
      // Unknown error: return whatever we had cached, without writing.
      if (row) {
        return {
          state: normalizeState(row.state),
          closedAt: row.closed_at,
          cachedAt: row.cached_at,
          fromCache: true,
          rateLimited: false,
        };
      }
      return null;
    }

    const payload = (await response.json()) as {
      state?: string;
      closed_at?: string | null;
    };
    const state: IssueState = payload.state === 'closed' ? 'closed' : 'open';
    const closedAt = payload.closed_at ? Date.parse(payload.closed_at) : null;
    const etag = response.headers.get('etag');

    db.prepare(
      `INSERT OR REPLACE INTO github_issue_cache
         (repo_owner, repo_name, issue_number, state, closed_at, cached_at, etag, backoff_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      owner,
      repo,
      issueNumber,
      state,
      closedAt,
      now,
      etag ?? null,
      // backoff_until cleared on successful refresh.
    );

    return {
      state,
      closedAt,
      cachedAt: now,
      fromCache: false,
      rateLimited: false,
    };
  }

  /**
   * Search upstream for an existing issue carrying the given
   * fingerprint. Returns the issue ref (number + state + url) on a hit
   * or `null` on miss.
   *
   * A pending-lock window prevents two concurrent callers from
   * creating duplicate issues for the same failure: the first to look
   * up writes a `pending_until` marker for the synthetic
   * fingerprint-cache row; subsequent callers wait for the first to
   * resolve (in-memory via `inflightSearches`, cross-restart via the
   * DB marker which expires after `pendingLockMs`).
   */
  async searchByFingerprint(
    owner: string,
    repo: string,
    fingerprint: string,
    labels: readonly string[] = ['from-builder-bot'],
  ): Promise<IssueRefHit | null> {
    const key = fingerprintKey(owner, repo, fingerprint);
    const existing = this.inflightSearches.get(key);
    if (existing) return existing;

    const task = this.doSearchByFingerprint(owner, repo, fingerprint, labels);
    this.inflightSearches.set(key, task);
    try {
      return await task;
    } finally {
      this.inflightSearches.delete(key);
    }
  }

  /**
   * Validate that a specific issue number actually represents the
   * fingerprint the operator says it does. Used by the confirm-issue
   * route after browser-submit so a tampered or mistyped issue number
   * cannot link an unrelated upstream issue to the workaround.
   *
   * Validation rules:
   *   - Issue exists (200 response from the issue REST endpoint).
   *   - Body contains the fingerprint marker `<!-- omadia-fingerprint:
   *     <hash> -->`.
   *   - Every label in `requiredLabels` is present on the issue.
   *   - State is 'open' or 'closed' (no other values exist on REST,
   *     but defensive parsing).
   */
  async validateIssueMatchesFingerprint(
    owner: string,
    repo: string,
    issueNumber: number,
    fingerprint: string,
    requiredLabels: readonly string[],
  ): Promise<
    | {
        ok: true;
        state: IssueState;
        url: string;
        closedAt: number | null;
      }
    | {
        ok: false;
        reason:
          | 'not_found'
          | 'fingerprint_mismatch'
          | 'missing_labels'
          | 'fetch_failed';
        details?: string;
      }
  > {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${String(issueNumber)}`;
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'omadia-builder/1',
      },
    });
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) {
      return {
        ok: false,
        reason: 'fetch_failed',
        details: `status=${String(response.status)}`,
      };
    }
    const payload = (await response.json()) as {
      body?: string | null;
      state?: string;
      closed_at?: string | null;
      html_url?: string;
      labels?: Array<{ name?: string } | string>;
    };
    const marker = `<!-- omadia-fingerprint: ${fingerprint} -->`;
    const body = payload.body ?? '';
    if (!body.includes(marker)) {
      return { ok: false, reason: 'fingerprint_mismatch' };
    }
    const labels = new Set(
      (payload.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
        .filter((s) => s.length > 0),
    );
    for (const required of requiredLabels) {
      if (!labels.has(required)) {
        return {
          ok: false,
          reason: 'missing_labels',
          details: `expected label '${required}' not present`,
        };
      }
    }
    const state: IssueState = payload.state === 'closed' ? 'closed' : 'open';
    const closedAt = payload.closed_at ? Date.parse(payload.closed_at) : null;

    // Side-effect: cache the validated state so subsequent renders
    // skip the network call.
    const now = this.now();
    const db = this.required();
    const etag = response.headers.get('etag');
    db.prepare(
      `INSERT OR REPLACE INTO github_issue_cache
         (repo_owner, repo_name, issue_number, state, closed_at, cached_at, etag, backoff_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(owner, repo, issueNumber, state, closedAt, now, etag ?? null);

    return {
      ok: true,
      state,
      url:
        payload.html_url ??
        `https://github.com/${owner}/${repo}/issues/${String(issueNumber)}`,
      closedAt,
    };
  }

  private async doSearchByFingerprint(
    owner: string,
    repo: string,
    fingerprint: string,
    labels: readonly string[],
  ): Promise<IssueRefHit | null> {
    const db = this.required();
    const now = this.now();
    const pendingKey = pendingLockKey(fingerprint);

    // Check existing pending lock — if a sibling process took the lock
    // and is still within the window, treat it as a miss to be
    // conservative (we would rather wait for the next visit than risk
    // a duplicate create).
    const lock = db
      .prepare(
        `SELECT pending_until FROM github_issue_cache
         WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?`,
      )
      .get(owner, repo, pendingKey) as { pending_until: number | null } | undefined;
    if (lock && lock.pending_until && lock.pending_until > now) {
      return null;
    }

    // Take the pending lock so a parallel caller sees it.
    db.prepare(
      `INSERT INTO github_issue_cache
         (repo_owner, repo_name, issue_number, state, closed_at, cached_at, etag, backoff_until, pending_until)
       VALUES (?, ?, ?, 'open', NULL, ?, NULL, NULL, ?)
       ON CONFLICT(repo_owner, repo_name, issue_number) DO UPDATE
         SET pending_until = excluded.pending_until,
             cached_at = excluded.cached_at`,
    ).run(owner, repo, pendingKey, now, now + this.pendingLockMs);

    try {
      const labelQuery = labels.map((l) => `label:${l}`).join('+');
      const q = encodeURIComponent(
        `repo:${owner}/${repo} is:issue ${labelQuery} ${fingerprint} in:body`,
      );
      const url = `https://api.github.com/search/issues?q=${q}`;
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'omadia-builder/1',
        },
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as {
        items?: Array<{
          number?: number;
          state?: string;
          html_url?: string;
        }>;
      };
      const first = payload.items?.[0];
      if (!first || typeof first.number !== 'number') return null;
      const state: IssueState = first.state === 'closed' ? 'closed' : 'open';
      return {
        number: first.number,
        state,
        url: first.html_url ?? `https://github.com/${owner}/${repo}/issues/${String(first.number)}`,
        fingerprint,
      };
    } finally {
      // Clear the lock so the next caller does not wait.
      db.prepare(
        `DELETE FROM github_issue_cache
         WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?`,
      ).run(owner, repo, pendingKey);
    }
  }

  private required(): SqliteDatabase {
    if (!this.db) {
      throw new Error('GithubIssueCache.open() must be called before use');
    }
    return this.db;
  }
}

const defaultFetch: CacheFetch = async (url, init) => {
  // eslint-disable-next-line no-undef
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: () => response.json(),
  };
};

function normalizeState(value: string): IssueState {
  return value === 'closed' ? 'closed' : 'open';
}

function parseRetryAfter(
  response: { headers: { get(name: string): string | null } },
  now: number,
): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return now + seconds * 1000;
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return asDate;
  }
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset) {
    const epoch = Number(reset);
    if (Number.isFinite(epoch)) return epoch * 1000;
  }
  // Fall back to one hour.
  return now + 60 * 60 * 1000;
}

/**
 * Issue-number space we use for pending-lock rows. Real GitHub issue
 * numbers fit in a 32-bit signed int (max known repo has ~600 K
 * issues); using negative numbers keeps locks and real entries from
 * colliding in the (owner, repo, number) primary key while preserving
 * fingerprint identity in the value.
 */
function pendingLockKey(fingerprint: string): number {
  // Stable signed-32 derivation from fingerprint.
  let h = 0;
  for (let i = 0; i < fingerprint.length; i += 1) {
    h = (h * 31 + fingerprint.charCodeAt(i)) | 0;
  }
  // Force into the negative half so it never collides with real issue numbers.
  return -Math.abs(h) - 1;
}

function fingerprintKey(
  owner: string,
  repo: string,
  fingerprint: string,
): string {
  return `${owner}/${repo}#${fingerprint}`;
}
