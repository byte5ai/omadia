import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MAX_REVIEW_ATTEMPTS,
  decideReview,
  fingerprintFindings,
  normalizeVerdict,
  parseReviewVerdict,
  type ReviewFinding,
  type ReviewVerdict,
} from '../../src/devplatform/pipeline/reviewLoop.js';

const blocker: ReviewFinding = { severity: 'blocker', file: 'a.ts', issue: 'null deref' };
const minor: ReviewFinding = { severity: 'minor', file: 'b.ts', issue: 'nit' };

function verdict(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return { verdict: 'approve', summary: 's', findings: [], ...over };
}

describe('devplatform/reviewLoop — parseReviewVerdict', () => {
  it('parses a well-formed verdict', () => {
    const v = parseReviewVerdict({
      verdict: 'request_changes',
      summary: 'issues found',
      findings: [{ severity: 'major', file: 'x.ts', line: 4, issue: 'oops', suggestion: 'fix' }],
    });
    assert.equal(v?.verdict, 'request_changes');
    assert.equal(v?.findings[0]?.line, 4);
  });

  it('rejects a malformed verdict rather than treating garbage as approval', () => {
    assert.equal(parseReviewVerdict(null), null);
    assert.equal(parseReviewVerdict({ verdict: 'maybe', summary: '', findings: [] }), null);
    assert.equal(parseReviewVerdict({ verdict: 'approve', summary: 5, findings: [] }), null);
    assert.equal(parseReviewVerdict({ verdict: 'approve', summary: '', findings: 'no' }), null);
    assert.equal(
      parseReviewVerdict({ verdict: 'approve', summary: '', findings: [{ severity: 'huge', file: 'a', issue: 'b' }] }),
      null,
    );
  });
});

describe('devplatform/reviewLoop — normalizeVerdict', () => {
  it('coerces a minor-only request_changes to approve', () => {
    const v = normalizeVerdict(verdict({ verdict: 'request_changes', findings: [minor, minor] }));
    assert.equal(v.verdict, 'approve', 'minors annotate, they do not block');
  });
  it('keeps request_changes when a blocker or major is present', () => {
    assert.equal(normalizeVerdict(verdict({ verdict: 'request_changes', findings: [minor, blocker] })).verdict, 'request_changes');
  });
});

describe('devplatform/reviewLoop — fingerprintFindings', () => {
  it('is order-independent and ignores line/suggestion', () => {
    const a = fingerprintFindings([
      { severity: 'blocker', file: 'a.ts', issue: 'x', line: 1 },
      { severity: 'major', file: 'b.ts', issue: 'y', line: 2 },
    ]);
    const b = fingerprintFindings([
      { severity: 'major', file: 'b.ts', issue: 'y', line: 99, suggestion: 'diff' },
      { severity: 'blocker', file: 'a.ts', issue: 'x' },
    ]);
    assert.equal(a, b, 'the same blocking findings fingerprint identically');
  });
  it('ignores minors entirely', () => {
    assert.equal(fingerprintFindings([blocker, minor]), fingerprintFindings([blocker]));
  });
});

describe('devplatform/reviewLoop — decideReview', () => {
  it('approves an approve verdict', () => {
    assert.deepEqual(decideReview({ verdict: verdict(), attempt: 0, previousFingerprint: null }), { action: 'approve' });
  });

  it('retries on the first request_changes', () => {
    const d = decideReview({
      verdict: verdict({ verdict: 'request_changes', findings: [blocker] }),
      attempt: 0,
      previousFingerprint: null,
    });
    assert.equal(d.action, 'retry');
    if (d.action === 'retry') assert.equal(d.nextAttempt, 1);
  });

  it('gives up immediately when the fingerprint is identical (not converging)', () => {
    const fp = fingerprintFindings([blocker]);
    const d = decideReview({
      verdict: verdict({ verdict: 'request_changes', findings: [blocker] }),
      attempt: 1,
      previousFingerprint: fp,
    });
    assert.equal(d.action, 'give_up');
    if (d.action === 'give_up') assert.equal(d.reason, 'not_converging');
  });

  it('gives up when attempts are exhausted even if the findings changed', () => {
    const d = decideReview({
      verdict: verdict({ verdict: 'request_changes', findings: [{ ...blocker, issue: 'new problem' }] }),
      attempt: MAX_REVIEW_ATTEMPTS,
      previousFingerprint: 'something-else',
    });
    assert.equal(d.action, 'give_up');
    if (d.action === 'give_up') assert.equal(d.reason, 'attempts_exhausted');
  });

  it('a minor-only request_changes decides approve, never retry', () => {
    assert.deepEqual(
      decideReview({ verdict: verdict({ verdict: 'request_changes', findings: [minor] }), attempt: 0, previousFingerprint: null }),
      { action: 'approve' },
    );
  });
});
