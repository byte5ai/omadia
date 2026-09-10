/** OM-95: plugin uninstall revokes bindings across agents with one query. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

// Recording-pool fixture, as in agentGrantsStore.test.ts.
function fakePool(rowCount: number | null): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('deleteAgentPluginsForPlugin deletes enabled and disabled bindings across all agents, scoped to the bound plugin id', async () => {
  const { pool, calls } = fakePool(3);
  const pluginId = "plugin' OR 1=1 --";

  assert.equal(await new ConfigStore(pool).deleteAgentPluginsForPlugin(pluginId), 3);
  assert.deepEqual(calls, [{
    sql: 'DELETE FROM agent_plugins WHERE plugin_id = $1',
    params: [pluginId],
  }]);
});

test('deleteAgentPluginsForPlugin returns zero when no binding exists', async () => {
  const { pool, calls } = fakePool(0);

  assert.equal(await new ConfigStore(pool).deleteAgentPluginsForPlugin('absent'), 0);
  assert.equal(calls.length, 1);
});

test('deleteAgentPluginsForPlugin treats an unavailable row count as zero', async () => {
  const { pool } = fakePool(null);

  assert.equal(await new ConfigStore(pool).deleteAgentPluginsForPlugin('absent'), 0);
});

test('deleteAgentPluginsForPlugin passes database failures to the best-effort lifecycle cleanup', async () => {
  const error = new Error('database unavailable');
  const pool = {
    query: async () => { throw error; },
  } as unknown as Pool;

  await assert.rejects(
    new ConfigStore(pool).deleteAgentPluginsForPlugin('plugin'),
    (caught: unknown) => caught === error,
  );
});
