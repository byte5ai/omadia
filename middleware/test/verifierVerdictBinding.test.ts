/**
 * An injected pipeline's verdict is held to what its claims show before the
 * service acts on it, stores it or streams it (`bindVerdictToClaims`):
 *  - a reason outside the closed codes never reaches the stream — the raw
 *    value goes to the operator log only, escaped onto one line;
 *  - `approved` over no claim is no result (`unavailable` / `pipeline_error`),
 *    and `approved` over a claim it did not confirm takes the status its
 *    claims earn — in the stream summary and in `verifier_verdicts` alike;
 *  - a status is never raised above the one the pipeline reported;
 *  - the built-in pipeline's verdicts pass unchanged.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';
import {
  bindVerdictToClaims,
  VerifierStore,
  type ClaimVerdict,
  type VerifierPipeline,
  type VerifierVerdict,
} from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatTurnResult,
  VerifierResultSummary,
} from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import { VerifierService } from '../packages/harness-orchestrator/src/verifierService.js';

const AMOUNT = {
  id: 'c_1',
  text: '1.234,56 €',
  type: 'amount' as const,
  expectedSource: 'odoo' as const,
  relatedEntities: [],
};
const VERIFIED: ClaimVerdict = { status: 'verified', claim: AMOUNT, source: 'odoo' };
const NOT_CHECKED: ClaimVerdict = {
  status: 'unverified',
  claim: { ...AMOUNT, id: 'c_2', expectedSource: 'confluence' },
  reason: 'no checker',
  cause: 'not_checked',
};
const CONTRADICTED: ClaimVerdict = {
  status: 'contradicted',
  claim: { ...AMOUNT, id: 'c_3' },
  truth: 999,
  source: 'odoo',
};

/** Free text a foreign pipeline might put where a closed code belongs. */
const PROVIDER_ERROR = 'upstream said: 401 invalid key for tenant-a\nretry later';

const unusable = (latencyMs: number): VerifierVerdict => ({
  status: 'unavailable',
  reason: 'pipeline_error',
  claims: [],
  latencyMs,
});

describe('bindVerdictToClaims — verdicts the built-in pipeline builds', () => {
  it('pass unchanged, without a problem', () => {
    const builtIn: VerifierVerdict[] = [
      { status: 'approved', claims: [VERIFIED], latencyMs: 4 },
      {
        status: 'approved_with_disclaimer',
        claims: [VERIFIED, NOT_CHECKED],
        unverified: [NOT_CHECKED],
        latencyMs: 4,
      },
      {
        status: 'blocked',
        claims: [VERIFIED, CONTRADICTED],
        contradictions: [CONTRADICTED],
        latencyMs: 4,
      },
      { status: 'skipped', reason: 'no_trigger', claims: [], latencyMs: 1 },
      { status: 'skipped', reason: 'incomplete_coverage', claims: [], latencyMs: 1 },
      { status: 'unavailable', reason: 'extractor_error', claims: [], latencyMs: 2 },
    ];
    for (const verdict of builtIn) {
      const bound = bindVerdictToClaims(verdict);
      assert.deepEqual(bound.verdict, verdict, verdict.status);
      assert.equal(bound.problem, undefined, verdict.status);
    }
  });
});

