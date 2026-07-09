/**
 * Epic #470 W0 — GitHub implementation of `ForgeClient` (spec §8).
 *
 * House style: hand-rolled fetch, no octokit (there is none in this repo, and
 * this is not the unit that adds one). Every git-data write goes through one
 * `gh()` helper that attaches the bearer + the required GitHub headers. On any
 * non-2xx we throw WITHOUT the response body: GitHub can reflect request headers
 * (including the token) back in errors — echoing the body is a token-leak hazard.
 * This mirrors `githubAppAuth.ts` / `githubIssueCreator.ts`.
 *
 * `applyDiff` reconstructs committed content itself: for a modify/rename/copy it
 * fetches the base blob at the pinned `base_sha` and applies the validated hunks,
 * so the bytes come from base ⊕ diff and nothing the runner uploaded as content
 * is trusted. The `contents:write` credential is supplied host-side (W0: the
 * repo's own device-flow/PAT); it never enters a container.
 */

import { applyHunks } from './policy/parseUnifiedDiff.js';
import {
  NotImplementedError,
  type ApplyDiffInput,
  type ApplyDiffResult,
  type CommentIssueInput,
  type CreateIssueInput,
  type CreatePrInput,
  type CreatePrResult,
  type ForgeClient,
  type ForgeFileChange,
  type ForgeIssue,
} from './forgeClient.js';

/** Narrow subset of the Fetch API used here — keeps test doubles small. */
export type ForgeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GithubForgeClientOptions {
  /** Short-lived `contents:write` bearer, minted + revoked host-side by the caller. */
  token: string;
  /** Fetch implementation. Defaults to global fetch. */
  fetch?: ForgeFetch;
  /** GitHub API base. Override in tests / GHES. */
  apiBaseUrl?: string;
  /** User-Agent sent to GitHub (required by the API). */
  userAgent?: string;
  /** Clock injection point for the commit date. */
  now?: () => Date;
}

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'omadia-dev-platform';
/**
 * Default file mode. Hardcoding a regular-file mode neutralizes symlink
 * (`120000`) and gitlink (`160000`) entries — a diff cannot smuggle a symlink
 * or submodule pointer into the tree. `resolveMode` preserves a diff-declared
 * `100755` and refuses `120000`/`160000` outright. SPEC DELTA: an EXISTING
 * `100755` file that is only edited carries no mode line in the diff, so its
 * executable bit is not preserved and it lands as `100644` (see SPEC DELTAS).
 */
const BLOB_MODE = '100644';
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob';
  /** `null` deletes the path relative to `base_tree`. */
  sha: string | null;
}

/** A file resolved in the read phase, awaiting its blob write in the write phase. */
interface ResolvedUpsert {
  path: string;
  content: string;
  mode: string;
  /** Old path to delete for a rename. */
  deleteOld?: string;
}

/** Non-2xx from GitHub. Deliberately carries NO response body. */
export class ForgeHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`GitHub ${method} ${path} failed (status ${String(status)})`);
    this.name = 'ForgeHttpError';
  }
}

/** A well-formed 2xx whose payload was not what we required. */
export class ForgeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeResponseError';
  }
}

/** The diff declares a git mode (symlink/gitlink) this apply refuses to commit. */
export class UnsupportedModeError extends Error {
  constructor(
    readonly path: string,
    readonly mode: string,
  ) {
    super(`refusing diff: unsupported git mode ${mode} for ${path}`);
    this.name = 'UnsupportedModeError';
  }
}

/** A job branch is always `omadia/job-<something>`; nothing else may be created. */
export class InvalidJobBranchError extends Error {
  constructor(readonly branch: string) {
    super(`refusing to create a ref outside omadia/job-*: ${JSON.stringify(branch)}`);
    this.name = 'InvalidJobBranchError';
  }
}

const JOB_BRANCH_RE = /^omadia\/job-[A-Za-z0-9._-]+$/;

