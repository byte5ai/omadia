import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';

import { ConductorChannelBindingStore } from '../src/conductor/channelBindingStore.js';

// Migration 0012 — the channel scope (Teams tenant / Slack workspace) is captured with every
// binding, additively: key unchanged, a missing scope never erases a previously known one.

function fakePool(rows: unknown[] = []): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('ConductorChannelBindingStore scope capture', () => {
  it('writes the canonical key, channel, ref and scope; COALESCE keeps an existing scope when none arrives', async () => {
    const { pool, calls } = fakePool();
    const store = new ConductorChannelBindingStore(pool);
    await store.upsert(' Teresita.Biel@Byte5.de ', 'teams', { id: 'conv-1' }, ' tenant-a ');
    assert.deepEqual(calls[0]?.params, ['teresita.biel@byte5.de', 'teams', '{"id":"conv-1"}', 'tenant-a']);
    assert.match(calls[0]?.sql ?? '', /channel_scope = COALESCE\(EXCLUDED\.channel_scope, conductor_channel_bindings\.channel_scope\)/);
    await store.upsert('x@y.z', 'teams', {}, '   ');
    assert.equal(calls[1]?.params[3], null, 'blank scope is stored as NULL so COALESCE preserves the old one');
    await store.upsert('x@y.z', 'teams', {});
    assert.equal(calls[2]?.params[3], null);
  });

  it('getScope returns the captured scope or null', async () => {
    const { pool } = fakePool([{ channel_scope: 'tenant-a' }]);
    assert.equal(await new ConductorChannelBindingStore(pool).getScope('X@Y.Z', 'teams'), 'tenant-a');
    const { pool: empty } = fakePool([]);
    assert.equal(await new ConductorChannelBindingStore(empty).getScope('x@y.z', 'teams'), null);
  });
});
