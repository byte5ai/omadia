import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createBotPresenceStore } from '../src/conductor/botPresenceStore.js';

// The partner list is built on this. The first live run used the conversation
// ROSTER instead and found nothing in a chat holding four bots, because Teams'
// roster API returns people and never bots.

function fakePool(over: { rows?: { bot_app_id: string }[]; throws?: Error } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    pool: {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (over.throws) throw over.throws;
        return { rows: over.rows ?? [] };
      },
    } as never,
  };
}

describe('bot presence', () => {
  it('returns the bots that hold a reference in the conversation', async () => {
    const { pool, queries } = fakePool({
      rows: [{ bot_app_id: '3d78d742-eefb-4fb2-bae5-3687f24c46fc' }, { bot_app_id: '19ad2729-f7d3-4099-9d2a-7da1230c9533' }],
    });
    const store = createBotPresenceStore(pool);
    assert.deepEqual(await store.botAppIdsIn('19:chat@thread.skype'), [
      '3d78d742-eefb-4fb2-bae5-3687f24c46fc',
      '19ad2729-f7d3-4099-9d2a-7da1230c9533',
    ]);
    assert.deepEqual(queries[0]?.params, ['19:chat@thread.skype']);
  });

  it('excludes the legacy unattributed row — it names no specific bot', async () => {
    const { pool, queries } = fakePool({ rows: [] });
    const store = createBotPresenceStore(pool);
    await store.botAppIdsIn('c1');
    assert.match(queries[0]?.sql ?? '', /bot_app_id <> ''/);
  });

  it('degrades to empty on a missing table rather than throwing', async () => {
    const logs: string[] = [];
    const { pool } = fakePool({ throws: new Error('relation "teams_conversation_refs" does not exist') });
    const store = createBotPresenceStore(pool, (m) => logs.push(m));
    // Empty is the honest answer: it refuses a discussion instead of starting
    // one whose second voice may never arrive.
    assert.deepEqual(await store.botAppIdsIn('c1'), []);
    assert.equal(logs.length, 1);
  });
});
