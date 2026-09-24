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

  // #1018 — the reverse lookup the operator's peer-chat picker is built on:
  // only chats the agent's own bot holds a reference in are worth offering.
  describe('conversationsOf', () => {
    function convPool(rows: Record<string, unknown>[], throws?: Error) {
      const queries: { sql: string; params: unknown[] }[] = [];
      return {
        queries,
        pool: {
          query: async (sql: string, params: unknown[]) => {
            queries.push({ sql, params });
            if (throws) throw throws;
            return { rows };
          },
        } as never,
      };
    }

    it('lists the conversations the bot is in, with topic and every bot present', async () => {
      const at = new Date('2026-09-07T10:00:00Z');
      const { pool, queries } = convPool([
        {
          conversation_id: '19:abc@thread.skype',
          teams_type: 'groupChat',
          name: 'Sales sync',
          updated_at: at,
          bot_app_ids: ['3d78d742-eefb-4fb2-bae5-3687f24c46fc', '19ad2729-f7d3-4099-9d2a-7da1230c9533'],
        },
        { conversation_id: 'a:1', teams_type: 'personal', name: '   ', updated_at: at, bot_app_ids: null },
      ]);
      const store = createBotPresenceStore(pool);
      const got = await store.conversationsOf('3D78D742-EEFB-4FB2-BAE5-3687F24C46FC');
      // The app id is matched case-insensitively — Entra hands it out in
      // either casing and the reference table stores whatever it saw.
      assert.deepEqual(queries[0]?.params, ['3d78d742-eefb-4fb2-bae5-3687f24c46fc']);
      assert.match(queries[0]?.sql ?? '', /lower\(r\.bot_app_id\) = \$1/);
      assert.equal(got.length, 2);
      assert.deepEqual(got[0], {
        conversationId: '19:abc@thread.skype',
        teamsType: 'groupChat',
        name: 'Sales sync',
        updatedAt: at,
        botAppIds: ['3d78d742-eefb-4fb2-bae5-3687f24c46fc', '19ad2729-f7d3-4099-9d2a-7da1230c9533'],
      });
      // A blank topic is no topic; a null aggregate is no bot.
      assert.equal(got[1]?.name, null);
      assert.deepEqual(got[1]?.botAppIds, []);
    });

    it('asks nothing for an empty app id and degrades to empty on failure', async () => {
      const { pool, queries } = convPool([]);
      assert.deepEqual(await createBotPresenceStore(pool).conversationsOf('  '), []);
      assert.equal(queries.length, 0);

      const logs: string[] = [];
      const failing = convPool([], new Error('relation "teams_conversation_refs" does not exist'));
      assert.deepEqual(await createBotPresenceStore(failing.pool, (m) => logs.push(m)).conversationsOf('x'), []);
      assert.equal(logs.length, 1);
    });
  });
});
