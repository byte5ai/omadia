/**
 * Coverage of the claim extraction is explicit. The production
 * `ClaimExtractor` sends the model only the head of a long answer and asks it
 * for a bounded number of claims. Whatever an extraction did not cover —
 * answer text beyond its window, or claims a model that keeps to the limit
 * left out — must reach the verdict as a not-checked coverage entry, so the
 * answer is at most partly verified, never `approved` / `verified`.
 *
 * The model is a stub that behaves like a compliant extractor: it lists every
 * amount it can see in the prompt, in order, and keeps to the prompt's
 * "Return at most N claims". The checkers verify every claim they get, so
 * anything short of `approved` below comes from coverage alone.
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

/** "1.234,56 €"-style amounts: what the stub model recognises as a claim. */
const AMOUNT_PATTERN = /\d{1,3}(?:\.\d{3})*,\d{2} €/g;

interface ModelCall {
  system: string;
  user: string;
}

interface CompleteRequest {
  system?: string;
  messages: ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string }> }>;
}

/** A model that keeps to the extractor's prompt: every amount it can see, in
 *  order, and no more claims than the prompt allows. */
function obeyingModel(calls: ModelCall[]): ClaimExtractorOptions['llm'] {
  return {
    complete(req: CompleteRequest): Promise<unknown> {
      const system = req.system ?? '';
      const user = req.messages
        .flatMap((m) => m.content)
        .map((p) => p.text ?? '')
        .join('\n');
      calls.push({ system, user });
      const limit = Number(/Return at most (\d+) claims/.exec(system)?.[1] ?? Infinity);
      const shown = user.slice(user.indexOf('ASSISTANT ANSWER:'));
      const claims = (shown.match(AMOUNT_PATTERN) ?? [])
        .slice(0, limit)
        .map((text) => ({ text, type: 'amount', expected_source: 'odoo' }));
      return Promise.resolve({
        content: [{ type: 'tool_call', id: 'call_1', name: 'record_claims', input: { claims } }],
        finishReason: 'tool_calls',
        model: 'stub',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  } as unknown as ClaimExtractorOptions['llm'];
}

const verifyAll = (claims: Claim[]): Promise<ClaimVerdict[]> =>
  Promise.resolve(
    claims.map((c): ClaimVerdict => ({ status: 'verified', claim: c, source: 'odoo' })),
  );

/** The pipeline as `plugin.ts` wires it: one `maxClaims` for both stages. */
function pipelineOver(calls: ModelCall[], maxClaims?: number): VerifierPipeline {
  const cap = maxClaims === undefined ? {} : { maxClaims };
  return new VerifierPipeline({
    extractor: new ClaimExtractor({ llm: obeyingModel(calls), ...cap, log: () => undefined }),
    deterministic: { checkAll: verifyAll } as unknown as DeterministicChecker,
    judge: { checkAll: verifyAll } as unknown as EvidenceJudge,
    ...cap,
    log: () => undefined,
  });
}

const FILLER = 'Die weiteren Positionen dieser Liste nennen keinen Betrag. ';
const TAIL_AMOUNT = '98.765,43 €';

/** An ERP-style list answer longer than the extractor's window (6000
 *  characters): `head` first, an amount past the window at the end. */
function longAnswer(head: string): string {
  const answer = `${head}\n${FILLER.repeat(120)}\nDie Gesamtsumme beträgt ${TAIL_AMOUNT}.`;
  assert.ok(answer.length > 6000, 'the answer must exceed the extraction window');
  return answer;
}

const FIVE_AMOUNTS = 'Offen: 1.000,00 €, 2.000,00 €, 3.000,00 €, 4.000,00 € und 5.000,00 €.';
const THREE_AMOUNTS = 'Offen: 1.000,00 €, 2.000,00 € und 3.000,00 €.';

function verify(pipeline: VerifierPipeline, answer: string): Promise<VerifierVerdict> {
  return pipeline.verify({ runId: 'r-coverage', userMessage: 'Liste bitte', answer });
}

/** Coverage entries of a verdict: parts of the answer nobody checked. */
function coverageOf(verdict: VerifierVerdict): ClaimVerdict[] {
  return verdict.claims.filter((c) => c.claim.type === 'coverage_gap');
}

function statusCount(verdict: VerifierVerdict, status: ClaimVerdict['status']): number {
  return verdict.claims.filter((c) => c.status === status).length;
}

describe('ClaimExtractor — reports what it did not cover', () => {
  it('names text beyond its window as a gap, and nothing for a short answer', async () => {
    const extractor = new ClaimExtractor({ llm: obeyingModel([]), log: () => undefined });
    const long = await extractor.extract({
      userMessage: 'Liste bitte',
      answer: longAnswer('Die Rechnung beträgt 1.234,56 €.'),
    });
    assert.deepEqual(long.gaps, ['answer_beyond_window']);
    assert.deepEqual(
      long.claims.map((c) => c.text),
      ['1.234,56 €'],
    );
    const short = await extractor.extract({ userMessage: 'Und?', answer: THREE_AMOUNTS });
    assert.deepEqual(short.gaps, []);
    assert.equal(short.claims.length, 3);
  });

  it('asks for one claim more than its cap and names a full list as a gap', async () => {
    const calls: ModelCall[] = [];
    const extractor = new ClaimExtractor({
      llm: obeyingModel(calls),
      maxClaims: 3,
      log: () => undefined,
    });
    const full = await extractor.extract({ userMessage: 'Offen?', answer: FIVE_AMOUNTS });
    assert.match(calls[0]?.system ?? '', /Return at most 4 claims/);
    assert.equal(full.claims.length, 4, 'every valid claim is returned, none cut');
    assert.deepEqual(full.gaps, ['claim_list_full']);
    const atCap = await extractor.extract({ userMessage: 'Offen?', answer: THREE_AMOUNTS });
    assert.deepEqual(atCap.gaps, [], 'a list below the request limit is complete');
  });
});

describe('verifier coverage — answer text beyond the extraction window', () => {
  it('a long answer whose head verifies is partly verified, never approved', async () => {
    const calls: ModelCall[] = [];
    const verdict = await verify(
      pipelineOver(calls),
      longAnswer('Die Rechnung beträgt 1.234,56 €.'),
    );
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]?.user.includes(TAIL_AMOUNT), 'the tail amount never reaches the model');
    assert.notEqual(verdict.status, 'approved');
    assert.equal(verdict.status, 'approved_with_disclaimer');
    assert.equal(statusCount(verdict, 'verified'), 1);
    const coverage = coverageOf(verdict);
    assert.equal(coverage.length, 1, 'the uncovered tail is recorded in the verdict');
    assert.equal(coverage[0]?.status, 'unverified');
    assert.equal(coverage[0]?.status === 'unverified' ? coverage[0].cause : undefined, 'not_checked');
    assert.equal(badgeFor(verdict, 0), 'partial');
  });

  it('a long answer with nothing checkable in its head is skipped as incompletely covered', async () => {
    const verdict = await verify(pipelineOver([]), longAnswer('Hier ist die gewünschte Übersicht.'));
    assert.equal(verdict.status, 'skipped');
    assert.equal((verdict as { reason?: unknown }).reason, 'incomplete_coverage');
    assert.equal(badgeFor(verdict, 0), 'unverified');
  });

  it('control: an answer inside the window is approved without a coverage entry', async () => {
    const verdict = await verify(pipelineOver([]), 'Die Rechnung beträgt 1.234,56 €.');
    assert.equal(verdict.status, 'approved');
    assert.equal(coverageOf(verdict).length, 0);
    assert.equal(badgeFor(verdict, 0), 'verified');
  });
});

describe('verifier coverage — a model that keeps to the claim limit', () => {
  it('more claims than the cap: partly verified, never approved', async () => {
    const calls: ModelCall[] = [];
    const verdict = await verify(pipelineOver(calls, 3), FIVE_AMOUNTS);
    assert.notEqual(verdict.status, 'approved');
    assert.notEqual(badgeFor(verdict, 0), 'verified');
    assert.match(calls[0]?.system ?? '', /Return at most 4 claims/);
    assert.equal(verdict.status, 'approved_with_disclaimer');
    assert.equal(statusCount(verdict, 'verified'), 3, 'the cap bounds the checks');
    assert.equal(coverageOf(verdict).length, 1, 'the full list is recorded as a gap');
    assert.equal(badgeFor(verdict, 0), 'partial');
  });

  it('control: exactly as many claims as the cap is still fully verified', async () => {
    const verdict = await verify(pipelineOver([], 3), THREE_AMOUNTS);
    assert.equal(verdict.status, 'approved');
    assert.equal(verdict.claims.length, 3);
    assert.equal(badgeFor(verdict, 0), 'verified');
  });
});

describe('verifier coverage — an extractor that reports no coverage', () => {
  it('a bare claim list is not taken for a complete extraction', async () => {
    // An injected extractor that returns claims without saying what it
    // covered could hide part of the answer; it fails like any extractor.
    const claim: Claim = {
      id: 'c_001',
      text: '1.234,56 €',
      type: 'amount',
      expectedSource: 'odoo',
      relatedEntities: [],
    };
    const pipeline = new VerifierPipeline({
      extractor: {
        extract: () => Promise.resolve([claim]),
      } as unknown as ClaimExtractor,
      deterministic: { checkAll: verifyAll } as unknown as DeterministicChecker,
      judge: { checkAll: verifyAll } as unknown as EvidenceJudge,
      log: () => undefined,
    });
    const verdict = await verify(pipeline, 'Die Rechnung beträgt 1.234,56 €.');
    assert.equal(verdict.status, 'unavailable');
    assert.equal((verdict as { reason?: unknown }).reason, 'extractor_error');
  });
});

describe('verifier coverage — what the turn reports', () => {
  function serviceOver(answer: string): VerifierService {
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
      pipeline: pipelineOver([]),
      enabled: true,
      mode: 'shadow',
      log: () => undefined,
    });
  }

  it('a long answer is reported as partly verified on the stream and to connectors', async () => {
    const answer = longAnswer('Die Rechnung beträgt 1.234,56 €.');
    let summary: VerifierResultSummary | undefined;
    for await (const ev of serviceOver(answer).chatStream({ userMessage: 'Liste bitte' })) {
      if (ev.type === 'verifier') summary = ev.summary;
    }
    assert.ok(summary);
    assert.equal(summary.status, 'approved_with_disclaimer');
    assert.equal(summary.badge, 'partial');
    assert.equal(summary.uncoveredCount, 1);
    const sa = await serviceOver(answer).chat({ userMessage: 'Liste bitte' });
    assert.deepEqual(sa.verifier, { status: 'partial' });
  });
});
