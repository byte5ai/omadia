/**
 * The pipeline's verdict is bound to evidence. Four paths check nothing — no
 * trigger signal, an extractor that fails, zero extracted claims, claims no
 * checker accepts — and none of them may come back `approved`. They are
 * `skipped` (ran, nothing checkable) or `unavailable` (could not run), each
 * with a closed reason code. `approved` needs at least one checked claim, all
 * of them verified. The last block drives the production `ClaimExtractor`, so
 * an LLM outage is proven to land in `unavailable`, not in `skipped`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ClaimExtractor,
  VerifierPipeline,
  type Claim,
  type ClaimExtractorOptions,
  type ClaimVerdict,
  type DeterministicChecker,
  type EvidenceJudge,
  type HardClaim,
  type SoftClaim,
  type VerifierInput,
  type VerifierVerdict,
} from '@omadia/verifier';

function hardClaim(overrides: Partial<Claim> = {}): HardClaim {
  return {
    id: 'c_h',
    text: '1.234,56 €',
    type: 'amount',
    expectedSource: 'odoo',
    value: 1234.56,
    odooRecord: { model: 'account.move', id: 42 },
    relatedEntities: [],
    ...overrides,
  } as HardClaim;
}

function softClaim(overrides: Partial<Claim> = {}): SoftClaim {
  return {
    id: 'c_s',
    text: 'John Doe ist Senior Dev',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: [],
    ...overrides,
  } as SoftClaim;
}

interface Harness {
  pipeline: VerifierPipeline;
  extractCalls: () => number;
  checkedClaims: () => number;
  logs: string[];
}

/** Pipeline whose extractor yields `claims` (or rejects with `fail`) and whose
 *  checkers verify every claim they are handed — so any non-`approved` result
 *  below comes from the pipeline's own classification, not a checker verdict. */
function harness(opts: { claims?: Claim[]; fail?: Error }): Harness {
  let extractCalls = 0;
  let checked = 0;
  const logs: string[] = [];
  const verifyAll = <C extends Claim>(claims: C[]): Promise<ClaimVerdict[]> => {
    checked += claims.length;
    return Promise.resolve(
      claims.map((c): ClaimVerdict => ({ status: 'verified', claim: c, source: 'odoo' })),
    );
  };
  const extractor = {
    extract(): Promise<Claim[]> {
      extractCalls += 1;
      return opts.fail ? Promise.reject(opts.fail) : Promise.resolve(opts.claims ?? []);
    },
  } as unknown as ClaimExtractor;
  const pipeline = new VerifierPipeline({
    extractor,
    deterministic: { checkAll: verifyAll } as unknown as DeterministicChecker,
    judge: { checkAll: verifyAll } as unknown as EvidenceJudge,
    log: (msg) => {
      logs.push(msg);
    },
  });
  return { pipeline, extractCalls: () => extractCalls, checkedClaims: () => checked, logs };
}

function input(answer: string, extra: Partial<VerifierInput> = {}): VerifierInput {
  return { runId: 'r-states', userMessage: 'Frage', answer, ...extra };
}

/** The reason a `skipped` / `unavailable` verdict carries; undefined otherwise. */
function reasonOf(verdict: VerifierVerdict): unknown {
  return (verdict as { reason?: unknown }).reason;
}

const TRIGGERING_ANSWER = 'Die Rechnung beträgt 1.234,56 €.';

