/**
 * Epic #470 W0 — server-side diff apply (spec §8). This is the security guarantee
 * of the epic: the runner uploads a diff + `--numstat`, never a write token and
 * never a push. The middleware parses the diff, cross-checks it, and only then
 * asks the forge to build the commit FROM that validated change set — so what a
 * human reviewed and what lands on the branch are the same object by construction.
 *
 * apply():
 *   1. Parse the diff and cross-check its totals against the uploaded numstat.
 *      A mismatch aborts BEFORE any forge write — a runner must not be able to
 *      understate its own diff. (W3 turns this into a policy `gate`; W0 = hard fail.)
 *   2. Refuse any path escaping the repo (`..`, absolute) — a `deny`, not a gate.
 *   3. Run the `DiffPolicyEngine` seam. W0 ships `allowAllPolicy`; W3 adds rules
 *      here, not plumbing.
 *   4. `forge.applyDiff` builds blobs → tree (base = pinned base_sha) → commit →
 *      a fresh ref; then `forge.createPR`.
 */

import {
  parseUnifiedDiffDetailed,
  type DiffFileChange,
} from './policy/parseUnifiedDiff.js';
import type { ForgeClient, ForgeFileChange, GitIdentity } from './forgeClient.js';

export interface ApplyJob {
  id: string;
  /** Precomputed short branch name, e.g. `omadia/job-<id8>-<slug>`. */
  branch: string;
  /** Pinned tree the diff applies onto. */
  baseSha: string;
}

export interface ApplyRepo {
  owner: string;
  name: string;
  /** PR base branch. */
  defaultBranch: string;
}

export interface ApplyInput {
  job: ApplyJob;
  repo: ApplyRepo;
  diff: string;
  /** The runner's `git diff --numstat` output. */
  numstat: string;
  pr: { title: string; body: string };
}

export interface ApplyResult {
  prUrl: string;
  prNumber: number;
  commitSha: string;
  branch: string;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export type PolicyDecision = 'allow' | 'deny' | 'gate';

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: string;
  stats: DiffStats;
}

export interface DiffPolicyInput {
  files: DiffFileChange[];
  stats: DiffStats;
}

/**
 * The W3 seam. Shipping it in W0 means W3 adds rules, not plumbing. The default
 * `allowAllPolicy` returns `allow` with the stats.
 */
export interface DiffPolicyEngine {
  evaluate(input: DiffPolicyInput): PolicyResult;
}

export const allowAllPolicy: DiffPolicyEngine = {
  evaluate: (input) => ({ decision: 'allow', stats: input.stats }),
};

export class DiffApplyError extends Error {
  constructor(
    readonly code: 'numstat_mismatch' | 'path_escape' | 'policy_deny' | 'policy_gate',
    message: string,
  ) {
    super(message);
    this.name = 'DiffApplyError';
  }
}

export const DEFAULT_COMMIT_AUTHOR: GitIdentity = {
  name: 'omadia-dev',
  email: 'dev-platform@omadia.ai',
};

/** Parse `DEV_PLATFORM_COMMIT_AUTHOR` (`Name <email>`); falls back to the default. */
export function parseGitIdentity(spec: string): GitIdentity {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(spec);
  if (m && m[1] && m[2]) return { name: m[1], email: m[2] };
  return DEFAULT_COMMIT_AUTHOR;
}

export interface DiffApplyServiceOptions {
  forge: ForgeClient;
  policy?: DiffPolicyEngine;
  author?: GitIdentity;
}

export class DiffApplyService {
  private readonly forge: ForgeClient;
  private readonly policy: DiffPolicyEngine;
  private readonly author: GitIdentity;

  constructor(opts: DiffApplyServiceOptions) {
    this.forge = opts.forge;
    this.policy = opts.policy ?? allowAllPolicy;
    this.author = opts.author ?? DEFAULT_COMMIT_AUTHOR;
  }

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const files = parseUnifiedDiffDetailed(input.diff);

    // 1. Numstat cross-check — the one gate that must run before any write.
    const parsed = diffTotals(files);
    const claimed = numstatTotals(input.numstat);
    if (
      parsed.files !== claimed.files ||
      parsed.additions !== claimed.additions ||
      parsed.deletions !== claimed.deletions
    ) {
      throw new DiffApplyError(
        'numstat_mismatch',
        `parsed diff totals (${statString(parsed)}) do not match uploaded numstat (${statString(claimed)})`,
      );
    }

    // 2. Path-escape is a hard deny — a security invariant, not a policy gate.
    for (const f of files) {
      for (const p of [f.path, f.oldPath]) {
        if (p !== undefined && !isRepoRelative(p)) {
          throw new DiffApplyError('path_escape', `refusing diff: path escapes repository: ${p}`);
        }
      }
    }

    // 3. Policy seam (W0: allow).
    const verdict = this.policy.evaluate({ files, stats: parsed });
    if (verdict.decision === 'deny') {
      throw new DiffApplyError('policy_deny', verdict.reason ?? 'diff denied by policy');
    }
    if (verdict.decision === 'gate') {
      throw new DiffApplyError('policy_gate', verdict.reason ?? 'diff requires a gate');
    }

    // 4. Build the commit from the validated diff, then open the PR.
    const forgeFiles: ForgeFileChange[] = files.map((f) => {
      const change: ForgeFileChange = {
        path: f.path,
        change: f.change,
        binary: f.binary,
        hunks: f.hunks,
      };
      if (f.oldPath !== undefined) change.oldPath = f.oldPath;
      if (f.mode !== undefined) change.mode = f.mode;
      return change;
    });

    const applied = await this.forge.applyDiff({
      owner: input.repo.owner,
      repo: input.repo.name,
      baseSha: input.job.baseSha,
      branch: input.job.branch,
      message: input.pr.title,
      author: this.author,
      files: forgeFiles,
    });

    const pr = await this.forge.createPR({
      owner: input.repo.owner,
      repo: input.repo.name,
      head: input.job.branch,
      base: input.repo.defaultBranch,
      title: input.pr.title,
      body: input.pr.body,
    });

    return {
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      commitSha: applied.commitSha,
      branch: input.job.branch,
    };
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function diffTotals(files: DiffFileChange[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

/** Sum a `git diff --numstat` blob. Binary rows (`-\t-\t…`) contribute 0/0. */
function numstatTotals(numstat: string): DiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const raw of numstat.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files++;
    const a = parts[0] ?? '';
    const d = parts[1] ?? '';
    if (a !== '-') additions += Number.parseInt(a, 10) || 0;
    if (d !== '-') deletions += Number.parseInt(d, 10) || 0;
  }
  return { files, additions, deletions };
}

function isRepoRelative(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // Windows absolute (C:\…)
  for (const seg of p.split('/')) {
    if (seg === '..') return false;
    // `.git` is never a legal tree component — writing into it (hooks, config)
    // is a local invariant, not something to delegate to the forge's rejection.
    if (seg.toLowerCase() === '.git') return false;
  }
  return true;
}

function statString(s: DiffStats): string {
  return `${s.files} files, +${s.additions}, -${s.deletions}`;
}
