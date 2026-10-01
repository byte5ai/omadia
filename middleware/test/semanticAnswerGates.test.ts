import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// Imported from source (not the `@omadia/channel-sdk` dist barrel) — same
// rationale as aiDisclosure.test.ts: fields added after the last dist build.
import { toSemanticAnswer } from '../packages/harness-channel-sdk/src/toSemanticAnswer.js';
import type {
  ChatTurnResult,
  VerifierResultSummary,
} from '../packages/harness-channel-sdk/src/chatAgent.js';

const base: ChatTurnResult = { answer: 'Hallo.', toolCalls: 0, iterations: 0 };

function verifierSummary(
  overrides: Partial<VerifierResultSummary> = {},
): VerifierResultSummary {
  return {
    badge: 'verified',
    status: 'approved',
    claimCount: 2,
    contradictionCount: 0,
    unverifiedCount: 0,
    retryCount: 0,
    latencyMs: 5,
    mode: 'enforce',
    ...overrides,
  };
}

describe('toSemanticAnswer — verifier badge gate', () => {
  it('forwards the badge when the verifier actually checked claims', () => {
    const sa = toSemanticAnswer({ ...base, verifier: verifierSummary() });
    assert.deepEqual(sa.verifier, { status: 'verified' });
  });

  it('suppresses the badge when zero claims were extracted (nothing was checked)', () => {
    const sa = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({ claimCount: 0 }),
    });
    assert.equal(sa.verifier, undefined);
  });

  it('suppresses a pipeline failure (unavailable, nothing checked)', () => {
    // verifierService reports a pipeline that threw as `unavailable` — that
    // must never render as "✓ Antwort geprüft", nor as any other chip.
    const sa = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({
        badge: 'unavailable',
        status: 'unavailable',
        reason: 'pipeline_error',
        claimCount: 0,
        latencyMs: 0,
      }),
    });
    assert.equal(sa.verifier, undefined);
  });

  it('never forwards the unverified / unavailable badges to a connector', () => {
    for (const summary of [
      verifierSummary({ badge: 'unverified', status: 'skipped', reason: 'no_trigger', claimCount: 0 }),
      verifierSummary({ badge: 'unavailable', status: 'unavailable', reason: 'extractor_error', claimCount: 0 }),
      // Defensive: the gate is not a claim count alone. A summary claiming
      // checked claims but carrying a no-evidence badge or status still gets
      // no chip — the connector wire union has no value for it.
      verifierSummary({ badge: 'unverified', status: 'skipped', claimCount: 3 }),
      verifierSummary({ badge: 'verified', status: 'skipped', claimCount: 3 }),
      verifierSummary({ badge: 'verified', status: 'unavailable', claimCount: 3 }),
    ]) {
      const sa = toSemanticAnswer({ ...base, verifier: summary });
      assert.equal(sa.verifier, undefined, `${summary.status}/${summary.badge}`);
    }
  });

  it('keeps corrected/failed badges as long as claims were checked', () => {
    const sa = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({ badge: 'corrected', retryCount: 1 }),
    });
    assert.deepEqual(sa.verifier, { status: 'corrected' });
    const failed = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({ badge: 'failed', status: 'blocked', contradictionCount: 1 }),
    });
    assert.deepEqual(failed.verifier, { status: 'failed' });
  });

  it('forwards partial for an answer checked only in part', () => {
    const sa = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({
        badge: 'partial',
        status: 'approved_with_disclaimer',
        unverifiedCount: 1,
        uncheckedCount: 1,
      }),
    });
    assert.deepEqual(sa.verifier, { status: 'partial' });
  });

  it('never forwards a badge the summary counts do not back', () => {
    for (const summary of [
      // Green needs every claim confirmed on an approved verdict.
      verifierSummary({ badge: 'verified', unverifiedCount: 1 }),
      verifierSummary({ badge: 'verified', status: 'approved_with_disclaimer', unverifiedCount: 1 }),
      // Claims were checked, but none was confirmed.
      verifierSummary({ badge: 'partial', status: 'approved_with_disclaimer', unverifiedCount: 2 }),
      verifierSummary({ badge: 'corrected', status: 'approved_with_disclaimer', unverifiedCount: 2, retryCount: 1 }),
      // Blocked without a contradiction settles nothing.
      verifierSummary({ badge: 'failed', status: 'blocked', unverifiedCount: 2 }),
      // A corrected answer is not still contradicted.
      verifierSummary({ badge: 'corrected', status: 'blocked', contradictionCount: 1, retryCount: 1 }),
    ]) {
      const sa = toSemanticAnswer({ ...base, verifier: summary });
      assert.equal(sa.verifier, undefined, JSON.stringify(summary));
    }
  });
});

describe('toSemanticAnswer — memoryUsed forwarding', () => {
  it('forwards memoryUsed: true so channels can show the Fresh-Check affordance', () => {
    const sa = toSemanticAnswer({ ...base, memoryUsed: true });
    assert.equal(sa.memoryUsed, true);
  });

  it('omits the field when no memory contributed to the answer', () => {
    const sa = toSemanticAnswer(base);
    assert.equal(sa.memoryUsed, undefined);
  });
});
