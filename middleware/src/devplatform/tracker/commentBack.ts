/**
 * Epic #470 W2 — tracker comment-back (spec §7). GitHub Issues only in W2 (the
 * TrackerClient plugin interface is W3).
 *
 * Exactly three comment kinds, posted only when the job is bound to a ticket:
 *   - clarify: the plan summary + numbered questions + a link to the admin gate.
 *   - pr:      the PR link + one-line summary + review status.
 *   - failed:  a neutral failure notice (issue threads may be public — no stack
 *              traces, no repo internals).
 *
 * TWO idempotency layers, because either crash ordering must not double-post:
 *   1. A `comment_posted` guard recorded in dev_job_events with dedupe key
 *      (job_id, comment_kind), inserted BEFORE the HTTP POST. A retry after a
 *      recorded post is a no-op.
 *   2. For the inverted window (posted, then crashed before recording), every
 *      body embeds `<!-- omadia-dev job=<uuid> kind=<kind> -->`; before posting we
 *      list recent comments and skip on a marker match.
 */

export type CommentKind = 'clarify' | 'pr' | 'failed';

export interface CommentTarget {
  owner: string;
  repo: string;
  /** The issue number the job is bound to. */
  number: number;
}

/** Build the HTML-comment marker that survives round-tripping through GitHub. */
export function commentMarker(jobId: string, kind: CommentKind): string {
  return `<!-- omadia-dev job=${jobId} kind=${kind} -->`;
}

export interface ClarifyContent {
  planSummary: string;
  questions: Array<{ id: string; text: string }>;
  gateUrl: string;
}

export function buildClarifyBody(jobId: string, c: ClarifyContent): string {
  const lines: string[] = [commentMarker(jobId, 'clarify'), '', '**omadia dev platform — plan awaiting approval**', ''];
  lines.push(c.planSummary.trim(), '');
  if (c.questions.length > 0) {
    lines.push('**Open questions:**');
    c.questions.forEach((q, i) => lines.push(`${String(i + 1)}. ${q.text}`));
  } else {
    lines.push('_No open questions — the plan is awaiting approval._');
  }
  lines.push('', `Answer and approve in the admin UI: ${c.gateUrl}`);
  return lines.join('\n');
}

export interface PrContent {
  prUrl: string;
  summary: string;
  reviewStatus: string;
}

export function buildPrBody(jobId: string, c: PrContent): string {
  return [
    commentMarker(jobId, 'pr'),
    '',
    `**omadia dev platform — pull request opened**`,
    '',
    c.summary.trim(),
    '',
    `Review: ${c.reviewStatus}`,
    `PR: ${c.prUrl}`,
  ].join('\n');
}

export function buildFailedBody(jobId: string): string {
  // Deliberately neutral — no error text, no repo internals (public thread).
  return [
    commentMarker(jobId, 'failed'),
    '',
    `**omadia dev platform — job did not complete**`,
    '',
    `The job (\`${jobId}\`) ended without opening a pull request. An operator has the details.`,
  ].join('\n');
}

/** The two idempotency layers + the forge, injected so this stays testable. */
export interface CommentBackDeps {
  /** True if a `comment_posted` guard already exists for (jobId, kind). */
  hasPostedEvent: (jobId: string, kind: CommentKind) => Promise<boolean>;
  /** Record the guard. Returns false if it already existed (unique-conflict). */
  recordPostedEvent: (jobId: string, kind: CommentKind) => Promise<boolean>;
  /** Recent comment bodies on the issue, for the marker scan. */
  listRecentComments: (target: CommentTarget) => Promise<string[]>;
  /** Post the comment. */
  postComment: (target: CommentTarget, body: string) => Promise<void>;
  log?: (msg: string) => void;
}

export class CommentBack {
  constructor(private readonly deps: CommentBackDeps) {}

  /**
   * Post a comment, idempotently. Returns true if it posted, false if a layer
   * short-circuited (already posted). No-ops entirely when `target` is null (the
   * job is not bound to a ticket).
   */
  async post(jobId: string, kind: CommentKind, target: CommentTarget | null, body: string): Promise<boolean> {
    if (!target) return false;

    // Layer 1: the durable guard. If it exists, we already posted.
    if (await this.deps.hasPostedEvent(jobId, kind)) return false;

    // Layer 2: the marker scan, for the "posted then crashed before recording"
    // window. If the marker is already on the issue, record the guard and skip.
    const marker = commentMarker(jobId, kind);
    const recent = await this.deps.listRecentComments(target);
    if (recent.some((b) => b.includes(marker))) {
      await this.deps.recordPostedEvent(jobId, kind);
      return false;
    }

    // Record the guard BEFORE the POST. If the record loses a race (another
    // worker recorded it first), skip — the winner posts.
    const won = await this.deps.recordPostedEvent(jobId, kind);
    if (!won) return false;

    await this.deps.postComment(target, body);
    return true;
  }
}
