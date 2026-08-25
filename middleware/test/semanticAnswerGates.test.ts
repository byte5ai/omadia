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

  it('suppresses the pipeline-failure fallback (approved with empty claim list)', () => {
    // verifierService returns `{ status: 'approved', claims: [] }` when the
    // pipeline throws — that must never render as "✓ Antwort geprüft".
    const sa = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({ claimCount: 0, latencyMs: 0 }),
    });
    assert.equal(sa.verifier, undefined);
  });

  it('keeps corrected/failed badges as long as claims were checked', () => {
    const sa = toSemanticAnswer({
      ...base,
      verifier: verifierSummary({ badge: 'corrected', retryCount: 1 }),
    });
    assert.deepEqual(sa.verifier, { status: 'corrected' });
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
