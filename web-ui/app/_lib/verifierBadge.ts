/**
 * Maps an answer-verifier summary to what the chat may claim about the answer.
 *
 * The rule is the one `toSemanticAnswer` applies for connectors: only a
 * summary with checked claims (`approved` / `approved_with_disclaimer` /
 * `blocked` and `claimCount > 0`) is evidence. Green is reserved for an
 * evidenced `verified`. `skipped` turns (nothing checkable) and an
 * `unavailable` verifier get their own neutral states — they are never shown
 * as a check. A summary restored from local storage is untrusted input, so
 * the mapping validates rather than assumes its shape.
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
  | 'noCheckableClaims';

export interface VerifierBadgeView {
  state: VerifierBadgeState;
  tone: VerifierBadgeTone;
  hint: VerifierBadgeHint;
  /** The count the hint names: checked, unconfirmed or contradicted claims. */
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
  if (s['status'] === 'unavailable' || s['badge'] === 'unavailable') {
    return { state: 'unavailable', tone: 'neutral', hint: 'unavailable', count: 0 };
  }
  const claimCount = countOf(s['claimCount']);
  if (!EVIDENCED_STATUSES.has(s['status']) || claimCount === 0) {
    return unverified(s['reason']);
  }
  switch (s['badge']) {
    case 'verified':
      return s['status'] === 'approved'
        ? { state: 'verified', tone: 'success', hint: 'verified', count: claimCount }
        : unverified(undefined);
    case 'partial':
      return {
        state: 'partial',
        tone: 'warning',
        hint: 'partial',
        count: countOf(s['unverifiedCount']),
      };
    case 'corrected':
      return { state: 'corrected', tone: 'info', hint: 'corrected', count: claimCount };
    case 'failed':
      return {
        state: 'failed',
        tone: 'danger',
        hint: 'failed',
        count: countOf(s['contradictionCount']),
      };
    default:
      return unverified(undefined);
  }
}
