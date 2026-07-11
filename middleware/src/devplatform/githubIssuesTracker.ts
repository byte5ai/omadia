/**
 * Epic #470 W0 — read tickets from a repo's GitHub Issues tracker (spec §7).
 *
 * `getTicket` and `listOpenTickets` back the "fix this issue" job source. Pull
 * requests surface on the issues endpoint too and carry a `pull_request` key —
 * they are filtered out so a PR is never mistaken for a bug report.
 *
 * The tracker talks to the GitHub REST API through an injected `fetchImpl`
 * (default: global fetch), so no octokit dependency and no coupling to the
 * forge-apply client. Only the fields the brief needs are surfaced, each parsed
 * defensively.
 */

/** Which repo to read. Owner/name mirror `DevRepo`. */
export interface TrackerRepo {
  owner: string;
  name: string;
}

/** The subset of a GitHub issue the dev platform consumes. */
export interface Ticket {
  number: number;
  title: string;
  body: string;
  labels: string[];
  htmlUrl: string;
  authorLogin: string;
}

/** Narrow subset of the Fetch API used here — keeps test doubles small. */
export type IssuesFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GithubIssuesTrackerOptions {
  token: string;
  fetchImpl?: IssuesFetch;
  apiBaseUrl?: string;
  userAgent?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'omadia-dev-platform';

interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  html_url?: unknown;
  user?: unknown;
  /** Present (and non-null) only when the "issue" is actually a PR. */
  pull_request?: unknown;
}

function isPullRequest(raw: RawIssue): boolean {
  return raw.pull_request !== undefined && raw.pull_request !== null;
}

function labelName(label: unknown): string {
  if (typeof label === 'string') return label;
  const name = (label as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

function toTicket(raw: RawIssue): Ticket {
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map(labelName).filter((n): n is string => n.length > 0)
    : [];
  const user = raw.user as { login?: unknown } | null | undefined;
  return {
    number: typeof raw.number === 'number' ? raw.number : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    labels,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
    authorLogin: user && typeof user.login === 'string' ? user.login : '',
  };
}

const defaultFetch: IssuesFetch = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
  };
};

export class GithubIssuesTracker {
  private readonly token: string;
  private readonly fetchImpl: IssuesFetch;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;

  constructor(opts: GithubIssuesTrackerOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** Fetch one ticket. Throws if the number resolves to a pull request. */
  async getTicket(repo: TrackerRepo, issueNumber: number): Promise<Ticket> {
    const raw = (await this.request(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(
        repo.name,
      )}/issues/${encodeURIComponent(String(issueNumber))}`,
    )) as RawIssue;
    if (isPullRequest(raw)) {
      throw new Error(
        `#${String(issueNumber)} is a pull request, not an issue`,
      );
    }
    return toTicket(raw);
  }

  /**
   * List open tickets, newest first (GitHub's default order). Pull requests are
   * filtered out, so fewer than `limit` tickets may come back when the page
   * mixed in PRs — acceptable for W0.
   */
  async listOpenTickets(
    repo: TrackerRepo,
    opts: { limit: number },
  ): Promise<Ticket[]> {
    const perPage = Math.max(1, Math.min(100, Math.trunc(opts.limit)));
    const raw = await this.request(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(
        repo.name,
      )}/issues?state=open&per_page=${String(perPage)}`,
    );
    const rows = Array.isArray(raw) ? (raw as RawIssue[]) : [];
    return rows
      .filter((r) => !isPullRequest(r))
      .slice(0, perPage)
      .map(toTicket);
  }

  private async request(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
      },
    });
    if (!res.ok) {
      // No body echo — an auth error can reflect the token.
      throw new Error(
        `github issues endpoint failed (status ${String(res.status)})`,
      );
    }
    return res.json();
  }
}
