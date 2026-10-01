/**
 * Maps an answer-verifier summary to what the chat may claim about the answer.
 *
 * The rule is the one `toSemanticAnswer` applies for connectors: a summary is
 * evidence only when a check settled a claim — a contradicted claim for
 * `blocked`, a confirmed one for `approved` / `approved_with_disclaimer`
 * (confirmed = `claimCount - contradictionCount - unverifiedCount`). The chip
 * never claims more than the counts back: green ("verified") and blue
 * ("corrected") need an `approved` summary whose every claim was confirmed;
 * otherwise the answer is at most partly verified. `skipped` turns (nothing
 * checkable), a verifier that could not run, and checks that confirmed
 * nothing get their own neutral states — they are never shown as a check. A
 * summary restored from local storage is untrusted input, so the mapping
 * validates rather than assumes its shape: counts must be nonnegative
 * integers that agree with each other (`uncoveredCount ≤ uncheckedCount ≤
 * unverifiedCount`, `contradictionCount + unverifiedCount ≤ claimCount`),
 * otherwise the summary backs nothing and gets a neutral chip — the same rule
 * the connector gate applies.
 */

export type VerifierBadgeState =
  | 'verified'
  | 'partial'
  | 'corrected'
  | 'failed'
  | 'unverified'
  | 'unavailable';

export type VerifierBadgeTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

/** Key under `chat.verifier.hint` that explains the state. */
export type VerifierBadgeHint =
  | VerifierBadgeState
  | 'noTrigger'
  | 'noClaims'
  | 'noCheckableClaims'
  | 'incompleteCoverage'
  | 'noneConfirmed'
  | 'checkFailed'
  | 'partialUnchecked'
  | 'partialCoverage';

export interface VerifierBadgeView {
  state: VerifierBadgeState;
  tone: VerifierBadgeTone;
  hint: VerifierBadgeHint;
  /** The count the hint names: checked, confirmed, unconfirmed, unchecked or
   *  contradicted claims. */
  count: number;
}

const EVIDENCED_STATUSES: ReadonlySet<unknown> = new Set([
  'approved',
  'approved_with_disclaimer',
  'blocked',
]);

const SKIP_HINTS: Readonly<Record<string, VerifierBadgeHint>> = {
  no_trigger: 'noTrigger',
  no_claims: 'noClaims',
  no_checkable_claims: 'noCheckableClaims',
  incomplete_coverage: 'incompleteCoverage',
};

/** A count the summary must carry: a nonnegative integer, else `null`. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** An optional count: 0 when absent, else it must be a count. */
function optionalCountOf(value: unknown): number | null {
  return value === undefined || value === null ? 0 : countOf(value);
}

function unverified(reason: unknown): VerifierBadgeView {
  const hint = typeof reason === 'string' ? SKIP_HINTS[reason] : undefined;
  return { state: 'unverified', tone: 'neutral', hint: hint ?? 'unverified', count: 0 };
}

/** `null` when there is no summary to show; otherwise the badge to render. */
export function verifierBadgeView(summary: unknown): VerifierBadgeView | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const s = summary as Record<string, unknown>;
  const counts = countsOf(s);
  const checkedClaims =
    counts !== null && counts.claims > 0 && EVIDENCED_STATUSES.has(s['status']);
  if (s['status'] === 'unavailable' || s['badge'] === 'unavailable') {
    // The verifier could not run, or it ran and every check failed.
    return {
      state: 'unavailable',
      tone: 'neutral',
      hint: checkedClaims ? 'checkFailed' : 'unavailable',
      count: 0,
    };
  }
  // Missing counts, or counts that contradict each other, back nothing.
  if (counts === null || !checkedClaims) return unverified(s['reason']);
  return checkedView(s, counts);
}

/** Claim counts of a summary that agree with each other. */
interface Counts {
  claims: number;
  contradicted: number;
  unconfirmed: number;
  confirmed: number;
  unchecked: number;
  uncovered: number;
}

/** The summary's counts, or `null` when a required one is missing, any is not
 *  a nonnegative integer, or they cannot describe one claim list. */
function countsOf(s: Record<string, unknown>): Counts | null {
  const claims = countOf(s['claimCount']);
  const contradicted = countOf(s['contradictionCount']);
  const unconfirmed = countOf(s['unverifiedCount']);
  const unchecked = optionalCountOf(s['uncheckedCount']);
  const uncovered = optionalCountOf(s['uncoveredCount']);
  if (
    claims === null ||
    contradicted === null ||
    unconfirmed === null ||
    unchecked === null ||
    uncovered === null ||
    uncovered > unchecked ||
    unchecked > unconfirmed ||
    contradicted + unconfirmed > claims
  ) {
    return null;
  }
  return {
    claims,
    contradicted,
    unconfirmed,
    confirmed: claims - contradicted - unconfirmed,
    unchecked,
    uncovered,
  };
}

/** A summary over checked claims: its badge, capped by what the counts back. */
function checkedView(s: Record<string, unknown>, c: Counts): VerifierBadgeView {
  const blocked = s['status'] === 'blocked';
  if (blocked ? c.contradicted === 0 : c.confirmed === 0) {
    // Claims were checked, but no check settled one. Name only the claims a
    // check ran on — not the unchecked ones, nor coverage entries.
    const checked = c.claims - c.unchecked;
    return checked > 0
      ? { state: 'unverified', tone: 'neutral', hint: 'noneConfirmed', count: checked }
      : unverified(undefined);
  }
  const uncontradicted = !blocked && c.contradicted === 0;
  switch (s['badge']) {
    case 'verified':
    case 'corrected':
      if (s['status'] === 'approved' && c.confirmed === c.claims) {
        return s['badge'] === 'verified'
          ? { state: 'verified', tone: 'success', hint: 'verified', count: c.claims }
          : { state: 'corrected', tone: 'info', hint: 'corrected', count: c.claims };
      }
      // The counts back only part of the answer: show that, nothing more.
      return uncontradicted ? partialView(c) : unverified(undefined);
    case 'partial':
      if (uncontradicted) return partialView(c);
      break;
    case 'failed':
      if (c.contradicted > 0) {
        return { state: 'failed', tone: 'danger', hint: 'failed', count: c.contradicted };
      }
      break;
  }
  return unverified(undefined);
}

/** Partly confirmed. The hint says why: part of the answer was not covered,
 *  every unconfirmed claim is one no check ran on, or claims could not be
 *  confirmed. */
function partialView(c: Counts): VerifierBadgeView {
  if (c.uncovered > 0) {
    return { state: 'partial', tone: 'warning', hint: 'partialCoverage', count: c.confirmed };
  }
  return c.unchecked > 0 && c.unchecked === c.unconfirmed
    ? { state: 'partial', tone: 'warning', hint: 'partialUnchecked', count: c.unchecked }
    : { state: 'partial', tone: 'warning', hint: 'partial', count: c.unconfirmed };
}
