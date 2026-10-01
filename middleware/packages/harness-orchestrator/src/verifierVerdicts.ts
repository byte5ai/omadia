import type {
  ClaimVerdict,
  VerifierBadge,
  VerifierVerdict,
} from '@omadia/verifier';
import { bindVerdictToClaims, hasVerificationEvidence } from '@omadia/verifier';
import type { ChatTurnResult, VerifierResultSummary } from './orchestrator.js';

/**
 * Pure verdict helpers of the answer-verifier wrapper (`VerifierService`):
 * the stream / connector summary of a verdict, the badge it earns, the badge
 * after a correction retry, and the merge of a borderline resample. Kept out
 * of `verifierService.ts`, which re-exports `badgeFor`, `mergeBadges` and
 * `mergeBorderlineVerdicts` for the tests that import them from there.
 */

export function withVerifier(
  result: ChatTurnResult,
  verifier: VerifierResultSummary,
): ChatTurnResult {
  return { ...result, verifier };
}

export function summarise(
  returned: VerifierVerdict,
  retryCount: number,
  mode: 'shadow' | 'enforce',
): VerifierResultSummary {
  // The summary goes out verbatim on the stream, so it is built from a bound
  // verdict whatever the caller passes: a status the claims back, a reason
  // from the closed codes. A verdict from `safeVerify` is bound already and
  // passes unchanged.
  const { verdict } = bindVerdictToClaims(returned);
  // Counted over the claim list itself, so `claimCount - contradictionCount
  // - unverifiedCount` is exactly the number of verified claims — the figure
  // the connector and web-chat badge gates check the badge against.
  const count = (pick: (c: ClaimVerdict) => boolean): number =>
    verdict.claims.filter(pick).length;

  return {
    badge: badgeFor(verdict, retryCount),
    status: verdict.status,
    ...(verdict.status === 'skipped' || verdict.status === 'unavailable'
      ? { reason: verdict.reason }
      : {}),
    claimCount: verdict.claims.length,
    contradictionCount: count((c) => c.status === 'contradicted'),
    unverifiedCount: count((c) => c.status === 'unverified'),
    uncheckedCount: count((c) => c.status === 'unverified' && c.cause === 'not_checked'),
    uncoveredCount: count((c) => c.claim.type === 'coverage_gap'),
    retryCount,
    latencyMs: verdict.latencyMs,
    mode,
  };
}

/**
 * Badge for one verdict, bound to evidence (`hasVerificationEvidence`: a
 * check settled at least one claim). Without that the badge is `unavailable`
 * when the verifier could not run or every check that ran failed, and
 * `unverified` otherwise — whatever status the verdict carries. The pipeline
 * is injected, so this reads the claims, not the status. With evidence:
 * `failed` for any contradicted claim, `verified` only when every claim was
 * confirmed, `partial` when some were not. After a retry, `corrected` takes
 * the place of `verified` and needs the same: every claim confirmed. A retry
 * that confirmed only some claims is `partial`, as on a first pass.
 */
export function badgeFor(
  verdict: VerifierVerdict,
  retryCount: number,
): VerifierBadge {
  if (!hasVerificationEvidence(verdict)) {
    return verdict.status === 'unavailable' || everyCheckFailed(verdict)
      ? 'unavailable'
      : 'unverified';
  }
  if (verdict.claims.some((c) => c.status === 'contradicted')) return 'failed';
  const everyClaimConfirmed =
    verdict.status === 'approved' &&
    verdict.claims.every((c) => c.status === 'verified');
  if (!everyClaimConfirmed) return 'partial';
  return retryCount > 0 ? 'corrected' : 'verified';
}

/** True when a check ran on at least one claim and every such check failed.
 *  Claims no check ran on (`not_checked`, including coverage entries) do not
 *  count either way. */
function everyCheckFailed(verdict: VerifierVerdict): boolean {
  const checked = verdict.claims.filter(
    (c) => !(c.status === 'unverified' && c.cause === 'not_checked'),
  );
  return (
    checked.length > 0 &&
    checked.every((c) => c.status === 'unverified' && c.cause === 'check_failed')
  );
}

/**
 * Badge after the correction retry. `corrected` / `failed` describe a retry
 * that followed a blocked first pass, and the retry's own verdict decides:
 * `corrected` needs a second pass that confirmed every claim; one that
 * confirmed only some is `partial`. A retry whose verification was skipped,
 * unavailable or confirmed nothing is never `corrected`.
 */
export function mergeBadges(
  first: VerifierVerdict,
  second: VerifierVerdict,
): VerifierBadge {
  return badgeFor(second, first.status === 'blocked' ? 1 : 0);
}

/**
 * #132 — merge two verdicts when the first was borderline
 * (`approved_with_disclaimer`) and the second one was drawn from a re-run
 * of the same turn. Strategy:
 *
 * 1. Both agree on borderline → keep first (the two independent samples
 *    confirmed the same level of uncertainty; treat the disclaimer as
 *    earned signal, not noise).
 * 2. Second sample escalated to `blocked` → flip to second so the
 *    correctionPrompt retry can run on the contradictions the second
 *    sample exposed. Conservative bias.
 * 3. Second sample relaxed to `approved` → keep first. Two contradictory
 *    samples + one finding stuff we didn't is exactly the noise signal
 *    that the disclaimer exists to communicate; don't upgrade.
 * 4. Second sample checked nothing — `skipped`, or `unavailable` (safeVerify's
 *    result after a pipeline error) → keep first; it adds no signal.
 *
 * `takeSecond` is true only when we propagate the second sample's
 * orchestrator result onward (its answer string is what the LLM
 * generated for that verdict).
 */
export function mergeBorderlineVerdicts(
  first: VerifierVerdict,
  second: VerifierVerdict,
): { verdict: VerifierVerdict; takeSecond: boolean } {
  if (second.status === 'blocked') {
    return { verdict: second, takeSecond: true };
  }
  // Anything else (approved, approved_with_disclaimer, skipped,
  // unavailable): trust the first sample's disclaimer signal.
  return { verdict: first, takeSecond: false };
}
