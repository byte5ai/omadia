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
 *   3. Run the AUTHORITATIVE diff policy (`evaluateDiffPolicy`, spec §6) over the
 *      full input — the diff, the parsed numstat, the outbound PR body + tracker
 *      comments, the repo's overrides, and the job's own tokens. `allow` applies;
 *      `deny`/`gate` throw a `DiffApplyError` carrying the verdict findings (the
 *      caller finalises the job `failed` on deny, or opens a human gate on gate).
 *   4. `forge.applyDiff` builds blobs → tree (base = pinned base_sha) → commit →
 *      a fresh ref; then `forge.createPR`. The forge receives the SAME parsed
 *      change set the policy evaluated, so what a human approves and what lands on
 *      the branch are byte-identical by construction.
 */

import {
  parseUnifiedDiffDetailed,
  type DiffFileChange,
} from './policy/parseUnifiedDiff.js';
import {
  evaluateDiffPolicy,
  type DiffPolicyInput as EngineDiffPolicyInput,
  type DiffPolicyOverrides,
  type NumstatEntry,
  type PolicyVerdict,
} from './policy/diffPolicyEngine.js';
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
  /** The repo's operator diff-policy overrides (`dev_repos.policy_overrides`).
   *  Absent ⇒ code defaults; can never remove a `deny` rule. */
  policyOverrides?: DiffPolicyOverrides;
  /** Outbound tracker comments to scan for secrets. Empty/absent at apply time
   *  when comments are posted only after the PR opens. */
  trackerComments?: string[];
  /** The job's own token/nonce values, scanned so a runner cannot exfiltrate its
   *  own credential in the diff. Optional HERE so the many byte-identity tests
   *  need no churn; the engine ALWAYS receives a concrete array (its own-token
   *  detector is fail-closed). The worker threads the real values. */
  jobTokens?: string[];
  /** A repo authority approved the diff-policy gate (W3): forwarded to the engine
   *  so `gate`-severity findings are demoted on this re-apply. Deny findings are
   *  unaffected — a deny still aborts the apply. Absent ⇒ normal verdict. */
  operatorApprovedGate?: boolean;
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

/**
 * The apply gate (Epic #470 W3). `apply()` calls this with the FULL engine input
 * and honours the verdict. Defaults to the real `evaluateDiffPolicy`; a test may
 * inject a stub. Retiring the W0 `allowAllPolicy` seam: the real engine is now the
 * one that runs.
 */
export type DiffPolicyEvaluator = (input: EngineDiffPolicyInput) => PolicyVerdict;

export class DiffApplyError extends Error {
  constructor(
    readonly code: 'numstat_mismatch' | 'path_escape' | 'policy_deny' | 'policy_gate',
    message: string,
    /** For `policy_deny`/`policy_gate`: the engine verdict, so the caller can
     *  persist its findings (deny → audit artifact; gate → gate questions). */
    readonly verdict?: PolicyVerdict,
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
  /** The apply gate. Defaults to the real `evaluateDiffPolicy`. */
  policy?: DiffPolicyEvaluator;
  author?: GitIdentity;
}

export class DiffApplyService {
  private readonly forge: ForgeClient;
  private readonly policy: DiffPolicyEvaluator;
  private readonly author: GitIdentity;

  constructor(opts: DiffApplyServiceOptions) {
    this.forge = opts.forge;
    this.policy = opts.policy ?? evaluateDiffPolicy;
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

    // 3. The AUTHORITATIVE diff policy (spec §6). Runs over the full engine input,
    //    reasoning ONLY over the parsed diff, the uploaded numstat, and outbound
    //    text — never an LLM's say-so. `deny`/`gate` abort BEFORE any forge write;
    //    the verdict rides the error so the caller can persist findings / open a
    //    gate. The numstat + path-escape hard checks above are kept as defense in
    //    depth (the engine's diff-integrity + git-internals rules also cover them).
    const verdict = this.policy({
      diff: input.diff,
      numstat: parseNumstatEntries(input.numstat),
      prBody: input.pr.body,
      trackerComments: input.trackerComments ?? [],
      ...(input.policyOverrides ? { policyOverrides: input.policyOverrides } : {}),
      jobTokens: input.jobTokens ?? [],
      ...(input.operatorApprovedGate ? { operatorApprovedGate: true } : {}),
    });
    if (verdict.decision === 'deny') {
      throw new DiffApplyError('policy_deny', policyMessage('denied', verdict), verdict);
    }
    if (verdict.decision === 'gate') {
      throw new DiffApplyError('policy_gate', policyMessage('gated', verdict), verdict);
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

/** Parse a `git diff --numstat` blob into the engine's structured entries.
 *  Binary rows (`-\t-\t…`) carry additions/deletions 0 and `binary: true`. */
function parseNumstatEntries(numstat: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  for (const raw of numstat.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = parts[0] ?? '';
    const d = parts[1] ?? '';
    out.push({
      path: parts.slice(2).join('\t'),
      additions: a === '-' ? 0 : Number.parseInt(a, 10) || 0,
      deletions: d === '-' ? 0 : Number.parseInt(d, 10) || 0,
      binary: a === '-' && d === '-',
    });
  }
  return out;
}

/** A short human-readable policy message naming the rules that fired. */
function policyMessage(disposition: 'denied' | 'gated', verdict: PolicyVerdict): string {
  const rules = verdict.findings.map((f) => f.ruleId).join(', ') || 'policy';
  return `diff ${disposition} by policy (${rules})`;
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
