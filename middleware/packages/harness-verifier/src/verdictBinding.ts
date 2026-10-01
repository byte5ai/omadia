import type {
  ClaimVerdict,
  NonEmptyClaimVerdicts,
  VerifierSkipReason,
  VerifierUnavailableReason,
  VerifierVerdict,
} from './claimTypes.js';

/**
 * A pipeline verdict held to what its claims show.
 *
 * The pipeline is injected (`verifier@1`), and its verdict is summarised onto
 * the public stream and stored in `verifier_verdicts`, where `approved` means
 * a clean turn. So whoever consumes it does not take its status or reason on
 * trust:
 *  - `skipped` / `unavailable` keep their reason only when it is one of the
 *    closed codes, and list no claim;
 *  - `approved`, `approved_with_disclaimer` and `blocked` need at least one
 *    claim and never say more than the claims show: the status is the weaker
 *    of the reported one and the one the claims earn (a contradicted claim
 *    earns `blocked`, an unverified one `approved_with_disclaimer`, only
 *    verified claims `approved`);
 *  - anything else — an unknown status, a reason outside the closed codes,
 *    entries that are not claim verdicts — is `unavailable` /
 *    `pipeline_error`: a verdict that breaks the contract is no result.
 * The built-in pipeline produces none of these cases; its verdicts pass
 * unchanged.
 */

const SKIP_REASONS: ReadonlySet<unknown> = new Set<VerifierSkipReason>([
  'no_trigger',
  'no_claims',
  'no_checkable_claims',
  'incomplete_coverage',
]);

const UNAVAILABLE_REASONS: ReadonlySet<unknown> = new Set<VerifierUnavailableReason>([
  'extractor_error',
  'pipeline_error',
  'privacy_shield',
]);

const CLAIM_STATUSES: ReadonlySet<unknown> = new Set<ClaimVerdict['status']>([
  'verified',
  'contradicted',
  'unverified',
]);

type CheckedStatus = 'approved' | 'approved_with_disclaimer' | 'blocked';

/** How far a status says the answer holds up; a bound verdict takes the lower. */
const STANDING: Readonly<Record<CheckedStatus, number>> = {
  blocked: 0,
  approved_with_disclaimer: 1,
  approved: 2,
};

export interface BoundVerdict {
  verdict: VerifierVerdict;
  /** What did not hold, for the operator log — never for the stream.
   *  Undefined when the verdict held as returned. */
  problem?: string;
}

/** The verdict as its claims support it (see the module comment). Pure. */
export function bindVerdictToClaims(raw: unknown): BoundVerdict {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const latencyMs = asLatency(v['latencyMs']);
  const unusable = (problem: string): BoundVerdict => ({
    verdict: { status: 'unavailable', reason: 'pipeline_error', claims: [], latencyMs },
    problem,
  });

  const claims = v['claims'];
  if (!Array.isArray(claims) || !claims.every(isClaimVerdict)) {
    return unusable('claims are not a list of claim verdicts');
  }
  const status = v['status'];
  const reason = v['reason'];
  switch (status) {
    case 'skipped':
      if (!SKIP_REASONS.has(reason)) return unusable(`skipped with reason ${shown(reason)}`);
      if (claims.length > 0) return unusable(`skipped over ${String(claims.length)} claim(s)`);
      return { verdict: { status, reason: reason as VerifierSkipReason, claims: [], latencyMs } };
    case 'unavailable':
      if (!UNAVAILABLE_REASONS.has(reason)) {
        return unusable(`unavailable with reason ${shown(reason)}`);
      }
      if (claims.length > 0) return unusable(`unavailable over ${String(claims.length)} claim(s)`);
      return {
        verdict: { status, reason: reason as VerifierUnavailableReason, claims: [], latencyMs },
      };
    case 'approved':
    case 'approved_with_disclaimer':
    case 'blocked':
      return isNonEmpty(claims)
        ? boundToClaims(status, claims, latencyMs)
        : unusable(`${status} without a claim`);
    default:
      return unusable(`unknown status ${shown(status)}`);
  }
}

function boundToClaims(
  reported: CheckedStatus,
  claims: NonEmptyClaimVerdicts,
  latencyMs: number,
): BoundVerdict {
  const earned: CheckedStatus = claims.some((c) => c.status === 'contradicted')
    ? 'blocked'
    : claims.some((c) => c.status === 'unverified')
      ? 'approved_with_disclaimer'
      : 'approved';
  if (STANDING[earned] < STANDING[reported]) {
    return {
      verdict: checkedVerdict(earned, claims, latencyMs),
      problem: `${reported} over claims that earn only ${earned}`,
    };
  }
  return { verdict: checkedVerdict(reported, claims, latencyMs) };
}

/** A checked verdict whose side lists are derived from its claims. */
function checkedVerdict(
  status: CheckedStatus,
  claims: NonEmptyClaimVerdicts,
  latencyMs: number,
): VerifierVerdict {
  switch (status) {
    case 'approved':
      return { status, claims, latencyMs };
    case 'approved_with_disclaimer':
      return {
        status,
        claims,
        unverified: claims.filter((c) => c.status === 'unverified'),
        latencyMs,
      };
    case 'blocked':
      return {
        status,
        claims,
        contradictions: claims.filter((c) => c.status === 'contradicted'),
        latencyMs,
      };
  }
}

function isClaimVerdict(entry: unknown): entry is ClaimVerdict {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as { status?: unknown; claim?: unknown };
  return CLAIM_STATUSES.has(e.status) && typeof e.claim === 'object' && e.claim !== null;
}

function isNonEmpty(claims: ClaimVerdict[]): claims is NonEmptyClaimVerdicts {
  return claims.length > 0;
}

function asLatency(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A raw value for the operator log: JSON-escaped (no line breaks) and cut short. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? typeof value;
  } catch {
    text = typeof value;
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
