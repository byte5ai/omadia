import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildValidatorCorrectionPrompt,
  composeRetryHint,
} from '@omadia/orchestrator/dist/orchestrator.js';
import type { PrivacyOutputValidationResult } from '@omadia/plugin-api';

// ---------------------------------------------------------------------------
// Privacy-Shield v2 (D-2) — Orchestrator Retry-Loop helpers.
//
// The validator emits `recommendation: 'pass' | 'retry' | 'block'` plus a
// short `recommendationReason`. The orchestrator picks a correction
// prompt from the reason + spontaneous-PII presence and appends it to
// any caller-supplied `extraSystemHint`. These helpers run on every
// retry — pure functions, easy to test in isolation.
// ---------------------------------------------------------------------------

function mkVerdict(
  partial: Partial<PrivacyOutputValidationResult> = {},
): PrivacyOutputValidationResult {
  return {
    tokensMinted: 0,
    tokensRestored: 0,
    tokenLossRatio: 0,
    spontaneousPiiHits: [],
    recommendation: 'retry',
    ...partial,
  };
}

describe('buildValidatorCorrectionPrompt (Privacy-Shield D-2)', () => {
  it('returns the token-loss variant by default (HR-routine paraphrase mode)', () => {
    const prompt = buildValidatorCorrectionPrompt(
      mkVerdict({
        tokensMinted: 3,
        tokensRestored: 0,
        tokenLossRatio: 1,
        recommendationReason: 'token-loss ratio 1.00 exceeds threshold 0.30',
      }),
    );
    assert.match(prompt, /dropped privacy tokens/i);
    assert.match(prompt, /verbatim/i);
    assert.match(prompt, /<privacy-validator-retry>[\s\S]*<\/privacy-validator-retry>/);
    // The directive must NOT carry PII — only generic language.
    assert.doesNotMatch(prompt, /alice@example\.com/i);
  });

  it('returns the spontaneous-PII variant when the validator flagged fabricated values', () => {
    const prompt = buildValidatorCorrectionPrompt(
      mkVerdict({
        spontaneousPiiHits: [{ type: 'pii.email', detectorId: 'regex:0.1.0' }],
        recommendation: 'block',
        recommendationReason: 'spontaneous PII in output (1 hit)',
      }),
    );
    assert.match(prompt, /never supplied/i);
    assert.match(prompt, /clarifying question/i);
    assert.match(prompt, /<privacy-validator-retry>[\s\S]*<\/privacy-validator-retry>/);
  });

  it('treats a reason prefix as authoritative even with no spontaneousPiiHits', () => {
    const prompt = buildValidatorCorrectionPrompt(
      mkVerdict({
        spontaneousPiiHits: [],
        recommendationReason: 'spontaneous PII in output (0 hit)',
      }),
    );
    assert.match(prompt, /never supplied/i);
  });
});

describe('composeRetryHint (Privacy-Shield D-2)', () => {
  it('returns the correction verbatim when no existing hint is set', () => {
    const out = composeRetryHint(undefined, 'CORRECTION');
    assert.equal(out, 'CORRECTION');
  });

  it('returns the correction verbatim when existing hint is empty / whitespace only', () => {
    const out = composeRetryHint('   ', 'CORRECTION');
    assert.equal(out, 'CORRECTION');
  });

  it('concatenates existing hint + correction with a blank line separator', () => {
    const out = composeRetryHint('first-hint', 'CORRECTION');
    assert.equal(out, 'first-hint\n\nCORRECTION');
  });

  it('preserves verifier hint shape when a privacy correction is layered on', () => {
    const verifierHint = '<verifier-retry>do not contradict the source.</verifier-retry>';
    const correction = buildValidatorCorrectionPrompt(
      mkVerdict({ tokensMinted: 2, tokensRestored: 0, tokenLossRatio: 1 }),
    );
    const composed = composeRetryHint(verifierHint, correction);
    assert.ok(composed.startsWith(verifierHint));
    assert.match(composed, /<privacy-validator-retry>/);
  });
});
