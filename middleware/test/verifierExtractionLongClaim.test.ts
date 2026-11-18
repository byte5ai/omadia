/**
 * A claim is never shortened before it is checked. The extractor used to cut
 * every claim to its first 300 characters before the verbatim guard looked at
 * it, so neither the guard nor the `claims_not_in_answer` gap ever saw the
 * rest: a long claim whose tail is not in the answer was checked on its head
 * and could make the answer `approved` / `verified`, and a long claim that is
 * in the answer was checked only in part — by the evidence judge as well.
 *
 * The guard now matches the whole claim. A claim that quotes the answer but is
 * longer than a check takes (`MAX_CLAIM_CHARS`) is reported as the
 * `claims_too_long` gap instead of being cut to fit. Pinned with the
 * production `ClaimExtractor`, `VerifierPipeline`, `badgeFor`,
 * `VerifierService` and `toSemanticAnswer`. The checkers stand in for a
 * ledger that confirms the invoice amount, so a claim cut down to its head —
 * which names that amount — would verify.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ClaimExtractor,
  MAX_CLAIM_CHARS,
  VerifierPipeline,
  type Claim,
  type ClaimExtraction,
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

/** A model whose response holds one `record_claims` call with these claims. */
function modelReturning(claims: RawClaim[]): ClaimExtractorOptions['llm'] {
  return {
    complete: (): Promise<unknown> =>
      Promise.resolve({
        content: [{ type: 'tool_call', id: 'call_1', name: 'record_claims', input: { claims } }],
        finishReason: 'tool_calls',
        model: 'stub',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
  } as unknown as ClaimExtractorOptions['llm'];
}

const INVOICE = '1.234,56 €';
const CREDIT_NOTE = '2.000,00 €';
/** Neutral text between the two amounts: no figure, date or reference. */
const FILLER = 'Der Beleg liegt im Archiv, das Team hat ihn gegengezeichnet und abgelegt. '.repeat(4);
const ANSWER = `Die Rechnung beträgt ${INVOICE}. ${FILLER}Die Gutschrift beträgt ${CREDIT_NOTE}.`;

const amount = (text: string): RawClaim => ({ text, type: 'amount', expected_source: 'odoo' });
const qualitative = (text: string): RawClaim => ({
  text,
  type: 'qualitative',
  expected_source: 'graph',
});

/** The answer's head followed by a sentence the answer does not hold. */
const TAIL_NOT_IN_ANSWER = `${ANSWER.slice(0, MAX_CLAIM_CHARS)} Die Gutschrift beträgt 9.999,99 €`;
/** A claim the answer holds word for word, longer than a check takes. */
const LONG_VERBATIM = ANSWER.slice(0, MAX_CLAIM_CHARS + 35);
/** Exactly as long as a check takes, and one character more. */
const EXACTLY_MAX = ANSWER.slice(0, MAX_CLAIM_CHARS);
const ONE_OVER = ANSWER.slice(0, MAX_CLAIM_CHARS + 1);

/** Checkers over a ledger that holds the invoice amount: a claim naming it is
 *  verified, any other claim contradicted. Every claim a checker sees — the
 *  deterministic re-query and the evidence judge alike — lands in `seen`. */
function ledger(seen: string[]): { deterministic: DeterministicChecker; judge: EvidenceJudge } {
  const checkAll = (claims: Claim[]): Promise<ClaimVerdict[]> => {
    seen.push(...claims.map((c) => c.text));
    return Promise.resolve(
      claims.map(
        (c): ClaimVerdict =>
          c.text.includes(INVOICE)
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

function extract(claims: RawClaim[]): Promise<ClaimExtraction> {
  return new ClaimExtractor({ llm: modelReturning(claims), log: () => undefined }).extract({
    userMessage: 'Wie stehen die Belege?',
    answer: ANSWER,
  });
}

function pipelineOver(claims: RawClaim[], seen: string[]): VerifierPipeline {
  return new VerifierPipeline({
    extractor: new ClaimExtractor({ llm: modelReturning(claims), log: () => undefined }),
    ...ledger(seen),
    log: () => undefined,
  });
}

function verify(claims: RawClaim[], seen: string[] = []): Promise<VerifierVerdict> {
  return pipelineOver(claims, seen).verify({
    runId: 'r-long-claim',
    userMessage: 'Wie stehen die Belege?',
    answer: ANSWER,
  });
}

function coverageIds(verdict: VerifierVerdict): string[] {
  return verdict.claims.filter((c) => c.claim.type === 'coverage_gap').map((c) => c.claim.id);
}

/** What every extraction below must hold: each claim is a part of the answer,
 *  never longer than a check takes. */
function assertWhole(extraction: ClaimExtraction): void {
  for (const c of extraction.claims) {
    assert.ok(ANSWER.includes(c.text), `claim text is part of the answer: ${c.text}`);
    assert.ok(c.text.length <= MAX_CLAIM_CHARS, `claim of ${String(c.text.length)} chars`);
  }
}

describe('claim extraction — a claim longer than a check takes', () => {
  it('fixtures: the long claims are what their names say', () => {
    assert.ok(TAIL_NOT_IN_ANSWER.length > MAX_CLAIM_CHARS);
    assert.ok(!ANSWER.includes(TAIL_NOT_IN_ANSWER));
    assert.ok(ANSWER.startsWith(TAIL_NOT_IN_ANSWER.slice(0, MAX_CLAIM_CHARS)));
    assert.ok(TAIL_NOT_IN_ANSWER.slice(0, MAX_CLAIM_CHARS).includes(INVOICE), 'the head verifies');
    assert.equal(LONG_VERBATIM.trim(), LONG_VERBATIM);
    assert.equal(EXACTLY_MAX.trim().length, MAX_CLAIM_CHARS);
    assert.equal(ONE_OVER.trim().length, MAX_CLAIM_CHARS + 1);
  });

  it('a long claim whose tail is not in the answer is a coverage gap: partly verified, never verified', async () => {
    const claims = [amount(INVOICE), amount(TAIL_NOT_IN_ANSWER)];
    const extraction = await extract(claims);
    assertWhole(extraction);
    assert.deepEqual(
      extraction.claims.map((c) => c.text),
      [INVOICE],
      'the head of the long claim never reaches a checker on its own',
    );
    assert.deepEqual(extraction.gaps, ['claims_not_in_answer']);

    const seen: string[] = [];
    const verdict = await verify(claims, seen);
    assert.deepEqual(seen, [INVOICE]);
    assert.equal(verdict.status, 'approved_with_disclaimer');
    assert.deepEqual(coverageIds(verdict), ['c_coverage_claims_not_in_answer']);
    assert.equal(badgeFor(verdict, 0), 'partial');
  });

  it('on its own, such a claim leaves the answer skipped as incompletely covered, not verified', async () => {
    const seen: string[] = [];
    const verdict = await verify([amount(TAIL_NOT_IN_ANSWER)], seen);
    assert.deepEqual(seen, []);
    assert.equal(verdict.status, 'skipped');
    assert.equal((verdict as { reason?: unknown }).reason, 'incomplete_coverage');
    assert.equal(badgeFor(verdict, 0), 'unverified');
  });

  it('a long claim the answer does hold is a coverage gap, never a shortened claim — for the judge too', async () => {
    const claims = [amount(INVOICE), qualitative(LONG_VERBATIM)];
    const extraction = await extract(claims);
    assertWhole(extraction);
    assert.deepEqual(extraction.claims.map((c) => c.text), [INVOICE]);
    assert.deepEqual(extraction.gaps, ['claims_too_long']);

    const seen: string[] = [];
    const verdict = await verify(claims, seen);
    assert.deepEqual(seen, [INVOICE], 'the judge never sees the long claim cut to its head');
    assert.equal(verdict.status, 'approved_with_disclaimer');
    assert.deepEqual(coverageIds(verdict), ['c_coverage_claims_too_long']);
    const gap = verdict.claims.find((c) => c.claim.type === 'coverage_gap');
    assert.equal(gap?.status === 'unverified' ? gap.cause : undefined, 'not_checked');
    assert.equal(badgeFor(verdict, 0), 'partial');
  });

  it('a claim exactly as long as a check takes is checked whole; one character more is a gap', async () => {
    const whole = await extract([amount(EXACTLY_MAX)]);
    assertWhole(whole);
    assert.deepEqual(whole.claims.map((c) => c.text), [EXACTLY_MAX]);
    assert.deepEqual(whole.gaps, []);
    const seen: string[] = [];
    const checked = await verify([amount(EXACTLY_MAX)], seen);
    assert.deepEqual(seen, [EXACTLY_MAX]);
    assert.equal(checked.status, 'approved');
    assert.equal(badgeFor(checked, 0), 'verified');

    const over = await extract([amount(ONE_OVER)]);
    assert.deepEqual(over.claims, []);
    assert.deepEqual(over.gaps, ['claims_too_long']);
    const notChecked = await verify([amount(ONE_OVER)]);
    assert.equal(notChecked.status, 'skipped');
    assert.equal((notChecked as { reason?: unknown }).reason, 'incomplete_coverage');
    assert.equal(badgeFor(notChecked, 0), 'unverified');
  });
});

describe('claim extraction — what the turn reports for a claim it could not check whole', () => {
  function serviceOver(claims: RawClaim[]): VerifierService {
    const orchestrator = {
      agentId: 'default',
      async *chatStream(): AsyncGenerator<ChatStreamEvent> {
        await Promise.resolve();
        yield { type: 'done', answer: ANSWER, toolCalls: 1, iterations: 1 };
      },
      runTurn: (): Promise<ChatTurnResult> =>
        Promise.resolve({ answer: ANSWER, toolCalls: 1, iterations: 1 }),
    } as unknown as Orchestrator;
    return new VerifierService({
      orchestrator,
      pipeline: pipelineOver(claims, []),
      enabled: true,
      mode: 'shadow',
      log: () => undefined,
    });
  }

  it('is partly verified on the stream and to connectors, never verified', async () => {
    for (const long of [amount(TAIL_NOT_IN_ANSWER), qualitative(LONG_VERBATIM)]) {
      const claims = [amount(INVOICE), long];
      let summary: VerifierResultSummary | undefined;
      for await (const ev of serviceOver(claims).chatStream({ userMessage: 'Und die Belege?' })) {
        if (ev.type === 'verifier') summary = ev.summary;
      }
      assert.ok(summary);
      assert.equal(summary.status, 'approved_with_disclaimer');
      assert.equal(summary.badge, 'partial');
      assert.equal(summary.uncoveredCount, 1);
      const sa = await serviceOver(claims).chat({ userMessage: 'Und die Belege?' });
      assert.deepEqual(sa.verifier, { status: 'partial' });
    }
  });
});
