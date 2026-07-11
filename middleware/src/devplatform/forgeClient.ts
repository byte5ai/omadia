/**
 * Epic #470 W0 — the forge abstraction the dev platform commits through.
 *
 * `ForgeClient` is the seam between `diffApplyService` (which validates a diff
 * host-side) and a concrete forge. The W0 implementation is
 * `GithubForgeClient`. The security guarantee of the whole epic lives on the
 * far side of `applyDiff`: the middleware hands over a *parsed, validated*
 * change set and the forge builds the commit from it, so what a human reviewed
 * and what lands on the branch are the same object by construction. The runner
 * never holds a write token and never pushes.
 *
 * `createIssue`/`commentIssue` are part of the contract but unused in W0 — they
 * throw `NotImplementedError`. A later wave (write-back to the tracker) fills
 * them in without widening this interface.
 */

import type { DiffChange, DiffHunk } from './policy/parseUnifiedDiff.js';

/** Git commit identity (author/committer). Parsed from `DEV_PLATFORM_COMMIT_AUTHOR`. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * One file's validated change, ready for the forge to materialize. Carries the
 * hunks (not reconstructed content): the forge fetches the pinned base blob and
 * applies the hunks itself, so the committed bytes derive from base_sha ⊕ diff
 * and nothing the runner uploaded as content is trusted.
 */
export interface ForgeFileChange {
  path: string;
  /** Source path for `rename`/`copy`; absent otherwise. */
  oldPath?: string;
  change: DiffChange;
  binary: boolean;
  hunks: DiffHunk[];
  /** Git mode the diff declares, if any (e.g. `100755`, `120000`). */
  mode?: string;
}

export interface ApplyDiffInput {
  owner: string;
  repo: string;
  /** Pinned tree the change is applied onto — becomes the tree's `base_tree`. */
  baseSha: string;
  /** Short branch name, e.g. `omadia/job-<id8>-<slug>`; created as a fresh ref. */
  branch: string;
  message: string;
  author: GitIdentity;
  files: ForgeFileChange[];
}

export interface ApplyDiffResult {
  commitSha: string;
  treeSha: string;
  /** Full ref that was created, e.g. `refs/heads/omadia/job-...`. */
  branchRef: string;
}

export interface CreatePrInput {
  owner: string;
  repo: string;
  /** Head branch (the freshly created job branch). */
  head: string;
  /** Base branch the PR targets (the repo default). */
  base: string;
  title: string;
  body: string;
}

export interface CreatePrResult {
  prUrl: string;
  prNumber: number;
}

/** A read-only view of a tracker issue (the brief source). */
export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
}

/** Unused in W0 — reserved for tracker write-back. */
export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

/** Unused in W0 — reserved for tracker write-back. */
export interface CommentIssueInput {
  owner: string;
  repo: string;
  number: number;
  body: string;
}

/** Thrown by the W0-unimplemented methods. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export interface ForgeClient {
  /**
   * Build blobs → tree (base_tree = baseSha) → commit → a FRESH ref, in that
   * order, from the validated change set. Never updates an existing ref.
   */
  applyDiff(input: ApplyDiffInput): Promise<ApplyDiffResult>;
  /**
   * Resolve a ref (a branch name) to the commit sha it points at, right now.
   *
   * This is what makes "applied onto the pinned base tree" true rather than
   * aspirational. Without it `base_sha` stays NULL, and the apply reads the
   * default branch's CURRENT tip — a different tree than the one the agent
   * cloned and reasoned about. `applyHunks` fails closed on the resulting
   * context mismatch, so the damage is a mysterious failure rather than a
   * corrupt commit; but a diff must be evaluated against the tree it was made
   * against, not against whatever `main` happens to be at apply time.
   */
  getRef(owner: string, repo: string, ref: string): Promise<string>;
  createPR(input: CreatePrInput): Promise<CreatePrResult>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<ForgeIssue>;
  listOpenIssues(owner: string, repo: string): Promise<ForgeIssue[]>;
  /** W0: throws `NotImplementedError`. */
  createIssue(input: CreateIssueInput): Promise<ForgeIssue>;
  /** W0: throws `NotImplementedError`. */
  commentIssue(input: CommentIssueInput): Promise<void>;
}
