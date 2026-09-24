/**
 * #132 — Confidence-Gated Re-Sampling.
 *
 * Covers:
 *   - `isBorderlineVerdict` for each VerifierVerdict status.
 *   - `mergeBorderlineVerdicts` for every relevant first/second pair.
 *
 * Note: a full end-to-end test of `VerifierService.chat` would need a
 * mock Orchestrator + VerifierPipeline plus a real Anthropic client
 * stand-in (300+ LoC of fixtures). The borderline/merge helpers carry
 * all the new decision logic; the wiring between them and the existing
 * retry path is enforced by the TypeScript compiler (private method
 * signature + `effectiveResult/Verdict` substitution).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  isBorderlineVerdict,
  type VerifierPipeline,
  type VerifierVerdict,
} from '@omadia/verifier';

import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  mergeBorderlineVerdicts,
  VerifierService,
} from '../packages/harness-orchestrator/src/verifierService.js';

function approved(): VerifierVerdict {
  return { status: 'approved', claims: [], latencyMs: 0 };
}

function borderline(): VerifierVerdict {
  return {
    status: 'approved_with_disclaimer',
    claims: [],
    unverified: [],
    latencyMs: 0,
  };
}

function blocked(): VerifierVerdict {
  return {
    status: 'blocked',
    claims: [],
    contradictions: [],
    latencyMs: 0,
  };
}

describe('isBorderlineVerdict', () => {
  it('returns true only for approved_with_disclaimer', () => {
    assert.equal(isBorderlineVerdict(approved()), false);
    assert.equal(isBorderlineVerdict(borderline()), true);
    assert.equal(isBorderlineVerdict(blocked()), false);
  });
});

describe('mergeBorderlineVerdicts', () => {
  it('keeps first when second also lands on borderline (agreement)', () => {
    const merged = mergeBorderlineVerdicts(borderline(), borderline());
    assert.equal(merged.verdict.status, 'approved_with_disclaimer');
    assert.equal(merged.takeSecond, false);
  });

  it('keeps first when second relaxes to approved (no upgrade)', () => {
    const merged = mergeBorderlineVerdicts(borderline(), approved());
    assert.equal(merged.verdict.status, 'approved_with_disclaimer');
    assert.equal(merged.takeSecond, false);
  });

  it('takes second when it escalates to blocked (conservative)', () => {
    const merged = mergeBorderlineVerdicts(borderline(), blocked());
    assert.equal(merged.verdict.status, 'blocked');
    assert.equal(merged.takeSecond, true);
  });
});

describe('VerifierService.chatStream — #1094 degraded turn', () => {
  /** Streams one scripted `done` and records whether the pipeline ran. */
  async function streamOnce(done: ChatStreamEvent): Promise<{
    events: ChatStreamEvent[];
    verifyCalls: number;
  }> {
    let verifyCalls = 0;
    const orchestrator = {
      agentId: 'default',
      async *chatStream(): AsyncGenerator<ChatStreamEvent> {
        await Promise.resolve();
        yield done;
      },
    } as unknown as Orchestrator;
    const pipeline = {
      verify: async (): Promise<VerifierVerdict> => {
        verifyCalls += 1;
        return approved();
      },
    } as unknown as VerifierPipeline;
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'shadow',
      log: () => undefined,
    });
    const events: ChatStreamEvent[] = [];
    for await (const ev of service.chatStream({ userMessage: 'create a widget' })) {
      events.push(ev);
    }
    return { events, verifyCalls };
  }

  it('skips verification for a degraded `done` — no verdict badge on a turn that threw', async () => {
    const degraded = await streamOnce({
      type: 'done',
      answer: 'Dieser Turn wurde nicht abgeschlossen.',
      toolCalls: 1,
      iterations: 2,
      degraded: true,
      committedTools: ['manage_widget'],
      correlationId: 'c-1094',
    });
    assert.equal(degraded.verifyCalls, 0, 'the verifier ran over a degraded turn');
    assert.equal(
      degraded.events.some((e) => e.type === 'verifier'),
      false,
      'a degraded turn got a verifier badge',
    );

    // Control: an ordinary answer is still verified, so the skip above is the
    // degraded flag's doing and not a harness that never verifies.
    const ordinary = await streamOnce({
      type: 'done',
      answer: 'Das Widget ist angelegt.',
      toolCalls: 1,
      iterations: 2,
    });
    assert.equal(ordinary.verifyCalls, 1);
    assert.equal(
      ordinary.events.some((e) => e.type === 'verifier'),
      true,
    );
  });
});
