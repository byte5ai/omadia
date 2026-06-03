/**
 * Per-orchestrator Knowledge-Graph isolation (in-memory backend).
 *
 * Cross-agent leak regression: two Agents share one single-tenant graph;
 * recall must NOT surface another Agent's turns. Scope is agent-qualified
 * (`<agentSlug>::<conversation>`); reads constrain to the asking Agent's
 * prefix. Legacy unqualified rows fall through to the `default::` Agent
 * (zero-migration dual-clause).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { qualifyScope, type EntityRef } from '@omadia/plugin-api';

const widget = (): EntityRef => ({
  system: 'odoo',
  model: 'res.partner',
  id: 1,
  displayName: 'widgetco',
  op: 'read',
});

async function seed(): Promise<InMemoryKnowledgeGraph> {
  const g = new InMemoryKnowledgeGraph();
  await g.ingestTurn({
    scope: qualifyScope('agent-a', 'c1'),
    time: '2026-04-18T10:00:00Z',
    userMessage: 'budget alpha for widgetco',
    assistantAnswer: 'A',
    entityRefs: [widget()],
  });
  await g.ingestTurn({
    scope: qualifyScope('agent-b', 'c2'),
    time: '2026-04-18T11:00:00Z',
    userMessage: 'budget beta for widgetco',
    assistantAnswer: 'B',
    entityRefs: [widget()],
  });
  // Legacy unqualified turn (pre-isolation).
  await g.ingestTurn({
    scope: 'oldconv',
    time: '2026-04-18T09:00:00Z',
    userMessage: 'budget legacy for widgetco',
    assistantAnswer: 'L',
    entityRefs: [widget()],
  });
  return g;
}

test('searchTurns: agent prefix returns only the asking Agent\'s turns', async () => {
  const g = await seed();
  const a = await g.searchTurns({ query: 'budget', agentScopePrefix: 'agent-a::' });
  assert.deepEqual(
    a.map((h) => h.userMessage),
    ['budget alpha for widgetco'],
  );
  const b = await g.searchTurns({ query: 'budget', agentScopePrefix: 'agent-b::' });
  assert.deepEqual(
    b.map((h) => h.userMessage),
    ['budget beta for widgetco'],
  );
});

test('searchTurns: default:: prefix matches legacy unqualified rows (dual-clause)', async () => {
  const g = await seed();
  const hits = await g.searchTurns({
    query: 'budget',
    agentScopePrefix: 'default::',
  });
  // Only the legacy row (no '::'); NOT agent-a / agent-b qualified rows.
  assert.deepEqual(
    hits.map((h) => h.userMessage),
    ['budget legacy for widgetco'],
  );
});

test('searchTurns: no prefix preserves legacy cross-agent recall', async () => {
  const g = await seed();
  const hits = await g.searchTurns({ query: 'budget' });
  assert.equal(hits.length, 3);
});

test('listRecentPlans: agent prefix returns only the asking Agent\'s plans', async () => {
  const g = new InMemoryKnowledgeGraph();
  await g.ingestPlan({
    planId: 'p-a',
    scope: qualifyScope('agent-a', 'c1'),
    strategy: 'alpha plan',
    createdAt: '2026-04-18T10:00:00Z',
  });
  await g.ingestPlan({
    planId: 'p-b',
    scope: qualifyScope('agent-b', 'c2'),
    strategy: 'beta plan',
    createdAt: '2026-04-18T11:00:00Z',
  });

  const a = await g.listRecentPlans({ agentScopePrefix: 'agent-a::' });
  assert.deepEqual(
    a.map((p) => p.props['strategy']),
    ['alpha plan'],
  );
  const b = await g.listRecentPlans({ agentScopePrefix: 'agent-b::' });
  assert.deepEqual(
    b.map((p) => p.props['strategy']),
    ['beta plan'],
  );
  // No prefix → legacy cross-agent (both visible).
  assert.equal((await g.listRecentPlans({})).length, 2);
});

test('findEntityCapturedTurns: entity is global, recall is agent-isolated', async () => {
  const g = await seed();
  const a = await g.findEntityCapturedTurns({
    terms: ['widgetco'],
    agentScopePrefix: 'agent-a::',
  });
  const turns = a.flatMap((h) => h.turns.map((t) => t.userMessage));
  assert.deepEqual(turns, ['budget alpha for widgetco']);
  // Agent A cannot reach Agent B's turn via the shared entity. (Leak #1.)
  assert.ok(!turns.some((m) => m.includes('beta')));
});