describe('bindVerdictToClaims — what an injected pipeline cannot put on a turn', () => {
  it('a reason outside the closed codes is pipeline_error; the raw value stays in the problem', () => {
    for (const status of ['skipped', 'unavailable']) {
      const bound = bindVerdictToClaims({ status, reason: PROVIDER_ERROR, claims: [], latencyMs: 3 });
      assert.deepEqual(bound.verdict, unusable(3), status);
      const problem = bound.problem ?? '';
      assert.ok(problem.includes('401 invalid key'), problem);
      assert.ok(!problem.includes('\n'), 'escaped onto one log line');
    }
  });

  it('approved without a claim is no result', () => {
    const bound = bindVerdictToClaims({ status: 'approved', claims: [], latencyMs: 0 });
    assert.deepEqual(bound.verdict, unusable(0));
    assert.equal(bound.problem, 'approved without a claim');
  });

  it('approved over a claim it did not confirm takes the status its claims earn', () => {
    const disclaimer = bindVerdictToClaims({
      status: 'approved',
      claims: [VERIFIED, NOT_CHECKED],
      latencyMs: 5,
    });
    assert.deepEqual(disclaimer.verdict, {
      status: 'approved_with_disclaimer',
      claims: [VERIFIED, NOT_CHECKED],
      unverified: [NOT_CHECKED],
      latencyMs: 5,
    });
    assert.ok(disclaimer.problem?.includes('earn only approved_with_disclaimer'));

    const blocked = bindVerdictToClaims({
      status: 'approved_with_disclaimer',
      claims: [VERIFIED, CONTRADICTED],
      unverified: [],
      latencyMs: 5,
    });
    assert.equal(blocked.verdict.status, 'blocked');
    assert.deepEqual(
      blocked.verdict.status === 'blocked' ? blocked.verdict.contradictions : [],
      [CONTRADICTED],
    );
  });

  it('never raises a status above the one reported', () => {
    // Every claim verified, but the pipeline said "with disclaimer": it may
    // know of a doubt it did not list. Kept, never made green.
    const kept = bindVerdictToClaims({
      status: 'approved_with_disclaimer',
      claims: [VERIFIED],
      unverified: [NOT_CHECKED],
      latencyMs: 1,
    });
    assert.deepEqual(kept.verdict, {
      status: 'approved_with_disclaimer',
      claims: [VERIFIED],
      unverified: [],
      latencyMs: 1,
    });
    assert.equal(kept.problem, undefined);
    const blocked = bindVerdictToClaims({ status: 'blocked', claims: [VERIFIED], latencyMs: 1 });
    assert.equal(blocked.verdict.status, 'blocked');
  });

  it('an unknown status, claims that are not claim verdicts, or no object at all is no result', () => {
    for (const raw of [
      { status: 'ok', claims: [VERIFIED], latencyMs: 1 },
      { status: 'approved', claims: 'all good', latencyMs: 1 },
      { status: 'approved', claims: [{ status: 'verified' }], latencyMs: 1 },
      { status: 'approved', claims: [{ status: 'confirmed', claim: AMOUNT }], latencyMs: 1 },
      { status: 'skipped', reason: 'no_trigger', claims: [VERIFIED], latencyMs: 1 },
      { status: 'unavailable', reason: 'extractor_error', claims: [VERIFIED], latencyMs: 1 },
    ]) {
      const bound = bindVerdictToClaims(raw);
      assert.deepEqual(bound.verdict, unusable(1), JSON.stringify(raw));
      assert.ok(bound.problem, JSON.stringify(raw));
    }
    for (const raw of [null, undefined, 'approved', 42]) {
      assert.deepEqual(bindVerdictToClaims(raw).verdict, unusable(0));
    }
  });

  it('a latency that is not a duration is 0', () => {
    for (const latencyMs of [PROVIDER_ERROR, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bound = bindVerdictToClaims({ status: 'approved', claims: [VERIFIED], latencyMs });
      assert.equal(bound.verdict.latencyMs, 0);
    }
  });
});

const ANSWER = 'Die Rechnung beträgt 1.234,56 €.';

/** Column order of the `verifier_verdicts` INSERT in verifierStore.ts. */
const STATUS = 3;
const CLAIM_COUNT = 4;
const UNVERIFIED_COUNT = 8;
const LATENCY_MS = 10;

/** One streamed turn through the service and the real `VerifierStore` over a
 *  recording pool: the stream summary, the stored row and the log. */
async function streamAndStore(
  returned: unknown,
): Promise<{ summary: VerifierResultSummary | undefined; row: unknown[]; logs: string[] }> {
  const logs: string[] = [];
  const rows: unknown[][] = [];
  const pool = {
    query: (sql: string, params: unknown[]): Promise<{ rows: unknown[] }> => {
      if (sql.includes('INSERT INTO verifier_verdicts')) rows.push(params);
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
  const orchestrator = {
    agentId: 'default',
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      await Promise.resolve();
      yield { type: 'done', answer: ANSWER, toolCalls: 1, iterations: 1 };
    },
  } as unknown as Orchestrator;
  const service = new VerifierService({
    orchestrator,
    pipeline: { verify: () => Promise.resolve(returned) } as unknown as VerifierPipeline,
    store: new VerifierStore({ pool, tenant: 'tenant-a', log: () => undefined }),
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows.length, 1, 'one verdict row');
  return { summary, row: rows[0]!, logs };
}

describe('VerifierService — the bound verdict is what is streamed and stored', () => {
  it('free text in reason or latency never reaches the stream or the store', async () => {
    const { summary, row, logs } = await streamAndStore({
      status: 'unavailable',
      reason: PROVIDER_ERROR,
      claims: [],
      latencyMs: PROVIDER_ERROR,
    });
    assert.ok(summary);
    assert.equal(summary.status, 'unavailable');
    assert.equal(summary.reason, 'pipeline_error');
    assert.equal(summary.latencyMs, 0);
    assert.doesNotMatch(JSON.stringify(summary), /401|invalid key|tenant-a/);
    assert.equal(row[STATUS], 'unavailable');
    assert.equal(row[LATENCY_MS], 0);
    assert.ok(
      logs.some((l) => l.includes('verdict not taken as returned') && l.includes('401 invalid key')),
      'the raw value is logged server-side',
    );
  });

  it('approved over no claim is streamed and stored as unavailable, not as a clean turn', async () => {
    const { summary, row } = await streamAndStore({ status: 'approved', claims: [], latencyMs: 0 });
    assert.ok(summary);
    assert.equal(summary.status, 'unavailable');
    assert.equal(summary.badge, 'unavailable');
    assert.equal(row[STATUS], 'unavailable');
  });

  it('approved over an unchecked claim is streamed and stored with the status its claims earn', async () => {
    const { summary, row } = await streamAndStore({
      status: 'approved',
      claims: [VERIFIED, NOT_CHECKED],
      latencyMs: 7,
    });
    assert.ok(summary);
    assert.equal(summary.status, 'approved_with_disclaimer');
    assert.equal(summary.badge, 'partial');
    assert.equal(summary.unverifiedCount, 1);
    assert.equal(row[STATUS], 'approved_with_disclaimer');
    assert.equal(row[CLAIM_COUNT], 2);
    assert.equal(row[UNVERIFIED_COUNT], 1, 'the unchecked claim is counted');
  });
});

describe('VerifierService.chat — decisions follow the bound verdict', () => {
  it('an injected approved over a contradicted claim is blocked, and retried in enforce mode', async () => {
    let runTurns = 0;
    let verifyCalls = 0;
    const verdicts: unknown[] = [
      { status: 'approved', claims: [CONTRADICTED], latencyMs: 1 },
      { status: 'approved', claims: [VERIFIED], latencyMs: 1 },
    ];
    const orchestrator = {
      agentId: 'default',
      markScreeningReentry: (): void => undefined,
      runTurn: (): Promise<ChatTurnResult> => {
        runTurns += 1;
        return Promise.resolve({ answer: ANSWER, toolCalls: 1, iterations: 1 });
      },
    } as unknown as Orchestrator;
    const service = new VerifierService({
      orchestrator,
      pipeline: {
        verify: () => Promise.resolve(verdicts[Math.min(verifyCalls++, verdicts.length - 1)]),
      } as unknown as VerifierPipeline,
      enabled: true,
      mode: 'enforce',
      maxRetries: 1,
      log: () => undefined,
    });
    const sa = await service.chat({ userMessage: 'Wie hoch ist die Rechnung?' });
    assert.equal(runTurns, 2, 'the contradiction drives the correction retry');
    assert.deepEqual(sa.verifier, { status: 'corrected' });
  });
});