describe('verifier/pipeline — evidence-bound verdict states', () => {
  it('smalltalk yields skipped/no_trigger and never calls the extractor', async () => {
    const h = harness({ claims: [hardClaim()] });
    const verdict = await h.pipeline.verify(input('Hallo, wie kann ich helfen?'));
    assert.equal(verdict.status, 'skipped');
    assert.equal(reasonOf(verdict), 'no_trigger');
    assert.equal(verdict.claims.length, 0);
    assert.equal(h.extractCalls(), 0);
  });

  it('trigger fired but the extractor returned nothing → skipped/no_claims', async () => {
    const h = harness({ claims: [] });
    const verdict = await h.pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(h.extractCalls(), 1, 'the currency amount must fire the trigger');
    assert.equal(verdict.status, 'skipped');
    assert.equal(reasonOf(verdict), 'no_claims');
    assert.equal(verdict.claims.length, 0);
  });

  it('extractor throws with no synthetic verdicts → unavailable/extractor_error', async () => {
    const h = harness({ fail: new Error('rate limit from llm.example.invalid') });
    const verdict = await h.pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(verdict.status, 'unavailable');
    assert.equal(reasonOf(verdict), 'extractor_error');
    assert.equal(verdict.claims.length, 0);
    // The reason is a closed code — the error text stays in the operator log
    // and never rides the verdict (which is forwarded on the stream).
    assert.doesNotMatch(JSON.stringify(verdict), /llm\.example\.invalid|rate limit/);
    assert.ok(
      h.logs.some((l) => l.includes('rate limit')),
      'the extractor failure is still logged with its message',
    );
  });

  it('extractor throws but a postcondition violation is present → still blocked', async () => {
    const h = harness({ fail: new Error('rate limit') });
    const verdict = await h.pipeline.verify(
      input(TRIGGERING_ANSWER, {
        toolPostconditionViolations: [
          { toolName: 'list_invoices', callId: 'call_1', agentContext: 'agent-a', issues: ['x'] },
        ],
      }),
    );
    assert.equal(verdict.status, 'blocked');
    if (verdict.status === 'blocked') {
      assert.equal(verdict.contradictions.length, 1);
      assert.equal(verdict.contradictions[0]?.claim.type, 'tool_postcondition');
    }
  });

  it('claims that fit no checker → skipped/no_checkable_claims', async () => {
    // An amount with an unknown source is neither a hard nor a soft claim; the
    // pipeline drops it rather than invent a check.
    const h = harness({ claims: [hardClaim({ expectedSource: 'unknown' })] });
    const verdict = await h.pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(verdict.status, 'skipped');
    assert.equal(reasonOf(verdict), 'no_checkable_claims');
    assert.equal(h.checkedClaims(), 0);
  });

  it('no trigger signal but a KG citation is missing → blocked, not skipped', async () => {
    const h = harness({ claims: [] });
    const verdict = await h.pipeline.verify(
      input('Foo ist ein Senior Developer.', { knowledgeGraphToolsCalled: true }),
    );
    assert.equal(h.extractCalls(), 0);
    assert.equal(verdict.status, 'blocked');
    if (verdict.status === 'blocked') {
      assert.equal(verdict.contradictions[0]?.claim.type, 'citation_missing');
    }
  });

  it('no evidence-free path ever reaches approved', async () => {
    const paths: Array<[string, Harness, string]> = [
      ['no trigger', harness({ claims: [hardClaim()] }), 'Danke, das war alles.'],
      ['no claims', harness({ claims: [] }), TRIGGERING_ANSWER],
      ['extractor error', harness({ fail: new Error('boom') }), TRIGGERING_ANSWER],
      [
        'no checkable claims',
        harness({ claims: [hardClaim({ expectedSource: 'unknown' })] }),
        TRIGGERING_ANSWER,
      ],
    ];
    for (const [name, h, answer] of paths) {
      const verdict = await h.pipeline.verify(input(answer));
      assert.notEqual(verdict.status, 'approved', `${name} must not approve`);
      assert.ok(
        verdict.status === 'skipped' || verdict.status === 'unavailable',
        `${name}: expected skipped/unavailable, got ${verdict.status}`,
      );
    }
  });

  it('approved always carries evidence: at least one claim, every claim verified', async () => {
    const cases: Array<[string, Claim[]]> = [
      ['hard only', [hardClaim()]],
      ['soft only', [softClaim()]],
      ['hard + soft', [hardClaim(), softClaim()]],
    ];
    for (const [name, claims] of cases) {
      const verdict = await harness({ claims }).pipeline.verify(
        input('Die Rechnung vom 12.03.2026 beträgt 1.234,56 € für John Doe.'),
      );
      assert.equal(verdict.status, 'approved', name);
      assert.ok(verdict.claims.length >= 1, `${name}: approved without a claim`);
      assert.ok(
        verdict.claims.every((c) => c.status === 'verified'),
        `${name}: approved with an unverified claim`,
      );
    }
  });
});

/**
 * The production `ClaimExtractor` over a scripted LLM `complete()`: the
 * pipeline meets the extractor's own failure handling, not a stub that throws.
 * No claim reaches a checker on these paths, so the checkers reject if called.
 */
function realExtractorPipeline(complete: () => Promise<unknown>): {
  pipeline: VerifierPipeline;
  logs: string[];
} {
  const logs: string[] = [];
  const log = (msg: string): void => {
    logs.push(msg);
  };
  const unreachable = (): Promise<ClaimVerdict[]> =>
    Promise.reject(new Error('no claim may reach a checker on this path'));
  const pipeline = new VerifierPipeline({
    extractor: new ClaimExtractor({
      llm: { complete } as unknown as ClaimExtractorOptions['llm'],
      log,
    }),
    deterministic: { checkAll: unreachable } as unknown as DeterministicChecker,
    judge: { checkAll: unreachable } as unknown as EvidenceJudge,
    log,
  });
  return { pipeline, logs };
}

function recordClaimsCall(input: unknown): unknown {
  return {
    content: [{ type: 'tool_call', id: 'call_1', name: 'record_claims', input }],
    finishReason: 'tool_calls',
    model: 'stub',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe('verifier/pipeline — the production extractor reports an outage as unavailable', () => {
  it('LLM call rejects → unavailable/extractor_error, not skipped/no_claims', async () => {
    const { pipeline, logs } = realExtractorPipeline(() =>
      Promise.reject(new Error('rate limit from llm.example.invalid')),
    );
    const verdict = await pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(verdict.status, 'unavailable');
    assert.equal(reasonOf(verdict), 'extractor_error');
    assert.equal(verdict.claims.length, 0);
    assert.doesNotMatch(JSON.stringify(verdict), /llm\.example\.invalid|rate limit/);
    assert.ok(
      logs.some((l) => l.startsWith('[claim-extractor] API FAIL') && l.includes('rate limit')),
      'the extractor keeps its own failure log line',
    );
  });

  it('response without the record_claims call → unavailable/extractor_error', async () => {
    const { pipeline } = realExtractorPipeline(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'Keine Angaben.' }],
        finishReason: 'stop',
        model: 'stub',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const verdict = await pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(verdict.status, 'unavailable');
    assert.equal(reasonOf(verdict), 'extractor_error');
  });

  it('a record_claims call without a claims array → unavailable/extractor_error', async () => {
    const { pipeline } = realExtractorPipeline(() =>
      Promise.resolve(recordClaimsCall({ text: '1.234,56 €', type: 'amount' })),
    );
    const verdict = await pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(verdict.status, 'unavailable');
    assert.equal(reasonOf(verdict), 'extractor_error');
  });

  it('an empty claims array is a real zero-claim result → skipped/no_claims', async () => {
    const { pipeline } = realExtractorPipeline(() =>
      Promise.resolve(recordClaimsCall({ claims: [] })),
    );
    const verdict = await pipeline.verify(input(TRIGGERING_ANSWER));
    assert.equal(verdict.status, 'skipped');
    assert.equal(reasonOf(verdict), 'no_claims');
  });
});
