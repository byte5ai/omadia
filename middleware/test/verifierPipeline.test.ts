import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  VerifierPipeline,
  type Claim,
  type ClaimExtractor,
  type ClaimVerdict,
  type DeterministicChecker,
  type EvidenceJudge,
  type HardClaim,
  type SoftClaim,
} from '@omadia/verifier';

// --- Stubs ---------------------------------------------------------------

function stubExtractor(claims: Claim[]): ClaimExtractor {
  return {
    extract(): Promise<Claim[]> {
      return Promise.resolve(claims);
    },
  } as unknown as ClaimExtractor;
}

function stubDeterministic(
  verdictFor: (c: HardClaim) => ClaimVerdict,
): DeterministicChecker {
  return {
    check(c: HardClaim): Promise<ClaimVerdict> {
      return Promise.resolve(verdictFor(c));
    },
    checkAll(claims: HardClaim[]): Promise<ClaimVerdict[]> {
      return Promise.all(claims.map((c) => Promise.resolve(verdictFor(c))));
    },
  } as unknown as DeterministicChecker;
}

function stubJudge(
  verdictFor: (c: SoftClaim) => ClaimVerdict,
): EvidenceJudge {
  return {
    check(c: SoftClaim): Promise<ClaimVerdict> {
      return Promise.resolve(verdictFor(c));
    },
    checkAll(claims: SoftClaim[]): Promise<ClaimVerdict[]> {
      return Promise.all(claims.map((c) => Promise.resolve(verdictFor(c))));
    },
  } as unknown as EvidenceJudge;
}

function hardClaim(overrides: Partial<HardClaim> = {}): HardClaim {
  return {
    id: 'c_h',
    text: '1.234,56 €',
    type: 'amount',
    expectedSource: 'odoo',
    value: 1234.56,
    sourceRecord: { model: 'account.move', id: 42 },
    relatedEntities: [],
    ...overrides,
  } as HardClaim;
}

function softClaim(overrides: Partial<SoftClaim> = {}): SoftClaim {
  return {
    id: 'c_s',
    text: 'John Doe ist Senior Dev',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: [],
    ...overrides,
  } as SoftClaim;
}

const SILENT_LOG = (): void => {
  /* silent */
};

// --- Tests ---------------------------------------------------------------

