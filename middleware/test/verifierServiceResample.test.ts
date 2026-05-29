/**
 * #132 — Confidence-Gated Re-Sampling.
 *
 * Covers:
 *   - `isBorderlineVerdict` for each VerifierVerdict status.
 *   - `mergeBorderlineVerdicts` for every relevant first/second pair.
 *
 * Note: a full end-to-end test of `VerifierService.chat` would need a
 * mock Orchestrator + VerifierPipeline plus a real Anthropic client
 * stand-in (300+ LoC of fixtures). The borderline/merge helpers carry
 * all the new decision logic; the wiring between them and the existing
 * retry path is enforced by the TypeScript compiler (private method
 * signature + `effectiveResult/Verdict` substitution).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  isBorderlineVerdict,
  type VerifierVerdict,
} from '@omadia/verifier';

import { mergeBorderlineVerdicts } from '../packages/harness-orchestrator/src/verifierService.js';

function approved(): VerifierVerdict {
  return { status: 'approved', claims: [], latencyMs: 0 };
}

function borderline(): VerifierVerdict {
  return {
    status: 'approved_with_disclaimer',
    claims: [],
    unverified: [],
    latencyMs: 0,
  };
}

function blocked(): VerifierVerdict {
  return {
    status: 'blocked',
    claims: [],
    contradictions: [],
    latencyMs: 0,
  };
}

describe('isBorderlineVerdict', () => {
  it('returns true only for approved_with_disclaimer', () => {
    assert.equal(isBorderlineVerdict(approved()), false);
    assert.equal(isBorderlineVerdict(borderline()), true);
    assert.equal(isBorderlineVerdict(blocked()), false);
  });
});

describe('mergeBorderlineVerdicts', () => {
  it('keeps first when second also lands on borderline (agreement)', () => {
    const merged = mergeBorderlineVerdicts(borderline(), borderline());
    assert.equal(merged.verdict.status, 'approved_with_disclaimer');
    assert.equal(merged.takeSecond, false);
  });

  it('keeps first when second relaxes to approved (no upgrade)', () => {
    const merged = mergeBorderlineVerdicts(borderline(), approved());
    assert.equal(merged.verdict.status, 'approved_with_disclaimer');
    assert.equal(merged.takeSecond, false);
  });

  it('takes second when it escalates to blocked (conservative)', () => {
    const merged = mergeBorderlineVerdicts(borderline(), blocked());
    assert.equal(merged.verdict.status, 'blocked');
    assert.equal(merged.takeSecond, true);
  });
});
