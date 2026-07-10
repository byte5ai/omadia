import type { DevJob } from '../types.js';
import { mintAppJwt } from './appJwt.js';

/**
 * Epic #470 W2 — scoped, uncached, revocable GitHub App installation tokens.
 *
 * The existing `builder/githubAppAuth.ts` mints UNSCOPED, cached installation
 * tokens for the issue-reporting path — all App permissions, reused until they
 * expire. That is wrong for a job runner: the runner clones hostile repositories,
 * so its token must carry the least privilege that lets it clone (`contents:read`,
 * one repo) and must not outlive the job.
 *
 * So every mint here is:
 *   - SCOPED — a `repositories` + `permissions` body, so GitHub issues a token that
 *     can touch exactly one repo with exactly the named rights.
 *   - UNCACHED — each mint is single-purpose; caching would extend blast radius
 *     past job end for no gain.
 *   - REGISTERED — recorded in a per-job registry so `finalizeDevJob` can revoke
 *     every unexpired token the job was ever handed, and an event records the mint
 *     (metadata only: installation id, scope, expiry — NEVER the value).
 *
 * Delivery: the runner's token never rides in the job spec (W0 v2 removed the
 * credential field). The credential helper calls `GET /scm-token`, which mints
 * fresh here.
 */

/** A fetch shape that hides node/undici specifics so tests inject a double. */
export type TokenFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_API_BASE = 'https://api.github.com';

const defaultFetch: TokenFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export interface MintScopedTokenOptions {
  appId: string;
  privateKey: string;
  installationId: string;
  /** Repo NAMES (not owner/name), e.g. `["omadia"]`. GitHub scopes to the App owner. */
  repositories: string[];
  /** e.g. `{ contents: "read" }`. */
  permissions: Record<string, string>;
  apiBaseUrl?: string;
}

export interface ScopedToken {
  token: string;
  expiresAt: Date;
}

function githubHeaders(auth: string): Record<string, string> {
  return {
    Authorization: auth,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'omadia-dev-platform',
  };
}

/**
 * Mint a scoped installation token via
 * `POST /app/installations/{id}/access_tokens` with a `{ repositories, permissions }`
 * body. An empty-body POST would mint an UNSCOPED token (all App permissions) —
 * the exact footgun this module exists to avoid — so the body is mandatory.
 */
export async function mintScopedInstallationToken(
  opts: MintScopedTokenOptions,
  now: () => number = Date.now,
  fetchImpl: TokenFetch = defaultFetch,
): Promise<ScopedToken> {
  if (opts.repositories.length === 0) {
    throw new Error('mintScopedInstallationToken: refusing to mint without a repository scope');
  }
  if (Object.keys(opts.permissions).length === 0) {
    throw new Error('mintScopedInstallationToken: refusing to mint without a permission scope');
  }
  const base = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const jwt = mintAppJwt(opts.appId, opts.privateKey, now);
  const res = await fetchImpl(
    `${base}/app/installations/${encodeURIComponent(opts.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: { ...githubHeaders(`Bearer ${jwt}`), 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositories: opts.repositories, permissions: opts.permissions }),
    },
  );
  if (!res.ok) {
    // Never echo the body — GitHub can reflect the JWT back in an error.
    throw new Error(`GitHub scoped token mint failed (status ${String(res.status)})`);
  }
  const payload = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new Error('GitHub scoped token mint returned no token');
  }
  const parsed = typeof payload.expires_at === 'string' ? Date.parse(payload.expires_at) : NaN;
  // A missing/garbled expiry falls back to GitHub's own 1-hour ceiling, so a
  // parse miss never leaves a token the registry believes lives forever.
  const expiresAt = new Date(Number.isFinite(parsed) ? parsed : now() + 60 * 60 * 1000);
  return { token: payload.token, expiresAt };
}

/**
 * Revoke a token via `DELETE {base}/installation/token` (authenticated AS the
 * token). GitHub answers 204. A 401 means the token already expired — the desired
 * end state — so it counts as success, not an error to retry.
 */
export async function revokeInstallationToken(
  token: string,
  apiBaseUrl: string = DEFAULT_API_BASE,
  fetchImpl: TokenFetch = defaultFetch,
): Promise<void> {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/installation/token`, {
    method: 'DELETE',
    headers: githubHeaders(`token ${token}`),
  });
  if (res.status === 204 || res.status === 401) return;
  throw new Error(`GitHub token revoke failed (status ${String(res.status)})`);
}

