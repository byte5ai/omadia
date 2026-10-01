import type {
  ClaimExtraction,
  ClaimVerdict,
  ExtractionGap,
  VerifierSkipReason,
} from './claimTypes.js';

/**
 * Turns what a claim extraction did not cover into verdict entries.
 *
 * A gap is not a claim, but it counts like one nobody checked: each becomes
 * an `unverified` / `not_checked` verdict over a synthetic `coverage_gap`
 * claim. Next to verified claims that keeps the answer at
 * `approved_with_disclaimer`, so an answer read only in part is never
 * `approved`; and it never makes a verdict out of nothing — with no checked
 * claim the pipeline reports `skipped` / `incomplete_coverage`.
 */

const GAP_REASONS: Readonly<Record<ExtractionGap, string>> = {
  answer_beyond_window: 'answer text beyond the extraction window was not checked',
  claim_list_full:
    'the extraction listed as many claims as it asks for, so claims it left out were not checked',
};

/** One `not_checked` coverage verdict per gap, in the order reported. */
export function coverageVerdicts(gaps: readonly ExtractionGap[]): ClaimVerdict[] {
  return gaps.map((gap): ClaimVerdict => {
    const reason = GAP_REASONS[gap] ?? 'part of the answer was not covered by the extraction';
    return {
      status: 'unverified',
      claim: {
        id: `c_coverage_${gap}`,
        text: reason,
        type: 'coverage_gap',
        expectedSource: 'unknown',
        relatedEntities: [],
      },
      reason,
      cause: 'not_checked',
    };
  });
}

/**
 * The skip reason when nothing was checked. With a coverage gap the
 * extraction only looked at part of the answer, so "no claims" / "no
 * checkable claims" would say more than was looked at.
 */
export function skipReason(
  whenCovered: VerifierSkipReason,
  coverage: readonly ClaimVerdict[],
): VerifierSkipReason {
  return coverage.length > 0 ? 'incomplete_coverage' : whenCovered;
}

/**
 * The extractor's result, or a throw when it is not a claim extraction. The
 * extractor is injected; one that reports no coverage must fail like any
 * other extractor failure, not pass for a complete extraction.
 */
export function readExtraction(result: unknown): ClaimExtraction {
  const r = result as Partial<ClaimExtraction> | null | undefined;
  if (!r || !Array.isArray(r.claims) || !Array.isArray(r.gaps)) {
    throw new Error('extractor result is not a claim extraction');
  }
  return { claims: r.claims, gaps: r.gaps };
}
