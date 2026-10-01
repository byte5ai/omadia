import { describe, expect, it } from 'vitest';

import type { VerifierSummary } from '../chatSessions';
import { verifierBadgeView } from '../verifierBadge';

function summary(overrides: Partial<VerifierSummary> = {}): VerifierSummary {
  return {
    badge: 'verified',
    status: 'approved',
    claimCount: 2,
    contradictionCount: 0,
    unverifiedCount: 0,
    retryCount: 0,
    latencyMs: 40,
    mode: 'shadow',
    ...overrides,
  };
}

const BADGES: VerifierSummary['badge'][] = [
  'verified',
  'partial',
  'corrected',
  'failed',
  'unverified',
  'unavailable',
];
const STATUSES: VerifierSummary['status'][] = [
  'approved',
  'approved_with_disclaimer',
  'blocked',
  'skipped',
  'unavailable',
];

describe('verifierBadgeView — green only with evidence', () => {
  it('shows a verified summary with checked claims as green', () => {
    expect(verifierBadgeView(summary())).toEqual({
      state: 'verified',
      tone: 'success',
      hint: 'verified',
      count: 2,
    });
  });

  it('never renders green for any other badge / status / claim-count combination', () => {
    for (const badge of BADGES) {
      for (const status of STATUSES) {
        for (const claimCount of [0, 3]) {
          const view = verifierBadgeView(summary({ badge, status, claimCount }));
          const isEvidencedVerified =
            badge === 'verified' && status === 'approved' && claimCount > 0;
          expect(
            view?.tone === 'success',
            `${badge}/${status}/${String(claimCount)}`,
          ).toBe(isEvidencedVerified);
        }
      }
    }
  });

  it('treats a verified badge without checked claims as not verified', () => {
    const view = verifierBadgeView(summary({ claimCount: 0 }));
    expect(view?.state).toBe('unverified');
    expect(view?.tone).toBe('neutral');
  });
});

describe('verifierBadgeView — distinct states', () => {
  it('skipped turns are "not verified", explained by their reason', () => {
    const base = { badge: 'unverified', status: 'skipped', claimCount: 0 } as const;
    expect(verifierBadgeView(summary({ ...base, reason: 'no_trigger' }))?.hint).toBe('noTrigger');
    expect(verifierBadgeView(summary({ ...base, reason: 'no_claims' }))?.hint).toBe('noClaims');
    expect(verifierBadgeView(summary({ ...base, reason: 'no_checkable_claims' }))?.hint).toBe(
      'noCheckableClaims',
    );
    const generic = verifierBadgeView(summary(base));
    expect(generic).toMatchObject({ state: 'unverified', tone: 'neutral', hint: 'unverified' });
  });

  it('an unavailable verifier is its own neutral state', () => {
    const view = verifierBadgeView(
      summary({ badge: 'unavailable', status: 'unavailable', reason: 'pipeline_error', claimCount: 0 }),
    );
    expect(view).toMatchObject({ state: 'unavailable', tone: 'neutral', hint: 'unavailable' });
  });

  it('partial, corrected and failed keep their own tones and counts', () => {
    expect(
      verifierBadgeView(
        summary({ badge: 'partial', status: 'approved_with_disclaimer', unverifiedCount: 1 }),
      ),
    ).toEqual({ state: 'partial', tone: 'warning', hint: 'partial', count: 1 });
    expect(
      verifierBadgeView(summary({ badge: 'corrected', status: 'approved', retryCount: 1 })),
    ).toMatchObject({ state: 'corrected', tone: 'info' });
    expect(
      verifierBadgeView(summary({ badge: 'failed', status: 'blocked', contradictionCount: 2 })),
    ).toEqual({ state: 'failed', tone: 'danger', hint: 'failed', count: 2 });
  });

  it('an answer checked only in part is partial and says how many claims were not checked', () => {
    expect(
      verifierBadgeView(
        summary({
          badge: 'partial',
          status: 'approved_with_disclaimer',
          claimCount: 3,
          unverifiedCount: 1,
          uncheckedCount: 1,
        }),
      ),
    ).toEqual({ state: 'partial', tone: 'warning', hint: 'partialUnchecked', count: 1 });
  });

  it('claims checked but none confirmed are "not verified", or unavailable when every check failed', () => {
    const checked = { status: 'approved_with_disclaimer', claimCount: 2, unverifiedCount: 2 } as const;
    expect(verifierBadgeView(summary({ ...checked, badge: 'unverified' }))).toEqual({
      state: 'unverified',
      tone: 'neutral',
      hint: 'noneConfirmed',
      count: 2,
    });
    expect(verifierBadgeView(summary({ ...checked, badge: 'unavailable' }))).toMatchObject({
      state: 'unavailable',
      tone: 'neutral',
      hint: 'checkFailed',
    });
  });

  it('never shows more than the counts back', () => {
    // Green needs every claim confirmed on an approved summary.
    expect(verifierBadgeView(summary({ unverifiedCount: 1 }))?.tone).not.toBe('success');
    // Partial or corrected need at least one confirmed claim.
    const noneConfirmed = { status: 'approved_with_disclaimer', claimCount: 2, unverifiedCount: 2 } as const;
    expect(verifierBadgeView(summary({ ...noneConfirmed, badge: 'partial' }))?.state).toBe('unverified');
    expect(
      verifierBadgeView(summary({ ...noneConfirmed, badge: 'corrected', retryCount: 1 }))?.state,
    ).toBe('unverified');
  });

  it('returns null when there is no summary, and never green for a malformed one', () => {
    expect(verifierBadgeView(undefined)).toBeNull();
    expect(verifierBadgeView(null)).toBeNull();
    expect(verifierBadgeView('verified')).toBeNull();
    expect(verifierBadgeView({})).toMatchObject({ state: 'unverified', tone: 'neutral' });
    expect(
      verifierBadgeView({ badge: 'verified', status: 'approved', claimCount: '3' })?.tone,
    ).toBe('neutral');
  });
});
