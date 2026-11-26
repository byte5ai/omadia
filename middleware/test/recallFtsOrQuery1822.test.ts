/**
 * #1822 — full-text recall searches for the content terms of a message, OR-ed,
 * instead of requiring every word. A question that shares the content words of
 * a stored fact finds it; a message without content words ("ok") recalls
 * nothing. The Neon twin runs in `recallFtsOrQuery1822.pg.test.ts`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  RECALL_QUERY_MAX_TERMS,
  buildRecallTsQuery,
  extractRecallSearchTerms,
} from '@omadia/plugin-api';

const FACT =
  'Zur Info für später: Der Testserver Reiher-p11 bekommt seine Sicherheits-Patches immer montags ab 6 Uhr morgens.';

describe('extractRecallSearchTerms / buildRecallTsQuery (#1822)', () => {
  it('drops function words and splits compounds like the simple parser', () => {
    assert.deepEqual(
      extractRecallSearchTerms('Wann bekommt der Reiher-p11 seine Sicherheits-Patches?'),
      ['bekommt', 'reiher', 'p11', 'sicherheits', 'patches'],
    );
  });

  it('builds an OR query of plain letter/digit terms', () => {
    assert.equal(
      buildRecallTsQuery('Sicherheits-Patches Testserver Reiher-p11'),
      'sicherheits | patches | testserver | reiher | p11',
    );
  });

  it('returns null without a content term', () => {
    for (const message of ['ok', 'Okay, danke!', 'ja', '   ', '?!', 'Was ist das?']) {
      assert.equal(buildRecallTsQuery(message), null, message);
    }
  });

  it('keeps two-letter acronyms but not lowercase two-letter filler', () => {
    assert.deepEqual(extractRecallSearchTerms('Was wissen wir über IT?'), ['wissen', 'it']);
    assert.deepEqual(extractRecallSearchTerms('Wer ist in HR für die EU zuständig?'), ['hr', 'eu', 'zuständig']);
    assert.equal(buildRecallTsQuery('OK, so it is'), null);
  });

  it('cannot carry tsquery syntax from the message', () => {
    const query = buildRecallTsQuery("Kunde & 'Müller' | !Zebra <-> (Projekt):*");
    assert.equal(query, 'kunde | müller | zebra | projekt');
  });

  it('keeps short tokens only with a digit or as a capitalised acronym, and caps the term count', () => {
    assert.deepEqual(extractRecallSearchTerms('Raum B2 im 3. Stock, KW 47'), ['raum', 'b2', 'stock', 'kw', '47']);
    const many = Array.from({ length: 40 }, (_, i) => `begriff${i}`).join(' ');
    assert.equal(extractRecallSearchTerms(many).length, RECALL_QUERY_MAX_TERMS);
  });
});

describe('InMemoryKnowledgeGraph.searchTurns · OR over content terms (#1822)', () => {
  async function seed(): Promise<InMemoryKnowledgeGraph> {
    const graph = new InMemoryKnowledgeGraph();
    await graph.ingestTurn({
      scope: 'chat-a',
      time: '2026-11-20T09:00:00.000Z',
      userMessage: FACT,
      assistantAnswer: 'Alles klar, ich merke es mir.',
      entityRefs: [],
    });
    await graph.ingestTurn({
      scope: 'chat-b',
      time: '2026-11-20T10:00:00.000Z',
      userMessage: 'Wie ist das Wetter?',
      assistantAnswer: 'ok, sonnig.',
      entityRefs: [],
    });
    return graph;
  }

  it('finds the stored fact for a question with extra words', async () => {
    const graph = await seed();
    const hits = await graph.searchTurns({
      query: 'Wann bekommt der Reiher-p11 seine Sicherheits-Patches?',
      limit: 5,
    });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.userMessage, /Reiher-p11/);
  });

  it('recalls nothing for a message without content words', async () => {
    const graph = await seed();
    assert.deepEqual(await graph.searchTurns({ query: 'ok', limit: 5 }), []);
  });

  it('matches whole tokens, not substrings', async () => {
    const graph = await seed();
    // "patch" is a substring of "Sicherheits-Patches" but not one of its tokens.
    assert.deepEqual(await graph.searchTurns({ query: 'patch', limit: 5 }), []);
  });
});
