import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
// Phase 5B: the kernel no longer ships its own ConversationHistoryStore.
// Channel plugins construct in-package InMemoryConversationHistoryStore
// instances from `@omadia/channel-sdk`. The test imports the same
// implementation to keep coverage of the LRU + TTL invariants.
import { InMemoryConversationHistoryStore as ConversationHistoryStore } from '@omadia/channel-sdk';

describe('ConversationHistoryStore', () => {
  it('returns empty for an unknown scope', () => {
    const s = new ConversationHistoryStore();
    assert.deepEqual(s.get('teams-xyz'), []);
  });

  it('appends and returns turns in order', () => {
    const s = new ConversationHistoryStore();
    s.append('teams-a', { userMessage: 'q1', assistantAnswer: 'a1', at: 1 });
    s.append('teams-a', { userMessage: 'q2', assistantAnswer: 'a2', at: 2 });
    const got = s.get('teams-a');
    assert.equal(got.length, 2);
    assert.equal(got[0]?.userMessage, 'q1');
    assert.equal(got[1]?.userMessage, 'q2');
  });

  it('caps turns per scope at maxTurnsPerScope, dropping oldest', () => {
    const s = new ConversationHistoryStore({ maxTurnsPerScope: 3 });
    for (let i = 1; i <= 5; i++) {
      s.append('teams-a', { userMessage: `q${String(i)}`, assistantAnswer: 'a', at: i });
    }
    const got = s.get('teams-a');
    assert.equal(got.length, 3);
    assert.deepEqual(
      got.map((t) => t.userMessage),
      ['q3', 'q4', 'q5'],
    );
  });

  it('isolates scopes', () => {
    const s = new ConversationHistoryStore();
    s.append('teams-a', { userMessage: 'a-q', assistantAnswer: 'a-a', at: 1 });
    s.append('teams-b', { userMessage: 'b-q', assistantAnswer: 'b-a', at: 1 });
    assert.equal(s.get('teams-a')[0]?.userMessage, 'a-q');
    assert.equal(s.get('teams-b')[0]?.userMessage, 'b-q');
  });

  it('ignores fully empty turns', () => {
    const s = new ConversationHistoryStore();
    s.append('teams-a', { userMessage: '', assistantAnswer: '', at: 1 });
    assert.deepEqual(s.get('teams-a'), []);
  });

  it('returns a copy — caller mutation does not leak into store', () => {
    const s = new ConversationHistoryStore();
    s.append('teams-a', { userMessage: 'q', assistantAnswer: 'a', at: 1 });
    const got = s.get('teams-a');
    got.pop();
    assert.equal(s.get('teams-a').length, 1);
  });

  it('enforces maxScopes via LRU eviction', () => {
    const s = new ConversationHistoryStore({ maxScopes: 2 });
    s.append('s1', { userMessage: 'q', assistantAnswer: 'a', at: 1 });
    s.append('s2', { userMessage: 'q', assistantAnswer: 'a', at: 2 });
    // Touch s1 so s2 is now LRU.
    s.get('s1');
    s.append('s3', { userMessage: 'q', assistantAnswer: 'a', at: 3 });
    assert.equal(s.size(), 2);
    assert.equal(s.get('s2').length, 0, 's2 should have been evicted');
    assert.equal(s.get('s1').length, 1);
    assert.equal(s.get('s3').length, 1);
  });
});
