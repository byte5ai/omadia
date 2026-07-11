import { createHash } from 'node:crypto';

/**
 * Epic #470 W2 — the bounded review→implement loop (spec §6).
 *
 * A fresh CLI session reviews the diff as an adversary ("you did not write this")
 * and returns a verdict. This module is the pure logic around that verdict:
 * validate its shape, coerce a minor-only `request_changes` to `approve`,
 * fingerprint the findings, and decide whether to loop back to implement or give
 * up and open the PR with findings annotated.
 *
 * Transplanted from `autoFixOrchestrator`'s pattern: a hard attempt cap AND a
 * failure fingerprint, because a counter alone lets a non-converging loop burn
 * every attempt while producing the identical complaint each round.
 */

/** At most this many re-implement rounds (so 3 implement runs total). */
export const MAX_REVIEW_ATTEMPTS = 2;

export type Severity = 'blocker' | 'major' | 'minor';

export interface ReviewFinding {
  severity: Severity;
  file: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

export interface ReviewVerdict {
  verdict: 'approve' | 'request_changes';
  summary: string;
  findings: ReviewFinding[];
}

const SEVERITIES: Severity[] = ['blocker', 'major', 'minor'];

/**
 * Parse a raw runner-supplied verdict. Returns null on any malformation — the
 * caller re-prompts once, then fails the phase. Kept strict: a reviewer that
 * emits garbage must not be silently treated as an approval.
 */
export function parseReviewVerdict(raw: unknown): ReviewVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['verdict'] !== 'approve' && r['verdict'] !== 'request_changes') return null;
  if (typeof r['summary'] !== 'string') return null;
  if (!Array.isArray(r['findings'])) return null;
  const findings: ReviewFinding[] = [];
  for (const f of r['findings']) {
    if (!f || typeof f !== 'object') return null;
    const ff = f as Record<string, unknown>;
    if (!SEVERITIES.includes(ff['severity'] as Severity)) return null;
    if (typeof ff['file'] !== 'string' || typeof ff['issue'] !== 'string') return null;
    findings.push({
      severity: ff['severity'] as Severity,
      file: ff['file'],
      issue: ff['issue'],
      ...(typeof ff['line'] === 'number' ? { line: ff['line'] } : {}),
      ...(typeof ff['suggestion'] === 'string' ? { suggestion: ff['suggestion'] } : {}),
    });
  }
  return { verdict: r['verdict'], summary: r['summary'], findings };
}

/**
 * Normalise a verdict: a `request_changes` whose findings are ALL minor is
 * coerced to `approve` — minors annotate the PR, they do not block. Conversely a
 * `request_changes` must carry ≥1 blocker|major to stay blocking.
 */
export function normalizeVerdict(v: ReviewVerdict): ReviewVerdict {
  if (v.verdict !== 'request_changes') return v;
  const blocking = v.findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  return blocking ? v : { ...v, verdict: 'approve' };
}

/**
 * A stable fingerprint of the blocking findings, so an identical complaint round
 * over round can be detected. Sorted so ordering does not change the hash;
 * severity:file:issue only (not line/suggestion — those wobble without the
 * underlying problem changing).
 */
export function fingerprintFindings(findings: ReviewFinding[]): string {
  const keys = findings
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')
    .map((f) => `${f.severity}:${f.file}:${f.issue}`)
    .sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
}

export interface ReviewDecisionInput {
  verdict: ReviewVerdict;
  /** The current attempt (0 on the first review). */
  attempt: number;
  /** The fingerprint stored from the previous request_changes, if any. */
  previousFingerprint: string | null;
}

export type ReviewDecision =
  | { action: 'approve' }
  | { action: 'retry'; nextAttempt: number; fingerprint: string }
  | { action: 'give_up'; reason: 'attempts_exhausted' | 'not_converging'; fingerprint: string };

/**
 * Decide what the review phase does with a (normalised) verdict.
 *
 *   - approve → open the PR.
 *   - request_changes, fingerprint identical to last round → NOT converging; give
 *     up immediately and open the PR annotated (no point re-running the same fix).
 *   - request_changes, attempts exhausted → give up, PR annotated.
 *   - otherwise → retry implement with attempt+1 and the new fingerprint stored.
 */
export function decideReview(input: ReviewDecisionInput): ReviewDecision {
  const v = normalizeVerdict(input.verdict);
  if (v.verdict === 'approve') return { action: 'approve' };

  const fingerprint = fingerprintFindings(v.findings);
  if (input.previousFingerprint !== null && input.previousFingerprint === fingerprint) {
    return { action: 'give_up', reason: 'not_converging', fingerprint };
  }
  if (input.attempt >= MAX_REVIEW_ATTEMPTS) {
    return { action: 'give_up', reason: 'attempts_exhausted', fingerprint };
  }
  return { action: 'retry', nextAttempt: input.attempt + 1, fingerprint };
}