/** Throws unless `branch` is a well-formed job branch. No `..`, no leading dash, no ref trickery. */
export function assertJobBranch(branch: string): void {
  if (!JOB_BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    throw new InvalidJobBranchError(branch);
  }
}

export class GithubForgeClient implements ForgeClient {
  private readonly token: string;
  private readonly fetchImpl: ForgeFetch;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly now: () => Date;

  constructor(opts: GithubForgeClientOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.now = opts.now ?? (() => new Date());
  }

  async applyDiff(input: ApplyDiffInput): Promise<ApplyDiffResult> {
    const repoBase = `/repos/${enc(input.owner)}/${enc(input.repo)}`;

    // Pre-scan: refuse binary and symlink/gitlink modes with ZERO forge calls.
    for (const f of input.files) {
      if (f.change === 'delete') continue;
      if (f.binary) {
        // A textual diff carries no bytes for a binary file, so committing it
        // would fabricate content. Refuse rather than guess. (See SPEC DELTAS.)
        throw new NotImplementedError(`binary file apply is not supported in W0: ${f.path}`);
      }
      resolveMode(f); // throws UnsupportedModeError for 120000 / 160000
    }

    // Phase 1 — READS ONLY. Reconstruct + verify every file against the pinned
    // base. `applyHunks` fails closed on a context/deletion mismatch, so an
    // adversarial diff aborts HERE, before any write — exactly like a numstat
    // mismatch. No blob is created until every file is reconstructed.
    const upserts: ResolvedUpsert[] = [];
    const deletions: string[] = [];
    for (const f of input.files) {
      if (f.change === 'delete') {
        deletions.push(f.path);
        continue;
      }
      const baseContent =
        f.change === 'add' ? '' : await this.readFile(repoBase, f.oldPath ?? f.path, input.baseSha);
      const content = applyHunks(baseContent, f.hunks, { path: f.path });
      const up: ResolvedUpsert = { path: f.path, content, mode: resolveMode(f) };
      if (f.change === 'rename' && f.oldPath && f.oldPath !== f.path) up.deleteOld = f.oldPath;
      upserts.push(up);
    }

    // Phase 2 — WRITES. Every byte below derives from base_sha ⊕ validated diff.
    const entries: TreeEntry[] = [];
    for (const u of upserts) {
      const sha = await this.createBlob(repoBase, u.content);
      entries.push({ path: u.path, mode: u.mode, type: 'blob', sha });
      if (u.deleteOld) entries.push({ path: u.deleteOld, mode: BLOB_MODE, type: 'blob', sha: null });
    }
    for (const path of deletions) {
      entries.push({ path, mode: BLOB_MODE, type: 'blob', sha: null });
    }

    // Tree pinned to the reviewed base — this is the content-binding guarantee.
    const tree = asRecord(
      await this.gh('POST', `${repoBase}/git/trees`, {
        base_tree: input.baseSha,
        tree: entries,
      }),
    );
    const treeSha = requireString(tree.sha, 'git/trees returned no sha');

    const commit = asRecord(
      await this.gh('POST', `${repoBase}/git/commits`, {
        message: input.message,
        tree: treeSha,
        parents: [input.baseSha],
        author: {
          name: input.author.name,
          email: input.author.email,
          date: this.now().toISOString(),
        },
      }),
    );
    const commitSha = requireString(commit.sha, 'git/commits returned no sha');

    // Create — never update. A job branch is always fresh.
    //
    // The prefix is enforced here rather than trusted from the caller. `POST
    // /git/refs` cannot move an existing ref, so a bad name could not hijack
    // `main` — but it could create an arbitrary branch, and "only a fresh
    // omadia/job-* ref is ever created" should be a property of this code, not
    // a property of whoever calls it.
    assertJobBranch(input.branch);
    const branchRef = `refs/heads/${input.branch}`;
    await this.gh('POST', `${repoBase}/git/refs`, { ref: branchRef, sha: commitSha });

    return { commitSha, treeSha, branchRef };
  }

