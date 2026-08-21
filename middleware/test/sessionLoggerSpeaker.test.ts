import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { SessionLogger } from '@omadia/orchestrator';

/**
 * #584 WS I — the two additive `SessionLogEntry` fields:
 *   - `speaker` renders as the markdown speaker label and lands as a
 *     queryable graph-turn property; absent → byte-identical `**User:**`.
 *   - `time` overrides the turn timestamp so batch transcript ingestion can
 *     write many same-tick entries without colliding on the ms-keyed
 *     `turnNodeId` (which silently merges same-ms turns).
 */
describe('SessionLogger speaker + time (transcript ingest)', () => {
  it('renders the speaker label and passes it to the graph turn', async () => {
    const store = new InMemoryMemoryStore();
    const graph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, graph);

    await logger.log({
      scope: 'speaker-test',
      userMessage: 'Guten Morgen zusammen.',
      assistantAnswer: '_(Transkript-Ingest)_',
      speaker: 'Anna',
      entityRefs: [],
    });

    const files = (await store.list('/memories/sessions/speaker-test')).filter(
      (e) => !e.isDirectory,
    );
    const md = await store.readFile(files[0]!.virtualPath);
    assert.match(md, /\*\*Anna:\*\*/);
    assert.ok(!md.includes('**User:**'));

    const view = await graph.getSession('speaker-test');
    assert.equal(
      (view?.turns[0]?.turn.props as { speaker?: string }).speaker,
      'Anna',
    );
  });

  it('without a speaker the rendering stays byte-identical (**User:**), no speaker prop', async () => {
    const store = new InMemoryMemoryStore();
    const graph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, graph);
    await logger.log({
      scope: 'plain-test',
      userMessage: 'q',
      assistantAnswer: 'a',
      entityRefs: [],
    });
    const files = (await store.list('/memories/sessions/plain-test')).filter(
      (e) => !e.isDirectory,
    );
    const md = await store.readFile(files[0]!.virtualPath);
    assert.match(md, /\*\*User:\*\*/);
    const view = await graph.getSession('plain-test');
    assert.ok(!('speaker' in (view?.turns[0]?.turn.props ?? {})));
  });

  it('time override keeps same-tick entries as DISTINCT graph turns', async () => {
    const store = new InMemoryMemoryStore();
    const graph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, graph);
    const base = Date.parse('2026-08-21T10:00:00.000Z');
    for (const [i, text] of ['eins', 'zwei', 'drei'].entries()) {
      await logger.log({
        scope: 'time-test',
        time: new Date(base + i).toISOString(),
        userMessage: text,
        assistantAnswer: '_(Transkript-Ingest)_',
        entityRefs: [],
      });
    }
    const view = await graph.getSession('time-test');
    assert.equal(view?.turns.length, 3);
  });
});