/** One recorded mint. The value is held only long enough to revoke it. */
interface MintRecord {
  token: string;
  installationId: string;
  scope: string;
  expiresAt: Date;
  apiBaseUrl: string;
  revoked: boolean;
}

/** Metadata an event carries — NEVER the token value. */
export interface TokenEvent {
  action: 'mint' | 'revoke' | 'revoke_skipped';
  installationId: string;
  scope: string;
  expiresAt?: string;
  reason?: string;
}

/**
 * The per-job mint registry. `finalizeDevJob` calls the revoker this exposes;
 * it revokes every unexpired token the job holds, skips already-expired ones
 * (recording the skip honestly rather than hiding the gap), and appends
 * metadata-only events.
 *
 * Host-side and in-memory by design: a middleware crash loses it, and the tokens
 * self-expire within the hour — the boot reconciliation records
 * `token_revoke_skipped: process_restart` so the audit trail states the gap.
 */
export class JobTokenRegistry {
  private readonly byJob = new Map<string, MintRecord[]>();

  constructor(
    private readonly appendEvent: (jobId: string, event: TokenEvent) => Promise<void> | void,
    private readonly now: () => number = Date.now,
    private readonly revoke: typeof revokeInstallationToken = revokeInstallationToken,
  ) {}

  /** Record a freshly minted token against a job, and append a mint event. */
  async record(
    jobId: string,
    token: ScopedToken,
    meta: { installationId: string; scope: string; apiBaseUrl: string },
  ): Promise<void> {
    const list = this.byJob.get(jobId) ?? [];
    list.push({
      token: token.token,
      installationId: meta.installationId,
      scope: meta.scope,
      expiresAt: token.expiresAt,
      apiBaseUrl: meta.apiBaseUrl,
      revoked: false,
    });
    this.byJob.set(jobId, list);
    await this.appendEvent(jobId, {
      action: 'mint',
      installationId: meta.installationId,
      scope: meta.scope,
      expiresAt: token.expiresAt.toISOString(),
    });
  }

  /** The `CredentialRevoker` finalizeDevJob invokes. Best-effort per token. */
  revoker = async (job: DevJob): Promise<void> => {
    const list = this.byJob.get(job.id);
    if (!list) return;
    for (const rec of list) {
      if (rec.revoked) continue;
      rec.revoked = true; // mark first: a revoke that throws must not be retried into a loop
      if (rec.expiresAt.getTime() <= this.now()) {
        // Already dead. Say so rather than pretend we revoked it.
        await this.appendEvent(job.id, {
          action: 'revoke_skipped',
          installationId: rec.installationId,
          scope: rec.scope,
          reason: 'already_expired',
        });
        continue;
      }
      try {
        await this.revoke(rec.token, rec.apiBaseUrl);
        await this.appendEvent(job.id, {
          action: 'revoke',
          installationId: rec.installationId,
          scope: rec.scope,
        });
      } catch (err) {
        // The token self-expires within the hour; record the failed attempt.
        await this.appendEvent(job.id, {
          action: 'revoke_skipped',
          installationId: rec.installationId,
          scope: rec.scope,
          reason: `revoke_failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    // The job is terminal; drop its records so the map cannot grow unbounded.
    this.byJob.delete(job.id);
  };

  /** Test/introspection: how many unrevoked tokens a job currently holds. */
  liveCount(jobId: string): number {
    return (this.byJob.get(jobId) ?? []).filter((r) => !r.revoked).length;
  }
}
