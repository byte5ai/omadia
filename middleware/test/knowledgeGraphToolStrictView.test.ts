import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { KnowledgeGraphTool } from '@omadia/orchestrator';

/**
 * `query_knowledge_graph` under `enforce-strict` context memory: every query
 * answers from the turn's own conversation and from nothing else.
 *
 * Without a view the tool searched the whole tenant graph, so a Telegram turn
 * found what the same agent had heard in Teams. `strictContextIsolation.test.ts`
 * proves the wiring end to end; this file covers each of the six queries,
 * including the two that never take a scope argument (`stats`,
 * `list_sessions`) and the one that names any scope the model likes
 * (`session_summary`).
 */

const OWN = 'agent-x::telegram::-1001';
const OTHER = 'agent-x::msteams::conv-kranich';
/** A scope that shares OWN as a string prefix — the search pre-filter is a LIKE. */
const OWN_PREFIXED = `${OWN}0`;

async function seed(): Promise<InMemoryKnowledgeGraph> {
  const g = new InMemoryKnowledgeGraph();
  const turn = (scope: string, time: string, userMessage: string, displayName: string) =>
    g.ingestTurn({
      scope,
      time,
      userMessage,
      assistantAnswer: 'ok',
      entityRefs: [{ system: 'odoo', model: 'project.project', id: displayName, displayName, op: 'read' }],
    });
  await turn(OTHER, '2026-10-05T09:00:00.000Z', 'Kranich Budget 4,2 Mio', 'Projekt Kranich');
  await turn(OWN, '2026-10-05T10:00:00.000Z', 'Kranich Termin Freitag', 'Projekt Möwe');
  await turn(OWN_PREFIXED, '2026-10-05T11:00:00.000Z', 'Kranich Budget Nachbar', 'Projekt Nachbar');
  return g;
}

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

describe('KnowledgeGraphTool — enforce-strict view', () => {
  let tool: KnowledgeGraphTool;
  before(async () => {
    tool = new KnowledgeGraphTool(await seed());
  });
  const own = { restrictToScope: OWN };

  it('search_turns finds only the own conversation, exact scope not prefix', async () => {
    const out = parse(await tool.handle({ query: 'search_turns', text: 'Kranich' }, own));
    const scopes = (out['hits'] as Array<{ scope: string }>).map((h) => h.scope);
    assert.deepEqual(scopes, [OWN]);
  });

  it('CONTROL: without a view the same search reaches the other conversation', async () => {
    const out = parse(await tool.handle({ query: 'search_turns', text: 'Kranich' }));
    const scopes = (out['hits'] as Array<{ scope: string }>).map((h) => h.scope);
    assert.ok(scopes.includes(OTHER));
  });

  it('list_sessions lists only the own conversation', async () => {
    const out = parse(await tool.handle({ query: 'list_sessions' }, own));
    assert.deepEqual((out['sessions'] as Array<{ scope: string }>).map((s) => s.scope), [OWN]);
  });

  it('session_summary of another conversation answers like a missing one', async () => {
    const other = parse(await tool.handle({ query: 'session_summary', scope: OTHER }, own));
    const missing = parse(await tool.handle({ query: 'session_summary', scope: 'agent-x::nope' }, own));
    assert.deepEqual(other, { scope: OTHER, error: 'not_found' });
    assert.deepEqual(missing, { scope: 'agent-x::nope', error: 'not_found' });
    const mine = parse(await tool.handle({ query: 'session_summary', scope: OWN }, own));
    assert.equal((mine['turns'] as unknown[]).length, 1);
  });

  it('find_entity finds only entities of the own conversation', async () => {
    const out = parse(await tool.handle({ query: 'find_entity', name_contains: 'Projekt' }, own));
    const names = (out['entities'] as Array<{ displayName: string }>).map((e) => e.displayName);
    assert.deepEqual(names, ['Projekt Möwe']);
  });

  it('stats counts only the own conversation', async () => {
    const out = parse(await tool.handle({ query: 'stats' }, own));
    assert.equal(out['sessions'], 1);
    assert.equal(out['turns'], 1);
    assert.ok(typeof out['restricted'] === 'string');
  });

  it('a turn without a conversation sees nothing at all', async () => {
    const none = { restrictToScope: null };
    const search = parse(await tool.handle({ query: 'search_turns', text: 'Kranich' }, none));
    assert.deepEqual(search['hits'], []);
    const sessions = parse(await tool.handle({ query: 'list_sessions' }, none));
    assert.deepEqual(sessions['sessions'], []);
    const stats = parse(await tool.handle({ query: 'stats' }, none));
    assert.equal(stats['turns'], 0);
    const summary = parse(await tool.handle({ query: 'session_summary', scope: OWN }, none));
    assert.equal(summary['error'], 'not_found');
  });
});
