/**
 * What `VerifierService` reports for a turn is bound to evidence:
 *   - a pipeline that throws is `unavailable` (badge `unavailable`), with a
 *     closed reason code and no error text on the stream event;
 *   - a verdict without checked claims never earns `verified` or `corrected`,
 *     whatever status the (injected) pipeline put on it;
 *   - `skipped` / `unavailable` never buy a paid resample or a retry.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ClaimVerdict, VerifierPipeline, VerifierVerdict } from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatTurnResult,
  VerifierResultSummary,
} from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  badgeFor,
  mergeBadges,
  VerifierService,
} from '../packages/harness-orchestrator/src/verifierService.js';

const AMOUNT = {
  id: 'c_1',
  text: '1.234,56 €',
  type: 'amount' as const,
  expectedSource: 'odoo' as const,
  relatedEntities: [],
};
const VERIFIED: ClaimVerdict = { status: 'verified', claim: AMOUNT, source: 'odoo' };
const UNVERIFIED: ClaimVerdict = { status: 'unverified', claim: AMOUNT, reason: 'no evidence' };
const CONTRADICTED: ClaimVerdict = {
  status: 'contradicted',
  claim: AMOUNT,
  truth: 999,
  source: 'odoo',
};

const approved = (): VerifierVerdict => ({ status: 'approved', claims: [VERIFIED], latencyMs: 1 });
const borderline = (): VerifierVerdict => ({
  status: 'approved_with_disclaimer',
  claims: [VERIFIED, UNVERIFIED],
  unverified: [UNVERIFIED],
  latencyMs: 1,
});
const blocked = (): VerifierVerdict => ({
  status: 'blocked',
  claims: [CONTRADICTED],
  contradictions: [CONTRADICTED],
  latencyMs: 1,
});
const skipped = (): VerifierVerdict => ({
  status: 'skipped',
  reason: 'no_trigger',
  claims: [],
  latencyMs: 1,
});
const unavailable = (): VerifierVerdict => ({
  status: 'unavailable',
  reason: 'pipeline_error',
  claims: [],
  latencyMs: 0,
});
/** What `safeVerify` used to return when the pipeline threw — `approved`
 *  over zero claims. No longer constructible by the typed pipeline, but an
 *  injected one could still send it, so the badge mapper must not trust it. */
const approvedWithoutClaims = (): VerifierVerdict =>
  ({ status: 'approved', claims: [], latencyMs: 0 }) as unknown as VerifierVerdict;

const ANSWER = 'Die Rechnung beträgt 1.234,56 €.';

/** Streams one ordinary `done` through the service and returns the summary of
 *  the trailing `verifier` event plus every log line. */
async function streamVerifier(
  verify: () => Promise<VerifierVerdict>,
): Promise<{ summary: VerifierResultSummary | undefined; logs: string[] }> {
  const logs: string[] = [];
  const orchestrator = {
    agentId: 'default',
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      await Promise.resolve();
      yield { type: 'done', answer: ANSWER, toolCalls: 1, iterations: 1 };
    },
  } as unknown as Orchestrator;
  const service = new VerifierService({
    orchestrator,
    pipeline: { verify } as unknown as VerifierPipeline,
    enabled: true,
    mode: 'shadow',
    log: (msg) => {
      logs.push(msg);
    },
  });
  let summary: VerifierResultSummary | undefined;
  for await (const ev of service.chatStream({ userMessage: 'Wie hoch ist die Rechnung?' })) {
    if (ev.type === 'verifier') summary = ev.summary;
  }
  return { summary, logs };
}

