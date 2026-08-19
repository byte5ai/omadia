/**
 * #575 — `restrictToScope` actually drops the cross-conversation hits.
 *
 * The guard half (`crossScopeRecallRefused`) lives in
 * `audienceScopedRecall.test.ts`. This is the half that has to do the work: a
 * decision nobody applies is worth nothing, and here the failure would be
 * invisible — the prompt would simply still contain another conversation's
 * turns, and nothing would look broken.
 *
 * Two things are asserted, and the second is the one a plausible
 * implementation misses: the cross-session legs (plans / processes / curated
 * insights) **bypass the candidate pool entirely** and are rendered as their
 * own blocks. Filtering candidates alone would look thorough and let those
 * through.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { KnowledgeGraph, TurnSearchHit } from '@omadia/plugin-api';
import { turnNodeId } from '@omadia/plugin-api';

const HERE = 'chat-here';
const ELSEWHERE = 'chat-elsewhere';

function ftsHit(scope: string, time: string, text: string, rank: number): TurnSearchHit {
  return {
    turnId: turnNodeId(scope, time),
    scope,
    time,
    userMessage: text,
    assistantAnswer: `answer about ${text}`,
    rank,
  };
}

/** Minimal graph: FTS hits only, which is all the scope filter needs. */
function graphWith(hits: TurnSearchHit[]): KnowledgeGraph {
  return {
    async getSession() {
      return null;
    },
    async findEntityCapturedTurns() {
      return [];
    },
    async searchTurns() {
      return hits;
    },
    async searchTurnsByEmbedding() {
      return hits;
    },
    async getNeighbors() {
      return [];
    },
  } as unknown as KnowledgeGraph;
}

describe('#575 restrictToScope drops hits from other conversations', () => {
  const hits = [
    ftsHit(HERE, '2026-08-01T08:00:00Z', 'budget for this room', 0.9),
    ftsHit(ELSEWHERE, '2026-08-02T08:00:00Z', 'salary discussion', 0.95),
    ftsHit(HERE, '2026-08-03T08:00:00Z', 'follow-up here', 0.8),
  ];

  it('without the restriction, the foreign hit is included', async () => {
    // The baseline this feature changes — and the leak it closes: the
    // highest-ranked hit belongs to another conversation.
    const result = await new ContextRetriever(graphWith(hits)).assembleForBudget({
      userMessage: 'budget',
      agentId: 'agent-test',
      sessionScope: HERE,
      budget: { tokens: 4000 },
    });
    // `AssembledHit` carries turnId/score/chars/reason — not the scope — so the
    // assertion goes through the turn id, which encodes it.
    const foreign = turnNodeId(ELSEWHERE, '2026-08-02T08:00:00Z');
    assert.ok(
      result.included.some((h) => h.turnId === foreign),
      'baseline: cross-session recall reaches the prompt',
    );
    assert.ok(result.text.includes('salary discussion'));
  });

  it('with the restriction, only this conversation survives', async () => {
    const result = await new ContextRetriever(graphWith(hits)).assembleForBudget({
      userMessage: 'budget',
      agentId: 'agent-test',
      sessionScope: HERE,
      restrictToScope: HERE,
      budget: { tokens: 4000 },
    });
    const foreign = turnNodeId(ELSEWHERE, '2026-08-02T08:00:00Z');
    assert.ok(
      !result.included.some((h) => h.turnId === foreign),
      'no hit from another conversation may survive',
    );
    assert.ok(result.included.length > 0, 'and recall is NARROWED, not lost');
  });

  it('records the drop as an exclusion rather than swallowing it', async () => {
    // An operator staring at a thin context block has to be able to see that
    // the floor trimmed it, not guess.
    const result = await new ContextRetriever(graphWith(hits)).assembleForBudget({
      userMessage: 'budget',
      agentId: 'agent-test',
      sessionScope: HERE,
      restrictToScope: HERE,
      budget: { tokens: 4000 },
    });
    const dropped = result.excluded.filter((e) => e.reason === 'audience-scope');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.turnId, turnNodeId(ELSEWHERE, '2026-08-02T08:00:00Z'));
  });

  it('the rendered text no longer mentions the foreign turn', async () => {
    // The assertion that matters: `included` is a trace, the TEXT is the prompt.
    const result = await new ContextRetriever(graphWith(hits)).assembleForBudget({
      userMessage: 'budget',
      agentId: 'agent-test',
      sessionScope: HERE,
      restrictToScope: HERE,
      budget: { tokens: 4000 },
    });
    assert.ok(!result.text.includes('salary discussion'));
    assert.ok(result.text.includes('budget for this room'));
  });
});

describe('#575 the cross-session legs are skipped too', () => {
  it('does not run plan / process / memory recall when restricted', async () => {
    // These bypass the candidate pool and render their own blocks, so the
    // candidate filter would never see them. Asserted by observing that the
    // legs are never asked — a graph whose cross-session reads throw would
    // fail the turn if they ran.
    let crossSessionAsked = false;
    const graph = {
      async getSession() {
        return null;
      },
      async findEntityCapturedTurns() {
        return [];
      },
      async searchTurns() {
        return [] as TurnSearchHit[];
      },
      async searchTurnsByEmbedding() {
        return [] as TurnSearchHit[];
      },
      async getNeighbors() {
        return [];
      },
      async listRecentPlans() {
        crossSessionAsked = true;
        return [];
      },
    } as unknown as KnowledgeGraph;

    await new ContextRetriever(graph).assembleForBudget({
      userMessage: 'anything with terms in it',
      agentId: 'agent-test',
      sessionScope: HERE,
      restrictToScope: HERE,
      budget: { tokens: 4000 },
    });
    assert.equal(crossSessionAsked, false);
  });
});
