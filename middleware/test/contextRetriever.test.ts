import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextRetriever,
  extractCandidateTerms,
} from '@omadia/orchestrator-extras';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

describe('extractCandidateTerms', () => {
  it('keeps uppercase tokens, digit-bearing ids, and long lowercase tokens', () => {
    const terms = extractCandidateTerms(
      'Zeig mir offene Rechnungen von BÄR GmbH Invoice 12345',
    );
    assert.deepEqual(terms, [
      'offene',
      'Rechnungen',
      'BÄR',
      'GmbH',
      'Invoice',
      '12345',
    ]);
  });

  it('drops stopwords and short tokens', () => {
    const terms = extractCandidateTerms('was ist mit dem');
    assert.deepEqual(terms, []);
  });

  it('dedupes case-insensitively and caps at 10 terms', () => {
    const terms = extractCandidateTerms(
      'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron',
    );
    assert.equal(terms.length, 10);
    assert.equal(terms[0], 'Alpha');
  });
});

describe('ContextRetriever', () => {
  async function seed(graph: InMemoryKnowledgeGraph): Promise<void> {
    await graph.ingestTurn({
      scope: 'chat-1',
      time: '2026-04-18T10:00:00Z',
      userMessage: 'Offene Rechnungen von BÄR GmbH?',
      assistantAnswer: 'BÄR GmbH hat 3 offene Rechnungen.',
      entityRefs: [
        {
          system: 'odoo',
          model: 'res.partner',
          id: 42,
          displayName: 'BÄR GmbH',
        },
      ],
      userId: 'user-1',
    });
    await graph.ingestTurn({
      scope: 'chat-1',
      time: '2026-04-18T10:05:00Z',
      userMessage: 'Welche Beträge?',
      assistantAnswer: 'Gesamt 12.340 EUR.',
      entityRefs: [],
      userId: 'user-1',
    });
    await graph.ingestTurn({
      scope: 'chat-2',
      time: '2026-04-19T08:00:00Z',
      userMessage: 'Was ist der Umsatz 2026?',
      assistantAnswer: 'Umsatz bisher 1.2 Mio EUR.',
      entityRefs: [],
      userId: 'user-1',
    });
  }

  it('verbatim tail returns last N turns of the active chat', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await seed(graph);
    const retr = new ContextRetriever(graph, { tailSize: 2 });
    const { sources } = await retr.build({
      userMessage: 'Und jetzt?',
      sessionScope: 'chat-1',
      userId: 'user-1',
    });
    assert.equal(sources.verbatimTurns.length, 2);
    assert.equal(sources.verbatimTurns[0]?.time, '2026-04-18T10:00:00Z');
  });

  it('entity-anchoring finds cross-chat turns by displayName', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await seed(graph);
    const retr = new ContextRetriever(graph);
    const { sources } = await retr.build({
      userMessage: 'Habe ich BÄR GmbH noch offen?',
      sessionScope: 'chat-2', // active chat is chat-2, entity lives in chat-1
      userId: 'user-1',
    });
    assert.equal(sources.entityHits.length, 1);
    assert.equal(sources.entityHits[0]?.entity.props['displayName'], 'BÄR GmbH');
    assert.equal(sources.entityHits[0]?.turns[0]?.scope, 'chat-1');
  });

  it('fts hits exclude the active scope', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await seed(graph);
    const retr = new ContextRetriever(graph);
    const { sources } = await retr.build({
      userMessage: 'offene Rechnungen',
      sessionScope: 'chat-2',
      userId: 'user-1',
    });
    assert.ok(sources.ftsHits.length >= 1);
    for (const h of sources.ftsHits) {
      assert.notEqual(h.scope, 'chat-2');
    }
  });

  it('renders a non-empty context text when signals exist', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await seed(graph);
    const retr = new ContextRetriever(graph);
    const { text } = await retr.build({
      userMessage: 'BÄR GmbH Rechnungen',
      sessionScope: 'chat-2',
      userId: 'user-1',
    });
    assert.ok(text.includes('BÄR GmbH'));
    assert.ok(text.includes('Frühere') || text.includes('ähnliche') || text.includes('Früher'));
  });

  it('returns empty text when no context exists', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const retr = new ContextRetriever(graph);
    const { text, sources } = await retr.build({
      userMessage: 'Hallo',
      userId: 'user-1',
    });
    assert.equal(text, '');
    assert.equal(sources.verbatimTurns.length, 0);
    assert.equal(sources.entityHits.length, 0);
    assert.equal(sources.ftsHits.length, 0);
  });

  it('respects user scoping — other users do not leak', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await seed(graph);
    await graph.ingestTurn({
      scope: 'chat-3',
      time: '2026-04-19T09:00:00Z',
      userMessage: 'BÄR GmbH',
      assistantAnswer: 'Fremd-Chat',
      entityRefs: [
        {
          system: 'odoo',
          model: 'res.partner',
          id: 42,
          displayName: 'BÄR GmbH',
        },
      ],
      userId: 'user-OTHER',
    });
    const retr = new ContextRetriever(graph);
    const { sources } = await retr.build({
      userMessage: 'BÄR GmbH',
      sessionScope: 'chat-2',
      userId: 'user-1',
    });
    const scopes = new Set(
      sources.entityHits.flatMap((h) => h.turns.map((t) => t.scope)),
    );
    assert.ok(!scopes.has('chat-3'), `leaked scopes: ${[...scopes].join(',')}`);
  });
});