describe('verifier/pipeline', () => {
  it('approves smalltalk without triggering extractor', async () => {
    let called = false;
    const extractor = {
      extract(): Promise<Claim[]> {
        called = true;
        return Promise.resolve([]);
      },
    } as unknown as ClaimExtractor;
    const pipeline = new VerifierPipeline({
      extractor,
      deterministic: stubDeterministic(() => ({
        status: 'verified',
        claim: hardClaim(),
        source: 'odoo',
      })),
      judge: stubJudge(() => ({
        status: 'verified',
        claim: softClaim(),
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r1',
      userMessage: 'Hallo',
      answer: 'Hallo, wie kann ich helfen?',
    });
    assert.equal(verdict.status, 'approved');
    assert.equal(called, false);
  });

  it('approves when all claims verify', async () => {
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([hardClaim(), softClaim()]),
      deterministic: stubDeterministic((c) => ({
        status: 'verified',
        claim: c,
        source: 'odoo',
      })),
      judge: stubJudge((c) => ({
        status: 'verified',
        claim: c,
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r2',
      userMessage: 'Was?',
      answer: 'Die Rechnung beträgt 1.234,56 € und John bestätigt.',
    });
    assert.equal(verdict.status, 'approved');
    assert.equal(verdict.claims.length, 2);
  });

  it('blocks on contradiction', async () => {
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([hardClaim()]),
      deterministic: stubDeterministic((c) => ({
        status: 'contradicted',
        claim: c,
        truth: 9999,
        source: 'odoo',
      })),
      judge: stubJudge(
        () =>
          ({ status: 'verified', claim: softClaim(), source: 'graph' }) as ClaimVerdict,
      ),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r3',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
    });
    assert.equal(verdict.status, 'blocked');
    if (verdict.status === 'blocked') {
      assert.equal(verdict.contradictions.length, 1);
    }
  });

  it('approves_with_disclaimer when unverified but no contradictions', async () => {
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([hardClaim(), softClaim()]),
      deterministic: stubDeterministic((c) => ({
        status: 'unverified',
        claim: c,
        reason: 'record missing',
      })),
      judge: stubJudge((c) => ({
        status: 'verified',
        claim: c,
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r4',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 € für John Doe.',
    });
    assert.equal(verdict.status, 'approved_with_disclaimer');
    if (verdict.status === 'approved_with_disclaimer') {
      assert.equal(verdict.unverified.length, 1);
    }
  });

  it('approves when extractor returns no claims (trigger fired but nothing structured)', async () => {
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([]),
      deterministic: stubDeterministic(() => ({
        status: 'verified',
        claim: hardClaim(),
        source: 'odoo',
      })),
      judge: stubJudge(() => ({
        status: 'verified',
        claim: softClaim(),
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r5',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
    });
    assert.equal(verdict.status, 'approved');
  });

  it('approves odoo-amount claim when domainToolsCalled is restricted (trace-cross-check is no-op in core)', async () => {
    // traceMissingCallVerdict is intentionally a no-op in the core pipeline
    // (see comment in verifierPipeline.ts: "kept as hook so the pipeline shape
    // stays stable when a SourceChecker registry lands"). Domain-specific
    // replay detection (e.g. "odoo tool not called") belongs in a SourceChecker
    // plugin for that domain. The core pipeline passes all claims to the
    // deterministic checker regardless of domainToolsCalled.
    let checkerCalled = false;
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([hardClaim()]),
      deterministic: {
        check(): Promise<ClaimVerdict> {
          checkerCalled = true;
          return Promise.resolve({
            status: 'verified',
            claim: hardClaim(),
            source: 'odoo',
          });
        },
        checkAll(claims: HardClaim[]): Promise<ClaimVerdict[]> {
          if (claims.length > 0) checkerCalled = true;
          return Promise.resolve([]);
        },
      } as unknown as DeterministicChecker,
      judge: stubJudge((c) => ({
        status: 'verified',
        claim: c,
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r-replay',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
      domainToolsCalled: ['memory'],
    });
    assert.equal(verdict.status, 'approved');
    assert.equal(
      checkerCalled,
      true,
      'deterministic checker is always called (trace-cross-check is a no-op in core)',
    );
  });

  it('lets odoo-amount claim through when query_odoo_accounting was called', async () => {
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([hardClaim()]),
      deterministic: stubDeterministic((c) => ({
        status: 'verified',
        claim: c,
        source: 'odoo',
      })),
      judge: stubJudge((c) => ({
        status: 'verified',
        claim: c,
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r-withtool',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
      domainToolsCalled: ['query_odoo_accounting', 'memory'],
    });
    assert.equal(verdict.status, 'approved');
  });

  it('skips trace-cross-check when domainToolsCalled is undefined (no evidence either way)', async () => {
    const pipeline = new VerifierPipeline({
      extractor: stubExtractor([hardClaim()]),
      deterministic: stubDeterministic((c) => ({
        status: 'verified',
        claim: c,
        source: 'odoo',
      })),
      judge: stubJudge((c) => ({
        status: 'verified',
        claim: c,
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r-notrace',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
      // domainToolsCalled intentionally omitted
    });
    assert.equal(verdict.status, 'approved');
  });

  it('tolerates extractor throwing', async () => {
    const pipeline = new VerifierPipeline({
      extractor: {
        extract(): Promise<Claim[]> {
          return Promise.reject(new Error('rate limit'));
        },
      } as unknown as ClaimExtractor,
      deterministic: stubDeterministic(() => ({
        status: 'verified',
        claim: hardClaim(),
        source: 'odoo',
      })),
      judge: stubJudge(() => ({
        status: 'verified',
        claim: softClaim(),
        source: 'graph',
      })),
      log: SILENT_LOG,
    });
    const verdict = await pipeline.verify({
      runId: 'r6',
      userMessage: 'was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
    });
    assert.equal(verdict.status, 'approved');
  });
});
