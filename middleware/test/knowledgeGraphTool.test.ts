import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { KnowledgeGraphTool } from '@omadia/orchestrator';

async function seed(): Promise<InMemoryKnowledgeGraph> {
  const g = new InMemoryKnowledgeGraph();
  await g.ingestTurn({
    scope: 'talk-a',
    time: '2026-04-18T09:00:00.000Z',
    userMessage: 'Wer ist Anna?',
    assistantAnswer: 'Eine Mitarbeiterin.',
    entityRefs: [
      { system: 'odoo', model: 'hr.employee', id: 42, displayName: 'Anna Müller', op: 'read' },
    ],
  });
  await g.ingestTurn({
    scope: 'talk-a',
    time: '2026-04-18T09:05:00.000Z',
    userMessage: 'Und der Vertrag?',
    assistantAnswer: 'Der aktuelle Vertrag läuft …',
    entityRefs: [
      { system: 'odoo', model: 'hr.contract', id: 99, displayName: 'Contract Anna', op: 'read' },
      { system: 'odoo', model: 'hr.employee', id: 42, displayName: 'Anna Müller', op: 'read' },
    ],
  });
  await g.ingestTurn({
    scope: 'talk-b',
    time: '2026-04-18T10:00:00.000Z',
    userMessage: 'Playbook für Onboarding?',
    assistantAnswer: 'Siehe Wiki.',
    entityRefs: [
      { system: 'confluence', model: 'confluence.page', id: '100', displayName: 'Onboarding', op: 'read' },
    ],
  });
  return g;
}

describe('KnowledgeGraphTool', () => {
  let tool: KnowledgeGraphTool;
  before(async () => {
    tool = new KnowledgeGraphTool(await seed());
  });

  it('rejects inputs with an unknown query type', async () => {
    const out = await tool.handle({ query: 'what' });
    assert.match(out, /Error: invalid/);
  });

  it('stats returns node + edge counts', async () => {
    const out = await tool.handle({ query: 'stats' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.byNodeType.Session, 2);
    assert.equal(parsed.byNodeType.Turn, 3);
  });

  it('list_sessions returns sessions most-recent first, limited', async () => {
    const out = await tool.handle({ query: 'list_sessions', limit: 1 });
    const parsed = JSON.parse(out) as { sessions: Array<{ scope: string }> };
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0]?.scope, 'talk-b');
  });

  it('find_entity by name_contains matches case-insensitively', async () => {
    const out = await tool.handle({ query: 'find_entity', name_contains: 'anna' });
    const parsed = JSON.parse(out) as {
      entities: Array<{ displayName: string; mentionedInTurns: number; model: string }>;
    };
    assert.ok(parsed.entities.length >= 1);
    const anna = parsed.entities.find((e) => e.displayName === 'Anna Müller');
    assert.ok(anna);
    // Mentioned in two distinct turns (same scope).
    assert.equal(anna.mentionedInTurns, 2);
  });

  it('find_entity filters by model', async () => {
    const out = await tool.handle({
      query: 'find_entity',
      name_contains: 'anna',
      model: 'hr.contract',
    });
    const parsed = JSON.parse(out) as {
      entities: Array<{ model: string }>;
    };
    assert.equal(parsed.entities.length, 1);
    assert.equal(parsed.entities[0]?.model, 'hr.contract');
  });

  it('find_entity requires at least one filter', async () => {
    const out = await tool.handle({ query: 'find_entity' });
    assert.match(out, /requires at least one/);
  });

  it('session_summary returns turns with entities for a known scope', async () => {
    const out = await tool.handle({ query: 'session_summary', scope: 'talk-a' });
    const parsed = JSON.parse(out) as {
      scope: string;
      turns: Array<{ userMessage: string; entities: Array<{ model: string }> }>;
    };
    assert.equal(parsed.scope, 'talk-a');
    assert.equal(parsed.turns.length, 2);
    assert.deepEqual(
      parsed.turns[1]?.entities.map((e) => e.model).sort(),
      ['hr.contract', 'hr.employee'],
    );
  });

  it('session_summary returns {error: not_found} for unknown scope', async () => {
    const out = await tool.handle({ query: 'session_summary', scope: 'nope' });
    const parsed = JSON.parse(out) as { error?: string };
    assert.equal(parsed.error, 'not_found');
  });

  it('session_summary requires a scope arg', async () => {
    const out = await tool.handle({ query: 'session_summary' });
    assert.match(out, /requires `scope`/);
  });
});
