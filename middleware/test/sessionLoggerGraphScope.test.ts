/**
 * Per-orchestrator KG isolation at the write side (`SessionLogger`).
 *
 * An agent-bound logger ingests Turns under the agent-qualified graph scope
 * `<agentSlug>::<conversation>` (so recall can constrain to the Agent), while
 * the markdown transcript path stays on the raw conversation id (shared
 * human/recovery artifact). `graphScopeFor` is the shared write/read formula.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
// Import from source: `graphScopeFor` was added after the last dist build,
// so the built `@omadia/orchestrator` barrel doesn't re-export it yet.
import {
  SessionLogger,
  graphScopeFor,
} from '../packages/harness-orchestrator/src/sessionLogger.js';

test('graphScopeFor qualifies with the agent slug; sanitizes the base; undefined = legacy', () => {
  assert.equal(graphScopeFor('agent-a', 'conv'), 'agent-a::conv');
  // Base is sanitized (lowercased, punctuation → '-').
  assert.equal(graphScopeFor('agent-a', 'Conv X'), 'agent-a::conv-x');
  // No slug → unqualified (single-agent / legacy), byte-identical to before.
  assert.equal(graphScopeFor(undefined, 'conv'), 'conv');
});

/**
 * #575 D3 — the injective graph key is behind `OMADIA_INJECTIVE_SCOPE_KEYS`.
 *
 * `scopeGraphKey` has its own unit tests (`scopeId.test.ts`), but those prove
 * only that the FUNCTION is injective. They say nothing about whether
 * `graphScopeFor` — the single formula both the write and the read side use —
 * actually consults the flag. A gate that is declared but never read passes
 * every test while the fix it guards is unreachable, so the wiring needs its
 * own assertion.
 */
test('OMADIA_INJECTIVE_SCOPE_KEYS switches graphScopeFor onto the injective key', () => {
  const previous = process.env['OMADIA_INJECTIVE_SCOPE_KEYS'];
  // `teams::c1` and `teams-c1` are distinct scopes that `sanitizeScope` folds
  // onto one partition — the isolation hazard D3 exists for.
  const collidingA = 'teams::c1';
  const collidingB = 'teams-c1';
  try {
    delete process.env['OMADIA_INJECTIVE_SCOPE_KEYS'];
    assert.equal(graphScopeFor(undefined, collidingA), graphScopeFor(undefined, collidingB));

    process.env['OMADIA_INJECTIVE_SCOPE_KEYS'] = '1';
    assert.notEqual(graphScopeFor(undefined, collidingA), graphScopeFor(undefined, collidingB));
    // Already-lossless scopes keep a byte-identical key, so opting in does not
    // orphan the partitions that were never at risk.
    assert.equal(graphScopeFor(undefined, 'http-default'), 'http-default');
    assert.equal(graphScopeFor('agent-a', 'conv'), 'agent-a::conv');

    // Only the exact opt-in value counts — anything else stays on the old key.
    process.env['OMADIA_INJECTIVE_SCOPE_KEYS'] = 'true';
    assert.equal(graphScopeFor(undefined, collidingA), graphScopeFor(undefined, collidingB));
  } finally {
    if (previous === undefined) delete process.env['OMADIA_INJECTIVE_SCOPE_KEYS'];
    else process.env['OMADIA_INJECTIVE_SCOPE_KEYS'] = previous;
  }
});

test('an agent-bound SessionLogger ingests Turns under the qualified scope', async () => {
  const store = new InMemoryMemoryStore();
  const graph = new InMemoryKnowledgeGraph();
  const logger = new SessionLogger(store, graph, undefined, 'agent-a');

  const { turnExternalId } = await logger.log({
    scope: 'conv1',
    userMessage: 'hi',
    assistantAnswer: 'yo',
    entityRefs: [],
  });

  // Graph: Turn lives under the qualified scope; the returned id agrees.
  assert.ok(await graph.getSession('agent-a::conv1'));
  assert.equal(await graph.getSession('conv1'), null);
  assert.ok(turnExternalId.startsWith('turn:agent-a::conv1:'));

  // Markdown transcript stays on the raw (sanitized) conversation id.
  const files = await store.list('/memories/sessions/conv1');
  assert.ok(files.some((e) => !e.isDirectory));
});

test('a different Agent logging the same conversation id does not collide in the graph', async () => {
  const store = new InMemoryMemoryStore();
  const graph = new InMemoryKnowledgeGraph();

  await new SessionLogger(store, graph, undefined, 'agent-a').log({
    scope: 'shared', userMessage: 'a', assistantAnswer: 'A', entityRefs: [],
  });
  await new SessionLogger(store, graph, undefined, 'agent-b').log({
    scope: 'shared', userMessage: 'b', assistantAnswer: 'B', entityRefs: [],
  });

  const a = await graph.getSession('agent-a::shared');
  const b = await graph.getSession('agent-b::shared');
  assert.equal(a?.turns.length, 1);
  assert.equal(b?.turns.length, 1);
  assert.equal(a?.turns[0]?.turn.props['userMessage'], 'a');
  assert.equal(b?.turns[0]?.turn.props['userMessage'], 'b');
});
