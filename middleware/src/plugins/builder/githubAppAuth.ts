import { createSign } from 'node:crypto';

/**
 * GitHub App authentication for the native direct-create path
 * (Issue #206, concept plan: docs/plans/native-issue-reporting.md — v1.2).
 *
 * Why a GitHub App and not a PAT for an OPEN-SOURCE product:
 *
 *   - Installation tokens are short-lived (≈1 h) and auto-rotating, so a
 *     leak from the operator's own infra has a small blast radius and is
 *     centrally revocable by uninstalling the App.
 *   - The App is scoped to `issues:write` on exactly the target repo —
 *     it cannot push code, read private repos, or touch other repos.
 *   - Issues are attributed to the App identity (`…[bot]`), not a human.
 *
 * The App credentials (app id, PEM private key, installation id) are a
 * DEPLOYMENT secret read from the environment — exactly like the
 * Anthropic API key or DB password. They never live in the public repo,
 * never ship in the web-ui bundle, and are never logged. omadia ships
 * with NO credentials by default → the direct-create path stays off and
 * the agent falls back to browser-submit.
 *
 * This module mints the short JWT (RS256, signed with the App private
 * key) and exchanges it for an installation access token, caching the
 * token until shortly before it expires. No third-party dependency: the
 * JWT is assembled with `node:crypto`.
 */

export interface GitHubAppConfig {
  /** Numeric GitHub App id (string form to avoid precision loss). */
  appId: string;
  /** PEM-encoded RSA private key (PKCS#1 or PKCS#8). */
  privateKey: string;
  /** Installation id the App is installed under on the target repo. */
  installationId: string;
}

/**
 * Minimal contract the issue creator depends on. Implementations return
 * a bearer token valid for the next REST call. Kept narrow so a static
 * PAT provider could be swapped in later without touching the creator.
 */
export interface IssueTokenProvider {
  getToken(): Promise<string>;
}

/** Narrow subset of the Fetch API used here — keeps test doubles small. */
export type AppAuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GitHubAppTokenProviderOptions {
  config: GitHubAppConfig;
  /** Fetch implementation. Defaults to global fetch. */
  fetch?: AppAuthFetch;
  /** Clock injection point for tests. */
  now?: () => number;
  /** GitHub API base. Override in tests / GHES. */
  apiBaseUrl?: string;
  /** User-Agent sent to GitHub (required by the API). */
  userAgent?: string;
}

/** Refresh the installation token this far before its stated expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** JWT lifetime. GitHub caps App JWTs at 10 minutes; stay under it. */
const JWT_TTL_SECONDS = 9 * 60;
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'omadia-builder-bot';

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must be refreshed (expiry − skew). */
  refreshAfter: number;
}

export class GitHubAppTokenProvider implements IssueTokenProvider {
  private readonly config: GitHubAppConfig;
  private readonly fetchImpl: AppAuthFetch;
  private readonly now: () => number;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private cached: CachedToken | null = null;
  /** Coalesces concurrent refreshes so a burst of tool calls mints once. */
  private inflight: Promise<string> | null = null;

  constructor(opts: GitHubAppTokenProviderOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.now = opts.now ?? (() => Date.now());
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAfter) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const jwt = this.mintJwt();
    const url = `${this.apiBaseUrl}/app/installations/${encodeURIComponent(
      this.config.installationId,
    )}/access_tokens`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
      },
    });
    if (!response.ok) {
      // Never include the response body — it can echo back the JWT.
      throw new Error(
        `GitHub App token exchange failed (status ${String(response.status)})`,
      );
    }
    const payload = (await response.json()) as {
      token?: unknown;
      expires_at?: unknown;
    };
    if (typeof payload.token !== 'string' || payload.token.length === 0) {
      throw new Error('GitHub App token exchange returned no token');
    }
    const expiresAtMs =
      typeof payload.expires_at === 'string'
        ? Date.parse(payload.expires_at)
        : NaN;
    // Fall back to a conservative 50-minute window if GitHub omits/garbles
    // the expiry, so a parse miss never pins a stale token forever.
    const refreshAfter = Number.isFinite(expiresAtMs)
      ? expiresAtMs - EXPIRY_SKEW_MS
      : this.now() + 50 * 60 * 1000;
    this.cached = { token: payload.token, refreshAfter };
    return payload.token;
  }

  private mintJwt(): string {
    const issuedAt = Math.floor(this.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      // Backdate 30 s to tolerate minor clock skew against GitHub.
      iat: issuedAt - 30,
      exp: issuedAt + JWT_TTL_SECONDS,
      iss: this.config.appId,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
      JSON.stringify(payload),
    )}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.config.privateKey)
      .toString('base64url');
    return `${signingInput}.${signature}`;
  }
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

const defaultFetch: AppAuthFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};
