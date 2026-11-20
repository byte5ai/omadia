/**
 * Spec 2042 §5.4 — the `consult` tool reserves its per-turn slot before the
 * first await. A model step may call `consult` several times at once, and the
 * orchestrator runs those calls in parallel: each must see the others' slots
 * and get its own contribution id.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createConsultTool,
  createConsultationTurnState,
  type ConsultOutcome,
  type ConsultRequest,
  type ConsultationPort,
} from '../../packages/harness-orchestrator/src/consultation/consultTool.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

const MAX_PER_TURN = 2;

function port(seen: ConsultRequest[]): ConsultationPort {
  return {
    targetsFor: () => [{ slug: 'ben', displayName: 'Ben' }],
    async consult(request): Promise<ConsultOutcome> {
      seen.push(request);
      // Let the other calls start before this one answers.
      await new Promise((resolve) => setImmediate(resolve));
      if (request.callsThisTurn >= MAX_PER_TURN) {
        return { kind: 'refused', reason: 'turn_budget', message: 'limit reached' };
      }
      return {
        kind: 'answered',
        contribution: {
          id: `c${String(request.sequence)}`,
          speaker: { kind: 'agent', agentId: 'b', slug: 'ben', displayName: 'Ben' },
          text: 'ok',
          status: 'delivered',
        },
        labels: { labels: [] },
      };
    },
  };
}

describe('consult tool: per-turn budget under parallel calls', () => {
  it('parallel calls each reserve a slot; the budget holds and ids are distinct', async () => {
    const seen: ConsultRequest[] = [];
    const tool = createConsultTool(port(seen), 'anna');
    const state = createConsultationTurnState({});
    const results = await turnContext.run(
      {
        turnId: 'turn-1',
        turnDate: '2026-11-20',
        consultation: state,
        audienceFloor: (async () => ({ capabilities: new Set<string>() })) as never,
      },
      () => Promise.all([1, 2, 3, 4].map(() => tool.handle({ agent: 'ben', request: 'Q?' }))),
    );
    assert.deepEqual(
      seen.map((r) => r.callsThisTurn),
      [0, 1, 2, 3],
    );
    assert.equal(results.filter((r) => r.startsWith('Error: consultation refused')).length, 2);
    assert.deepEqual(
      state.contributions.map((c) => c.id),
      ['c1', 'c2'],
    );
    assert.equal(new Set(seen.map((r) => r.sequence)).size, 4);
    // Refused calls give their slot back.
    assert.equal(state.calls, 2);
  });
});
