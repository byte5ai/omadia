import type { IssueTokenProvider } from './githubAppAuth.js';

/**
 * Direct GitHub issue creation for the native reporting channel
 * (Issue #206, v1.2). This is the one and only WRITE path to GitHub —
 * deliberately separated from the read-only `GithubIssueCache` (SRP) so
 * the cache cannot accidentally grow a create method, and so the write
 * path is the single auditable surface that needs a bearer token.
 *
 * Security posture (public-repo product):
 *   - The bearer token comes from an injected `IssueTokenProvider`
 *     (a GitHub App installation token in production). It is never
 *     logged, and error paths never echo the GitHub response body —
 *     GitHub occasionally reflects request headers, which can leak the
 *     token.
 *   - Creation is only reachable after the operator has confirmed the
 *     sanitized body (human-in-the-loop) and only into the allowlisted
 *     upstream — both gates live upstream of this class; it just does
 *     the POST.
 */

export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  /** Already sanitized + fingerprint-marked body. */
  body: string;
  labels: readonly string[];
}

export type CreateIssueResult =
  | { ok: true; number: number; url: string }
  | {
      ok: false;
      reason: 'rate_limited' | 'auth' | 'forbidden' | 'validation' | 'network' | 'unknown';
      status?: number;
    };

/** Narrow subset of the Fetch API used here. */
export type CreatorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GithubIssueCreatorOptions {
  tokenProvider: IssueTokenProvider;
  /** Fetch implementation. Defaults to global fetch. */
  fetch?: CreatorFetch;
  /** GitHub API base. Override in tests / GHES. */
  apiBaseUrl?: string;
  /** User-Agent sent to GitHub (required by the API). */
  userAgent?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'omadia-builder-bot';

export class GithubIssueCreator {
  private readonly tokenProvider: IssueTokenProvider;
  private readonly fetchImpl: CreatorFetch;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;

  constructor(opts: GithubIssueCreatorOptions) {
    this.tokenProvider = opts.tokenProvider;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    let token: string;
    try {
      token = await this.tokenProvider.getToken();
    } catch {
      return { ok: false, reason: 'auth' };
    }

    const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(
      input.owner,
    )}/${encodeURIComponent(input.repo)}/issues`;

    let response: Awaited<ReturnType<CreatorFetch>>;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          labels: [...input.labels],
        }),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (response.ok) {
      const payload = (await response.json()) as {
        number?: unknown;
        html_url?: unknown;
      };
      if (typeof payload.number !== 'number') {
        return { ok: false, reason: 'unknown', status: response.status };
      }
      const htmlUrl =
        typeof payload.html_url === 'string'
          ? payload.html_url
          : `https://github.com/${input.owner}/${input.repo}/issues/${String(
              payload.number,
            )}`;
      return { ok: true, number: payload.number, url: htmlUrl };
    }

    return { ok: false, reason: mapErrorReason(response.status), status: response.status };
  }
}

function mapErrorReason(status: number): Exclude<
  Extract<CreateIssueResult, { ok: false }>['reason'],
  'network'
> {
  if (status === 401) return 'auth';
  if (status === 403 || status === 429) return 'rate_limited';
  if (status === 404) return 'forbidden';
  if (status === 422) return 'validation';
  return 'unknown';
}

const defaultFetch: CreatorFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};
