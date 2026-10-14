/**
 * Verdicts for driving `VerifierService` in tests, one per state the
 * service distinguishes. Shaped like the built-in pipeline's verdicts, so
 * `bindVerdictToClaims` passes them unchanged.
 */

import type {
  Claim,
  ClaimVerdict,
  VerifierSkipReason,
  VerifierVerdict,
} from '@omadia/verifier';

/** The claim every fixture verdict is about; its text is the figure the
 *  scripted answers state. */
export const AMOUNT_TEXT = '5.234.000 €';

const AMOUNT: Claim = {
  id: 'c_1',
  text: AMOUNT_TEXT,
  type: 'amount',
  expectedSource: 'odoo',
  relatedEntities: [],
};

export const VERIFIED: ClaimVerdict = { status: 'verified', claim: AMOUNT, source: 'odoo' };
export const CONTRADICTED: ClaimVerdict = {
  status: 'contradicted',
  claim: AMOUNT,
  truth: 4_100_000,
  source: 'odoo',
};
export const UNVERIFIED: ClaimVerdict = {
  status: 'unverified',
  claim: { ...AMOUNT, id: 'c_2' },
  reason: 'no evidence',
};
export const NOT_CHECKED: ClaimVerdict = {
  status: 'unverified',
  claim: { ...AMOUNT, id: 'c_3', expectedSource: 'confluence' },
  reason: 'no checker',
  cause: 'not_checked',
};

export const approved = (): VerifierVerdict => ({
  status: 'approved',
  claims: [VERIFIED],
  latencyMs: 3,
});

export const blocked = (contradicted = 1): VerifierVerdict => {
  const contradictions = Array.from({ length: contradicted }, (_, i) => ({
    ...CONTRADICTED,
    claim: { ...AMOUNT, id: `c_x${String(i)}` },
  }));
  return { status: 'blocked', claims: contradictions, contradictions, latencyMs: 3 };
};

const disclaimer = (claims: ClaimVerdict[]): VerifierVerdict => ({
  status: 'approved_with_disclaimer',
  claims,
  unverified: claims.filter((c) => c.status === 'unverified'),
  latencyMs: 3,
});

/** One claim confirmed, one no checker takes: badge `partial`. */
export const partlyChecked = (): VerifierVerdict => disclaimer([VERIFIED, NOT_CHECKED]);

/** Checked, but the sources confirmed none: badge `unverified`. */
export const noneConfirmed = (): VerifierVerdict => disclaimer([UNVERIFIED]);

/** One claim confirmed, one checked without confirmation: borderline
 *  (`isBorderlineVerdict`), so `enforce chat()` draws a resample. */
export const borderline = (): VerifierVerdict => disclaimer([VERIFIED, UNVERIFIED]);

export const CHECK_FAILED: ClaimVerdict = {
  status: 'unverified',
  claim: { ...AMOUNT, id: 'c_4' },
  reason: 'judge returned no usable verdict',
  cause: 'check_failed',
};
export const UNCONFIRMED_CONTRADICTION: ClaimVerdict = {
  status: 'unverified',
  claim: { ...AMOUNT, id: 'c_5' },
  reason: 'judge contradiction not reproduced on recheck',
  cause: 'contradiction_unconfirmed',
};

/** Every check that ran failed (the other claim no checker takes): the same
 *  technical fault as `unavailable`, claim by claim. */
export const allChecksFailed = (): VerifierVerdict => disclaimer([CHECK_FAILED, NOT_CHECKED]);

/** One claim confirmed, one check failed: a real verdict exists. */
export const partlyFailed = (): VerifierVerdict => disclaimer([VERIFIED, CHECK_FAILED]);

/** One claim confirmed; the judge called another contradicted, and the
 *  contradiction was not confirmed. */
export const unconfirmedContradiction = (): VerifierVerdict =>
  disclaimer([VERIFIED, UNCONFIRMED_CONTRADICTION]);

/** A weaker status than its claims need — every claim verified. */
export const disclaimerOverVerified = (): VerifierVerdict => disclaimer([VERIFIED]);

export const skipped = (reason: VerifierSkipReason): VerifierVerdict => ({
  status: 'skipped',
  reason,
  claims: [],
  latencyMs: 3,
});

export const unavailable = (): VerifierVerdict => ({
  status: 'unavailable',
  reason: 'extractor_error',
  claims: [],
  latencyMs: 0,
});
