/**
 * #1753 (ADR-0323) — deleting a web chat or a routine removes its graph
 * history under every agent, after its transcripts; other conversations and
 * shared nodes stay.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore } from '@omadia/memory';
import { graphScopeFor, graphScopeKeysFor } from '@omadia/orchestrator';
import { matchesConversationScope } from '@omadia/plugin-api';

import {
  purgeConversationGraph,
  purgeConversationRecords,
} from '../src/plugins/routines/sessionTranscripts.js';
import { seedConversationTurn } from './_helpers/conversationFixture.js';

const TENANT = 'default';

describe('#1753 — conversation scope keys', () => {
  it('match a bare key and any agent’s qualified key, not a longer key', () => {
    assert.equal(matchesConversationScope('chat-1', ['chat-1']), true);
    assert.equal(matchesConversationScope('hr::chat-1', ['chat-1']), true);
    assert.equal(matchesConversationScope('hr::xchat-1', ['chat-1']), false);
    assert.equal(matchesConversationScope('chat-10', ['chat-1']), false);
  });

  it('cover the key graphScopeFor writes, for a web chat and a routine', () => {
    for (const raw of ['3f2a-Chat_ID', 'routine:7b0e']) {
      const keys = graphScopeKeysFor(raw);
      assert.ok(matchesConversationScope(graphScopeFor('hr', raw), keys), raw);
      assert.ok(keys.every((k) => !k.includes(':')), 'keys never hold a colon');
    }
    assert.deepEqual(graphScopeKeysFor('  '), []);
  });
});

describe('#1753 — purge on delete', () => {
  async function seeded(): Promise<InMemoryKnowledgeGraph> {
    const kg = new InMemoryKnowledgeGraph();
    await seedConversationTurn(kg, { scope: graphScopeFor('hr', 'routine:r1'), time: '2026-10-01T10:00:00Z', tag: 'r1' });
    await seedConversationTurn(kg, { scope: graphScopeFor('default', 'routine:r1'), time: '2026-10-01T10:05:00Z', tag: 'r1b' });
    await seedConversationTurn(kg, { scope: graphScopeFor('hr', 'routine:r2'), time: '2026-10-01T11:00:00Z', tag: 'r2' });
    return kg;
  }

  it('removes the routine’s turns under every agent, keeps the other routine', async () => {
    const kg = await seeded();
    const before = (await kg.countConversationHistory({ tenantId: TENANT })).count;
    const deleted = await purgeConversationGraph(kg, TENANT, 'routine:r1');
    assert.ok(deleted !== undefined && deleted > 0);
    const after = (await kg.countConversationHistory({ tenantId: TENANT })).count;
    assert.equal(before - after, deleted);
    const left = await kg.countConversationHistory({
      tenantId: TENANT,
      conversationScopes: graphScopeKeysFor('routine:r2'),
    });
    assert.ok(left.count > 0, 'routine r2 keeps its history');
  });

  it('transcripts first, then the graph; a graph without purge is reported, not thrown', async () => {
    const inner = new InMemoryMemoryStore();
    await inner.writeFile('/memories/sessions/routine-r1/2026-10-01.md', '# t');
    const calls: string[] = [];
    const store = {
      directoryExists: (p: string) => inner.directoryExists(p),
      delete: async (p: string) => {
        calls.push(`delete ${p}`);
        await inner.delete(p);
      },
    };
    await purgeConversationRecords(
      {
        store,
        graph: () => {
          calls.push('graph');
          return {};
        },
        tenantId: TENANT,
      },
      'routine:r1',
    );
    assert.deepEqual(calls, ['delete /memories/sessions/routine-r1', 'graph']);
    assert.equal(await purgeConversationGraph({}, TENANT, 'routine:r1'), undefined);
  });

  it('an id with upper-case letters never reaches another chat’s folded key', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const victim = '3f2a0000-0000-4000-8000-00000000abcd';
    await seedConversationTurn(kg, { scope: graphScopeFor('hr', victim), time: '2026-10-01T10:00:00Z', tag: 'v' });
    const inner = new InMemoryMemoryStore();
    await inner.writeFile(`/memories/sessions/${victim}/2026-10-01.md`, '# t');
    const before = (await kg.countConversationHistory({ tenantId: TENANT })).count;
    await purgeConversationRecords(
      { store: inner, graph: () => kg, tenantId: TENANT },
      victim.toUpperCase(),
    );
    assert.equal((await kg.countConversationHistory({ tenantId: TENANT })).count, before);
    assert.equal(await inner.directoryExists(`/memories/sessions/${victim}`), true);
  });

  it('a failing graph purge is logged, not thrown', async () => {
    await purgeConversationRecords(
      {
        store: new InMemoryMemoryStore(),
        graph: () => ({
          purgeConversationHistory: () => Promise.reject(new Error('db down')),
        }),
        tenantId: TENANT,
      },
      'routine:r9',
    );
  });

  it('a chat delete takes only the deleting person’s turns of that key (client-chosen id)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const chatId = '3f2a0000-0000-4000-8000-0000000000aa';
    const OWNER = '7f1b8a52-0000-4000-8000-0000000000a1';
    const OTHER = '7f1b8a52-0000-4000-8000-0000000000b2';
    await seedConversationTurn(kg, { scope: graphScopeFor('hr', chatId), time: '2026-10-01T10:00:00Z', userId: OWNER, tag: 'mine' });
    // Another conversation whose graph key collides with the chat id.
    await seedConversationTurn(kg, { scope: graphScopeFor('hr', chatId), time: '2026-10-01T11:00:00Z', userId: OTHER, tag: 'theirs' });
    const deps = { store: new InMemoryMemoryStore(), graph: () => kg, tenantId: TENANT };
    await purgeConversationRecords(deps, chatId, { userId: OWNER });
    const left = await kg.countConversationHistory({ tenantId: TENANT, conversationScopes: [chatId] });
    assert.ok(left.count > 0, 'the other person’s turns stay');
    assert.equal(
      (await kg.countConversationHistory({ tenantId: TENANT, conversationScopes: [chatId], userId: OWNER })).count,
      0,
      'the owner’s turns are gone',
    );
    const before = left.count;
    await purgeConversationRecords(deps, chatId, { userId: undefined });
    assert.equal(
      (await kg.countConversationHistory({ tenantId: TENANT, conversationScopes: [chatId] })).count,
      before,
      'without an omadia user id nothing is purged from the graph',
    );
  });
});