describe('VerifierService.chatStream — verifier event states', () => {
  it('a pipeline that throws is reported as unavailable, never as verified', async () => {
    const { summary, logs } = await streamVerifier(() =>
      Promise.reject(new Error('connect ECONNREFUSED db.example.invalid:5432')),
    );
    assert.ok(summary, 'the verifier event is still emitted');
    assert.equal(summary.status, 'unavailable');
    assert.equal(summary.badge, 'unavailable');
    assert.equal(summary.claimCount, 0);
    assert.equal(summary.reason, 'pipeline_error');
    // The event is forwarded verbatim to stream clients: the error text stays
    // in the operator log.
    assert.doesNotMatch(JSON.stringify(summary), /ECONNREFUSED|db\.example\.invalid/);
    assert.ok(logs.some((l) => l.includes('ECONNREFUSED')), 'failure still logged');
  });

  it('a skipped verdict maps to badge unverified with its reason', async () => {
    const { summary } = await streamVerifier(() => Promise.resolve(skipped()));
    assert.ok(summary);
    assert.equal(summary.status, 'skipped');
    assert.equal(summary.badge, 'unverified');
    assert.equal(summary.reason, 'no_trigger');
  });

  it('approved over zero claims from an injected pipeline is not badged verified', async () => {
    const { summary } = await streamVerifier(() => Promise.resolve(approvedWithoutClaims()));
    assert.ok(summary);
    assert.equal(summary.badge, 'unverified');
  });

  it('control: approved with a checked claim is badged verified, without a reason', async () => {
    const { summary } = await streamVerifier(() => Promise.resolve(approved()));
    assert.ok(summary);
    assert.equal(summary.badge, 'verified');
    assert.equal(summary.claimCount, 1);
    assert.equal(summary.reason, undefined);
  });
});

describe('badgeFor — evidence-bound', () => {
  it('maps every verdict state to its own badge', () => {
    assert.equal(badgeFor(approved(), 0), 'verified');
    assert.equal(badgeFor(borderline(), 0), 'partial');
    assert.equal(badgeFor(blocked(), 0), 'failed');
    assert.equal(badgeFor(skipped(), 0), 'unverified');
    assert.equal(badgeFor(unavailable(), 0), 'unavailable');
  });

  it('never badges a verdict without checked claims as verified or corrected', () => {
    assert.equal(badgeFor(approvedWithoutClaims(), 0), 'unverified');
    assert.equal(badgeFor(approvedWithoutClaims(), 1), 'unverified');
  });
});

describe('mergeBadges — the retry badge needs evidence from the retry', () => {
  it('corrected only when the retry checked claims and found no contradiction', () => {
    assert.equal(mergeBadges(blocked(), approved()), 'corrected');
    assert.equal(mergeBadges(blocked(), borderline()), 'corrected');
    assert.equal(mergeBadges(blocked(), blocked()), 'failed');
  });

  it('a retry that checked nothing is never corrected', () => {
    assert.equal(mergeBadges(blocked(), unavailable()), 'unavailable');
    assert.equal(mergeBadges(blocked(), skipped()), 'unverified');
    assert.equal(mergeBadges(blocked(), approvedWithoutClaims()), 'unverified');
  });
});

describe('VerifierService.chat — no resample or retry without evidence', () => {
  async function chatOnce(
    verdicts: VerifierVerdict[],
  ): Promise<{ runTurns: number; sa: Awaited<ReturnType<VerifierService['chat']>> }> {
    let runTurns = 0;
    let verifyCalls = 0;
    const orchestrator = {
      agentId: 'default',
      markScreeningReentry: (): void => undefined,
      runTurn: (): Promise<ChatTurnResult> => {
        runTurns += 1;
        return Promise.resolve({ answer: ANSWER, toolCalls: 1, iterations: 1 });
      },
    } as unknown as Orchestrator;
    const pipeline = {
      verify: (): Promise<VerifierVerdict> => {
        const next = verdicts[Math.min(verifyCalls, verdicts.length - 1)]!;
        verifyCalls += 1;
        return Promise.resolve(next);
      },
    } as unknown as VerifierPipeline;
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'enforce',
      maxRetries: 1,
      log: () => undefined,
    });
    const sa = await service.chat({ userMessage: 'Wie hoch ist die Rechnung?' });
    return { runTurns, sa };
  }

  it('skipped and unavailable run the turn once and carry no connector badge', async () => {
    for (const first of [skipped(), unavailable()]) {
      const r = await chatOnce([first]);
      assert.equal(r.runTurns, 1, `${first.status} must not buy a resample or a retry`);
      assert.equal(r.sa.verifier, undefined, `${first.status} must not render a badge`);
    }
  });

  it('control: a borderline first verdict does draw a second sample', async () => {
    const r = await chatOnce([borderline()]);
    assert.equal(r.runTurns, 2);
  });

  it('a blocked turn whose retry cannot be verified renders no badge', async () => {
    const r = await chatOnce([blocked(), unavailable()]);
    assert.equal(r.runTurns, 2, 'one retry after the block');
    assert.equal(r.sa.verifier, undefined);
  });

  it('control: a blocked turn whose retry verifies is badged corrected', async () => {
    const r = await chatOnce([blocked(), approved()]);
    assert.deepEqual(r.sa.verifier, { status: 'corrected' });
  });
});