  async createPR(input: CreatePrInput): Promise<CreatePrResult> {
    const data = asRecord(
      await this.gh('POST', `/repos/${enc(input.owner)}/${enc(input.repo)}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        maintainer_can_modify: true,
      }),
    );
    const prNumber = data.number;
    const prUrl = data.html_url;
    if (typeof prNumber !== 'number' || typeof prUrl !== 'string') {
      throw new ForgeResponseError('pull creation returned an unexpected payload');
    }
    return { prUrl, prNumber };
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<ForgeIssue> {
    const data = await this.gh(
      'GET',
      `/repos/${enc(owner)}/${enc(repo)}/issues/${String(issueNumber)}`,
    );
    return toIssue(data, owner, repo);
  }

  async listOpenIssues(owner: string, repo: string): Promise<ForgeIssue[]> {
    const data = await this.gh(
      'GET',
      `/repos/${enc(owner)}/${enc(repo)}/issues?state=open&per_page=100`,
    );
    if (!Array.isArray(data)) return [];
    // The issues endpoint mixes in PRs; drop anything carrying `pull_request`.
    return data
      .filter((r): r is Record<string, unknown> => isRecord(r) && !('pull_request' in r))
      .map((r) => toIssue(r, owner, repo));
  }

  async createIssue(_input: CreateIssueInput): Promise<ForgeIssue> {
    throw new NotImplementedError('createIssue is not implemented in W0');
  }

  async commentIssue(_input: CommentIssueInput): Promise<void> {
    throw new NotImplementedError('commentIssue is not implemented in W0');
  }

  private async readFile(repoBase: string, path: string, ref: string): Promise<string> {
    const data = asRecord(
      await this.gh('GET', `${repoBase}/contents/${encPath(path)}?ref=${enc(ref)}`),
    );
    const content = data.content;
    if (typeof content !== 'string') {
      throw new ForgeResponseError(`contents API returned no content for ${path}`);
    }
    const encoding = data.encoding === 'base64' ? 'base64' : 'utf8';
    return Buffer.from(content, encoding as BufferEncoding).toString('utf8');
  }

  private async createBlob(repoBase: string, content: string): Promise<string> {
    // Text content ships as utf-8. Binary would ship base64 here — refused above
    // in W0 because a textual diff carries no bytes to encode.
    const data = asRecord(
      await this.gh('POST', `${repoBase}/git/blobs`, { content, encoding: 'utf-8' }),
    );
    return requireString(data.sha, 'git/blobs returned no sha');
  }

  private async gh(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      // Never read/echo the body — it can reflect the Authorization header.
      throw new ForgeHttpError(method, path, res.status);
    }
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Pick the tree mode for a changed file. Preserves a diff-declared executable
 * bit; refuses symlink/gitlink outright; defaults everything else to a regular
 * file (fail-safe: never CREATE a `120000`/`160000` entry we did not verify).
 */
function resolveMode(f: ForgeFileChange): string {
  const m = f.mode;
  if (m === SYMLINK_MODE || m === GITLINK_MODE) throw new UnsupportedModeError(f.path, m);
  if (m === '100755') return '100755';
  return BLOB_MODE;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** Encode a repo-relative path for a URL while preserving `/` separators. */
function encPath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new ForgeResponseError('expected a JSON object from GitHub');
  return v;
}

function requireString(v: unknown, message: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new ForgeResponseError(message);
  return v;
}

function toIssue(raw: unknown, owner: string, repo: string): ForgeIssue {
  const r = isRecord(raw) ? raw : {};
  const number = typeof r.number === 'number' ? r.number : 0;
  const labels = Array.isArray(r.labels)
    ? r.labels
        .map((l) => (typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : ''))
        .filter((l) => l !== '')
    : [];
  return {
    number,
    title: typeof r.title === 'string' ? r.title : '',
    body: typeof r.body === 'string' ? r.body : '',
    state: typeof r.state === 'string' ? r.state : '',
    url:
      typeof r.html_url === 'string'
        ? r.html_url
        : `https://github.com/${owner}/${repo}/issues/${String(number)}`,
    labels,
  };
}

const defaultFetch: ForgeFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};
