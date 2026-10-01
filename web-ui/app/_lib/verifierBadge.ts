/**
 * Maps an answer-verifier summary to what the chat may claim about the answer.
 *
 * The rule is the one `toSemanticAnswer` applies for connectors: a summary is
 * evidence only when a check settled a claim — a contradicted claim for
 * `blocked`, a confirmed one for `approved` / `approved_with_disclaimer`
 * (confirmed = `claimCount - contradictionCount - unverifiedCount`). The chip
 * never claims more than the counts back: green needs an `approved` summary
 * whose every claim was confirmed. `skipped` turns (nothing checkable), a
 * verifier that could not run, and checks that confirmed nothing get their own
 * neutral states — they are never shown as a check. A summary restored from
 * local storage is untrusted input, so the mapping validates rather than
 * assumes its shape.
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
  | 'noneConfirmed'
  | 'checkFailed'
  | 'partialUnchecked';

export interface VerifierBadgeView {
  state: VerifierBadgeState;
  tone: VerifierBadgeTone;
  hint: VerifierBadgeHint;
  /** The count the hint names: checked, unconfirmed, unchecked or
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
};

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function unverified(reason: unknown): VerifierBadgeView {
  const hint = typeof reason === 'string' ? SKIP_HINTS[reason] : undefined;
  return { state: 'unverified', tone: 'neutral', hint: hint ?? 'unverified', count: 0 };
}

/** `null` when there is no summary to show; otherwise the badge to render. */
export function verifierBadgeView(summary: unknown): VerifierBadgeView | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const s = summary as Record<string, unknown>;
  const claimCount = countOf(s['claimCount']);
  const checkedClaims = EVIDENCED_STATUSES.has(s['status']) && claimCount > 0;
  if (s['status'] === 'unavailable' || s['badge'] === 'unavailable') {
    // The verifier could not run, or it ran and every check failed.
    return {
      state: 'unavailable',
      tone: 'neutral',
      hint: checkedClaims ? 'checkFailed' : 'unavailable',
      count: 0,
    };
  }
  if (!checkedClaims) return unverified(s['reason']);
  return checkedView(s, claimCount);
}

/** A summary over checked claims: its badge, capped by what the counts back. */
function checkedView(s: Record<string, unknown>, claimCount: number): VerifierBadgeView {
  const contradicted = countOf(s['contradictionCount']);
  const unconfirmed = countOf(s['unverifiedCount']);
  const confirmed = Math.max(0, claimCount - contradicted - unconfirmed);
  const blocked = s['status'] === 'blocked';
  if (blocked ? contradicted === 0 : confirmed === 0) {
    // Claims were checked, but no check settled one.
    return { state: 'unverified', tone: 'neutral', hint: 'noneConfirmed', count: claimCount };
  }
  switch (s['badge']) {
    case 'verified':
      if (s['status'] === 'approved' && confirmed === claimCount) {
        return { state: 'verified', tone: 'success', hint: 'verified', count: claimCount };
      }
      break;
    case 'partial':
      if (!blocked && contradicted === 0) {
        return partialView(unconfirmed, countOf(s['uncheckedCount']));
      }
      break;
    case 'corrected':
      if (!blocked && contradicted === 0) {
        return { state: 'corrected', tone: 'info', hint: 'corrected', count: claimCount };
      }
      break;
    case 'failed':
      if (contradicted > 0) {
        return { state: 'failed', tone: 'danger', hint: 'failed', count: contradicted };
      }
      break;
  }
  return unverified(undefined);
}

/** Partly confirmed. When every unconfirmed claim is one no check ran on,
 *  the hint says so instead of "could not be confirmed". */
function partialView(unconfirmed: number, unchecked: number): VerifierBadgeView {
  return unchecked > 0 && unchecked === unconfirmed
    ? { state: 'partial', tone: 'warning', hint: 'partialUnchecked', count: unchecked }
    : { state: 'partial', tone: 'warning', hint: 'partial', count: unconfirmed };
}
