/**
 * #131 — Citation Enforcement. The pipeline must:
 *   - Emit a synthetic `citation_missing` ClaimVerdict (status='contradicted')
 *     when the turn called the knowledge-graph AND the answer contains no
 *     `[ref:nodeId]` markers.
 *   - Stay silent when the turn didn't touch the graph (flag=false).
 *   - Stay silent when the answer carries at least one `[ref:...]` marker.
 *   - Stay silent when no trace evidence is available (flag=undefined).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  VerifierPipeline,
  type Claim,
  type ClaimExtraction,
  type ClaimExtractor,
  type ClaimVerdict,
  type DeterministicChecker,
  type EvidenceJudge,
  type HardClaim,
  type SoftClaim,
} from '@omadia/verifier';

function stubExtractor(claims: Claim[]): ClaimExtractor {
  return {
    extract(): Promise<ClaimExtraction> {
      return Promise.resolve({ claims, gaps: [] });
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

function hardClaim(): HardClaim {
  return {
    id: 'c_h',
    text: '1.234,56 €',
    type: 'amount',
    expectedSource: 'odoo',
    value: 1234.56,
    odooRecord: { model: 'account.move', id: 42 },
    relatedEntities: [],
  };
}

function softClaim(): SoftClaim {
  return {
    id: 'c_s',
    text: 'Foo ist Senior Dev',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: [],
  };
}

const SILENT_LOG = (): void => {
  /* silent */
};

function makePipeline(): VerifierPipeline {
  return new VerifierPipeline({
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
}

describe('verifier/pipeline — citation enforcement (#131)', () => {
  it('blocks when KG was called and the answer has no [ref:nodeId] marker', async () => {
    const pipeline = makePipeline();
    const verdict = await pipeline.verify({
      runId: 'r_cite_a',
      userMessage: 'Who is foo?',
      answer: 'Foo is a senior developer.',
      knowledgeGraphToolsCalled: true,
    });
    assert.equal(verdict.status, 'blocked');
    if (verdict.status === 'blocked') {
      const citation = verdict.contradictions.find(
        (v) => v.status === 'contradicted' && v.claim.type === 'citation_missing',
      );
      assert.ok(citation, 'citation_missing claim should be present');
      assert.equal(citation?.claim.id, 'c_citation_missing');
    }
  });

  it('KG called, citation present, no trigger signal → skipped/no_trigger (not approved)', async () => {
    // The citation check passes, but the answer carries no signal the
    // verifier checks, so nothing was verified — that is `skipped`, not a pass.
    const pipeline = makePipeline();
    const verdict = await pipeline.verify({
      runId: 'r_cite_b',
      userMessage: 'Who is foo?',
      answer: 'Foo is a senior developer [ref:n_user_42].',
      knowledgeGraphToolsCalled: true,
    });
    assert.equal(verdict.status, 'skipped');
    if (verdict.status === 'skipped') assert.equal(verdict.reason, 'no_trigger');
  });

  it('KG called, citation present, trigger fires and the claim verifies → approved', async () => {
    const pipeline = makePipeline();
    const verdict = await pipeline.verify({
      runId: 'r_cite_b2',
      userMessage: 'Wie hoch ist die Rechnung?',
      answer: 'Die Rechnung beträgt 1.234,56 € [ref:n_invoice_42].',
      knowledgeGraphToolsCalled: true,
    });
    assert.equal(verdict.status, 'approved');
    assert.equal(verdict.claims.length, 1);
    assert.ok(
      verdict.claims.every((c) => c.claim.type !== 'citation_missing'),
      'a present citation must not produce a citation_missing claim',
    );
  });

  it('approves when the turn never called the knowledge graph', async () => {
    const pipeline = makePipeline();
    const verdict = await pipeline.verify({
      runId: 'r_cite_c',
      userMessage: 'Was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
      knowledgeGraphToolsCalled: false,
    });
    assert.equal(verdict.status, 'approved');
  });

  it('approves when no trace evidence is available (knowledgeGraphToolsCalled=undefined)', async () => {
    const pipeline = makePipeline();
    const verdict = await pipeline.verify({
      runId: 'r_cite_d',
      userMessage: 'Was?',
      answer: 'Die Rechnung beträgt 1.234,56 €.',
    });
    assert.equal(verdict.status, 'approved');
  });
});

describe('verifier/correctionPrompt — citation_missing section (#131)', () => {
  it('emits a Fehlende-Citations section when citation_missing contradictions are present', async () => {
    const { buildCorrectionPrompt } = await import('@omadia/verifier');
    const verdict = {
      status: 'blocked' as const,
      claims: [],
      contradictions: [
        {
          status: 'contradicted' as const,
          claim: {
            id: 'c_citation_missing',
            text: 'Answer pulled knowledge-graph evidence but contains no [ref:nodeId] citations.',
            type: 'citation_missing' as const,
            expectedSource: 'graph' as const,
            relatedEntities: [],
          },
          truth: null,
          source: 'graph' as const,
          detail: 'Add `[ref:<nodeId>]` …',
        },
      ],
      latencyMs: 0,
    };
    const prompt = buildCorrectionPrompt(verdict);
    assert.ok(prompt);
    assert.match(prompt, /## Fehlende Citations/);
    assert.match(prompt, /\[ref:<id>\]/);
    assert.doesNotMatch(prompt, /## Tool-Output nicht spec-konform/);
    assert.doesNotMatch(prompt, /## Falsche \/ widerlegte Daten/);
  });
});
