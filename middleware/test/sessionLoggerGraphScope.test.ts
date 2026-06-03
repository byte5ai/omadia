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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMemoryStore } from '@omadia/memory';
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

test('an agent-bound SessionLogger ingests Turns under the qualified scope', async () => {
  const store = new FilesystemMemoryStore(
    mkdtempSync(join(tmpdir(), 'sl-scope-')),
  );
  await store.init();
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
  const store = new FilesystemMemoryStore(
    mkdtempSync(join(tmpdir(), 'sl-scope-')),
  );
  await store.init();
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
