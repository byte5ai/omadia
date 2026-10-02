/**
 * Every claim a model lists either reaches a checker or keeps the answer at
 * most partly verified. Two ways an extraction used to lose part of an answer
 * without a trace, so that the rest verifying made it `approved` / `verified`:
 *  - the verbatim guard dropped a well-formed claim whose text is not in the
 *    answer as written: a line break the model wrote as a space, or a subject
 *    it stitched in from elsewhere in the sentence (the prompt asks for
 *    qualitative claims that name their subject);
 *  - only the first `record_claims` call was read, so a list the model split
 *    over two calls lost its second part.
 *
 * Pinned with the production `ClaimExtractor`, `VerifierPipeline`, `badgeFor`
 * and `VerifierService`. The checkers stand in for a ledger that confirms the
 * invoice amount and contradicts every other claim, so a claim that is checked
 * shows up in the verdict, and one that is lost leaves the answer `verified`.
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
  type VerifierVerdict,
} from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatTurnResult,
  VerifierResultSummary,
} from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  badgeFor,
  VerifierService,
} from '../packages/harness-orchestrator/src/verifierService.js';

interface RawClaim {
  text: string;
  type: string;
  expected_source: string;
}

/** A model whose response holds one `record_claims` call per list given. */
function modelReturning(...calls: RawClaim[][]): ClaimExtractorOptions['llm'] {
  return {
    complete: (): Promise<unknown> =>
      Promise.resolve({
        content: calls.map((claims, i) => ({
          type: 'tool_call',
          id: `call_${String(i + 1)}`,
          name: 'record_claims',
          input: { claims },
        })),
        finishReason: 'tool_calls',
        model: 'stub',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
  } as unknown as ClaimExtractorOptions['llm'];
}

const INVOICE = '1.234,56 €';
const CREDIT_NOTE = '2.000,00 €';
const NBSP = String.fromCharCode(0xa0);

const amount = (text: string): RawClaim => ({ text, type: 'amount', expected_source: 'odoo' });

/** Checkers over a ledger: a claim naming a `confirmed` amount is verified,
 *  any other claim contradicted. Every claim a checker sees lands in `seen`. */
function ledger(
  seen: string[],
  confirmed: readonly string[] = [INVOICE],
): { deterministic: DeterministicChecker; judge: EvidenceJudge } {
  const checkAll = (claims: Claim[]): Promise<ClaimVerdict[]> => {
    seen.push(...claims.map((c) => c.text));
    return Promise.resolve(
      claims.map(
        (c): ClaimVerdict =>
          confirmed.some((a) => c.text.includes(a))
            ? { status: 'verified', claim: c, source: 'odoo' }
            : { status: 'contradicted', claim: c, truth: 'not in the ledger', source: 'odoo' },
      ),
    );
  };
  return {
    deterministic: { checkAll } as unknown as DeterministicChecker,
    judge: { checkAll } as unknown as EvidenceJudge,
  };
}

function pipelineOver(
  llm: ClaimExtractorOptions['llm'],
  seen: string[],
  confirmed?: readonly string[],
): VerifierPipeline {
  return new VerifierPipeline({
    extractor: new ClaimExtractor({ llm, log: () => undefined }),
    ...ledger(seen, confirmed),
    log: () => undefined,
  });
}

function verify(pipeline: VerifierPipeline, answer: string): Promise<VerifierVerdict> {
  return pipeline.verify({ runId: 'r-verbatim', userMessage: 'Wie stehen die Belege?', answer });
}

function coverageIds(verdict: VerifierVerdict): string[] {
  return verdict.claims.filter((c) => c.claim.type === 'coverage_gap').map((c) => c.claim.id);
}

/** The second amount sits after a line break; a model may write a space. */
const WRAPPED = `Die Rechnung beträgt ${INVOICE}. Die Gutschrift beträgt\n${CREDIT_NOTE}.`;
/** The subject of the move is "sie", two clauses away from "Anna Müller". */
const STITCHED = `Die Rechnung über ${INVOICE} hat Anna Müller am 03.02.2026 freigegeben. Danach wechselte sie in die IT-Abteilung.`;
const STITCHED_CLAIM: RawClaim = {
  text: 'Anna Müller wechselte in die IT-Abteilung',
  type: 'qualitative',
  expected_source: 'graph',
};
const TWO_AMOUNTS = `Die Rechnung beträgt ${INVOICE}. Die Gutschrift beträgt ${CREDIT_NOTE}.`;

describe('claim extraction — a claim whose text differs from the answer', () => {
  it('a line break written as a space still places the claim, which is then checked', async () => {
    const llm = modelReturning([amount(INVOICE), amount(`Die Gutschrift beträgt ${CREDIT_NOTE}`)]);
    const extraction = await new ClaimExtractor({ llm, log: () => undefined }).extract({
      userMessage: 'Und die Gutschrift?',
      answer: WRAPPED,
    });
    assert.deepEqual(
      extraction.claims.map((c) => c.text),
      [INVOICE, `Die Gutschrift beträgt\n${CREDIT_NOTE}`],
      'the claim carries the span of the answer it quotes',
    );
    assert.deepEqual(extraction.gaps, []);

    const seen: string[] = [];
    const verdict = await verify(pipelineOver(llm, seen), WRAPPED);
    assert.ok(seen.some((t) => t.includes(CREDIT_NOTE)), 'the credit note reaches a checker');
    assert.equal(verdict.status, 'blocked');
    assert.equal(badgeFor(verdict, 0), 'failed');
  });

  it('a non-breaking space or a change of case still quotes the answer, as written there', async () => {
    const answer = `Offen ist noch 1.234,56${NBSP}€ aus der Rechnung.`;
    const { claims, gaps } = await new ClaimExtractor({
      llm: modelReturning([amount(INVOICE), amount('OFFEN IST NOCH')]),
      log: () => undefined,
    }).extract({ userMessage: 'Was ist offen?', answer });
    assert.deepEqual(
      claims.map((c) => c.text),
      [`1.234,56${NBSP}€`, 'Offen ist noch'],
    );
    assert.deepEqual(gaps, []);
  });

  it('a claim not in the answer is a coverage gap: partly verified, never verified', async () => {
    const llm = modelReturning([amount(INVOICE), STITCHED_CLAIM]);
    const { claims, gaps } = await new ClaimExtractor({ llm, log: () => undefined }).extract({
      userMessage: 'Was ist mit Anna?',
      answer: STITCHED,
    });
    assert.deepEqual(
      claims.map((c) => c.text),
      [INVOICE],
      'the guard still keeps a claim the answer does not hold away from the checkers',
    );
    assert.deepEqual(gaps, ['claims_not_in_answer']);

    const seen: string[] = [];
    const verdict = await verify(pipelineOver(llm, seen), STITCHED);
    assert.deepEqual(seen, [INVOICE]);
    assert.notEqual(verdict.status, 'approved');
    assert.equal(verdict.status, 'approved_with_disclaimer');
    assert.deepEqual(coverageIds(verdict), ['c_coverage_claims_not_in_answer']);
    const gap = verdict.claims.find((c) => c.claim.type === 'coverage_gap');
    assert.equal(gap?.status === 'unverified' ? gap.cause : undefined, 'not_checked');
    assert.equal(badgeFor(verdict, 0), 'partial');
  });

  it('only claims the answer does not hold: skipped as incompletely covered, not "no claims"', async () => {
    const seen: string[] = [];
    const verdict = await verify(pipelineOver(modelReturning([STITCHED_CLAIM]), seen), STITCHED);
    assert.deepEqual(seen, []);
    assert.equal(verdict.status, 'skipped');
    assert.equal((verdict as { reason?: unknown }).reason, 'incomplete_coverage');
    assert.equal(badgeFor(verdict, 0), 'unverified');
  });

  it('control: every claim quoted as written is approved without a coverage entry', async () => {
    const verdict = await verify(
      pipelineOver(modelReturning([amount(INVOICE), amount(CREDIT_NOTE)]), [], [INVOICE, CREDIT_NOTE]),
      TWO_AMOUNTS,
    );
    assert.equal(verdict.status, 'approved');
    assert.deepEqual(coverageIds(verdict), []);
    assert.equal(badgeFor(verdict, 0), 'verified');
  });
});

describe('claim extraction — a list split over several record_claims calls', () => {
  it('reads every call: a contradiction in the second call blocks the answer', async () => {
    const llm = modelReturning([amount(INVOICE)], [amount(CREDIT_NOTE)]);
    const { claims, gaps } = await new ClaimExtractor({ llm, log: () => undefined }).extract({
      userMessage: 'Und die Gutschrift?',
      answer: TWO_AMOUNTS,
    });
    assert.deepEqual(
      claims.map((c) => [c.id, c.text]),
      [
        ['c_001', INVOICE],
        ['c_002', CREDIT_NOTE],
      ],
    );
    assert.deepEqual(gaps, []);

    const seen: string[] = [];
    const verdict = await verify(pipelineOver(llm, seen), TWO_AMOUNTS);
    assert.deepEqual(seen, [INVOICE, CREDIT_NOTE], 'the second call reaches a checker');
    assert.equal(verdict.status, 'blocked');
    assert.equal(badgeFor(verdict, 0), 'failed');
  });

  it('control: two calls whose claims all check out are verified over both', async () => {
    const verdict = await verify(
      pipelineOver(modelReturning([amount(INVOICE)], [amount(CREDIT_NOTE)]), [], [INVOICE, CREDIT_NOTE]),
      TWO_AMOUNTS,
    );
    assert.equal(verdict.status, 'approved');
    assert.equal(verdict.claims.length, 2);
    assert.equal(badgeFor(verdict, 0), 'verified');
  });

  it('a call without a claims array next to a valid one fails the extraction', async () => {
    const llm = {
      complete: (): Promise<unknown> =>
        Promise.resolve({
          content: [
            { type: 'tool_call', id: 'call_1', name: 'record_claims', input: { claims: [amount(INVOICE)] } },
            { type: 'tool_call', id: 'call_2', name: 'record_claims', input: amount(CREDIT_NOTE) },
          ],
          finishReason: 'tool_calls',
          model: 'stub',
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
    } as unknown as ClaimExtractorOptions['llm'];
    const seen: string[] = [];
    const verdict = await verify(pipelineOver(llm, seen), TWO_AMOUNTS);
    assert.deepEqual(seen, [], 'a partly unreadable extraction checks nothing');
    assert.equal(verdict.status, 'unavailable');
    assert.equal((verdict as { reason?: unknown }).reason, 'extractor_error');
  });
});

describe('claim extraction — what the turn reports for a claim it could not place', () => {
  function serviceOver(answer: string, llm: ClaimExtractorOptions['llm']): VerifierService {
    const orchestrator = {
      agentId: 'default',
      async *chatStream(): AsyncGenerator<ChatStreamEvent> {
        await Promise.resolve();
        yield { type: 'done', answer, toolCalls: 1, iterations: 1 };
      },
      runTurn: (): Promise<ChatTurnResult> =>
        Promise.resolve({ answer, toolCalls: 1, iterations: 1 }),
    } as unknown as Orchestrator;
    return new VerifierService({
      orchestrator,
      pipeline: pipelineOver(llm, []),
      enabled: true,
      mode: 'shadow',
      log: () => undefined,
    });
  }

  it('is partly verified on the stream and to connectors, never verified', async () => {
    const llm = modelReturning([amount(INVOICE), STITCHED_CLAIM]);
    let summary: VerifierResultSummary | undefined;
    for await (const ev of serviceOver(STITCHED, llm).chatStream({ userMessage: 'Und Anna?' })) {
      if (ev.type === 'verifier') summary = ev.summary;
    }
    assert.ok(summary);
    assert.equal(summary.status, 'approved_with_disclaimer');
    assert.equal(summary.badge, 'partial');
    assert.equal(summary.uncoveredCount, 1);
    const sa = await serviceOver(STITCHED, llm).chat({ userMessage: 'Und Anna?' });
    assert.deepEqual(sa.verifier, { status: 'partial' });
  });
});
