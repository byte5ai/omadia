/**
 * Epic #470 W0 — branch-protection probe for a registered repo (spec §6).
 *
 * Reads `GET /repos/{owner}/{repo}/branches/{branch}/protection` with the
 * repo's own token. The result is deliberately TRI-STATE:
 *
 *   200 -> ok: true   the default branch is protected.
 *   404 -> ok: false  the branch has no protection — the UI warns loudly.
 *   403 -> ok: null   could not verify. A classic device-flow token usually
 *                     lacks the admin read needed to see protection settings,
 *                     so "forbidden" is not "unprotected" — it is "unknown".
 *
 * Any other status throws. The error never echoes the response body: an
 * auth-endpoint error can reflect the bearer token back (house style, cf.
 * `plugins/builder/githubAppAuth.ts`).
 */

/** Narrow subset of the Fetch API used here — keeps test doubles small. */
export type BranchProtectionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number }>;

export interface BranchProtectionResult {
  /** true = protected; false = unprotected (404); null = could not verify (403). */
  ok: boolean | null;
  checkedAt: Date;
}

export interface BranchProtectionCheckInput {
  owner: string;
  repo: string;
  /** Usually the default branch. Slashes in the name are preserved. */
  branch: string;
  token: string;
  fetchImpl?: BranchProtectionFetch;
  apiBaseUrl?: string;
  userAgent?: string;
  now?: () => Date;
}

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'omadia-dev-platform';

const defaultFetch: BranchProtectionFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

/** Encode each path segment but keep `/` in a `feature/x` style branch name. */
function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

export async function checkBranchProtection(
  input: BranchProtectionCheckInput,
): Promise<BranchProtectionResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const apiBaseUrl = (input.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const userAgent = input.userAgent ?? DEFAULT_USER_AGENT;
  const now = input.now ?? (() => new Date());

  const url = `${apiBaseUrl}/repos/${encodeURIComponent(
    input.owner,
  )}/${encodeURIComponent(input.repo)}/branches/${encodeBranch(
    input.branch,
  )}/protection`;

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
    },
  });

  const checkedAt = now();
  if (res.status === 200) return { ok: true, checkedAt };
  if (res.status === 404) return { ok: false, checkedAt };
  if (res.status === 403) return { ok: null, checkedAt };

  // Never include the response body — it can echo the token back.
  throw new Error(
    `branch-protection check failed (status ${String(res.status)})`,
  );
}
