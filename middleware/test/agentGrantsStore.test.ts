/**
 * Per-agent grant read model (W0c, epic #860, issue #861).
 *
 * The agent detail UI needs an agent-scoped read of `agent_tool_grants` and a
 * plugin-scoped read of `plugin_mcp_grants` — SELECT-only additions on
 * `AgentGraphStore`, no DDL. The "grant epoch" is NOT a column:
 * `bumpMcpGrantEpoch` stamps `config.verdictEpoch` (a `now()::text`
 * timestamp) into the grant's JSONB, so the store must surface it as the
 * typed `ToolGrantRow.grantEpoch` field instead of making the UI dig through
 * untyped config.
 *
 * Pool is stubbed (same pattern as agentGraphStoreSubAgentModelValidation):
 * the contract under test is which SQL is sent with which params, and how
 * rows map back — not Postgres itself.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { AgentGraphStore } from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/** Capture every `query()` call and replay a canned row set. */
function fakePool(rows: unknown[] = []): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

const AGENT_ID = '00000000-0000-0000-0000-000000000001';
const SERVER_ID = '00000000-0000-0000-0000-00000000000f';

function toolGrantDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    agent_id: AGENT_ID,
    subagent_id: null,
    tool_kind: 'mcp',
    tool_ref: 'search',
    mcp_server_id: SERVER_ID,
    config: {},
    created_at: new Date(0),
    ...overrides,
  };
}

// ── listToolGrantsForAgent ──────────────────────────────────────────────────

test('listToolGrantsForAgent reads the agent AND its sub-agents, ordered by created_at', async () => {
  const { pool, calls } = fakePool([toolGrantDbRow()]);
  const store = new AgentGraphStore(pool);
  const rows = await store.listToolGrantsForAgent(AGENT_ID);

  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /FROM agent_tool_grants/);
  assert.match(sql, /WHERE agent_id = \$1/);
  // agent_tool_grants is a XOR table (0003): a sub-agent-held grant has
  // agent_id NULL. The read must attribute those rows to the parent agent,
  // matching assembleGraph/indexGraph — an agent_id-only filter silently
  // hides sub-agent grants from the detail page (W0c review).
  assert.match(
    sql,
    /subagent_id IN \(SELECT id FROM agent_subagents WHERE parent_agent_id = \$1\)/,
    'sub-agent-held grants must be attributed to the parent agent',
  );
  assert.match(sql, /ORDER BY created_at/);
  assert.deepEqual(params, [AGENT_ID]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agentId, AGENT_ID);
  assert.equal(rows[0]!.toolRef, 'search');
  assert.equal(rows[0]!.mcpServerId, SERVER_ID);
});

test('listToolGrantsForAgent maps a sub-agent-held row (agent_id NULL) faithfully', async () => {
  const SUB_AGENT_ID = '00000000-0000-0000-0000-0000000000cc';
  const { pool } = fakePool([
    toolGrantDbRow({ agent_id: null, subagent_id: SUB_AGENT_ID }),
  ]);
  const store = new AgentGraphStore(pool);
  const [row] = await store.listToolGrantsForAgent(AGENT_ID);
  assert.equal(row!.agentId, null);
  assert.equal(row!.subAgentId, SUB_AGENT_ID, 'sub_agent attribution must survive the mapper');
});

test('listToolGrantsForAgent is SELECT-only — never writes', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await store.listToolGrantsForAgent(AGENT_ID);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql.trimStart(), /^SELECT/i, 'statement is a SELECT');
  assert.doesNotMatch(calls[0]!.sql, /\b(INSERT|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/i);
});

// ── grant epoch surfacing ───────────────────────────────────────────────────

test('grantEpoch surfaces config.verdictEpoch as a typed field', async () => {
  const epoch = '2026-08-25 12:00:00.000000+00';
  const { pool } = fakePool([
    toolGrantDbRow({ config: { verdictEpoch: epoch, other: 1 } }),
  ]);
  const store = new AgentGraphStore(pool);
  const [row] = await store.listToolGrantsForAgent(AGENT_ID);
  assert.equal(row!.grantEpoch, epoch);
  // The raw config stays intact for callers that need the rest of it.
  assert.equal(row!.config['other'], 1);
});

test('grantEpoch is null before the first bumpMcpGrantEpoch', async () => {
  const { pool } = fakePool([toolGrantDbRow({ config: {} })]);
  const store = new AgentGraphStore(pool);
  const [row] = await store.listToolGrantsForAgent(AGENT_ID);
  assert.equal(row!.grantEpoch, null);
});

test('grantEpoch rejects a non-string verdictEpoch (hand-edited config) as null', async () => {
  const { pool } = fakePool([toolGrantDbRow({ config: { verdictEpoch: 42 } })]);
  const store = new AgentGraphStore(pool);
  const [row] = await store.listToolGrantsForAgent(AGENT_ID);
  assert.equal(row!.grantEpoch, null);
});

test('listAllToolGrants carries grantEpoch too (same mapper)', async () => {
  const epoch = '2026-08-25 12:34:56.000000+00';
  const { pool } = fakePool([toolGrantDbRow({ config: { verdictEpoch: epoch } })]);
  const store = new AgentGraphStore(pool);
  const [row] = await store.listAllToolGrants();
  assert.equal(row!.grantEpoch, epoch);
});

// ── listPluginMcpGrantsForPlugins ───────────────────────────────────────────

function pluginGrantDbRow(pluginId: string): Record<string, unknown> {
  return {
    plugin_id: pluginId,
    mcp_server_id: SERVER_ID,
    granted_by: 'operator@example.com',
    granted_at: new Date(0),
  };
}

test('listPluginMcpGrantsForPlugins reads full rows for the given plugin set', async () => {
  const { pool, calls } = fakePool([
    pluginGrantDbRow('odoo-hr'),
    pluginGrantDbRow('teams-channel'),
  ]);
  const store = new AgentGraphStore(pool);
  const rows = await store.listPluginMcpGrantsForPlugins(['odoo-hr', 'teams-channel']);

  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /FROM plugin_mcp_grants/);
  assert.match(sql, /WHERE plugin_id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(params, [['odoo-hr', 'teams-channel']]);

  assert.deepEqual(rows[0], {
    pluginId: 'odoo-hr',
    mcpServerId: SERVER_ID,
    grantedBy: 'operator@example.com',
    grantedAt: new Date(0),
  });
});

test('listPluginMcpGrantsForPlugins short-circuits an empty plugin set without SQL', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  const rows = await store.listPluginMcpGrantsForPlugins([]);
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 0, 'no round-trip for an agent with no plugins');
});

test('listPluginMcpGrants maps rows through the same named shape', async () => {
  const { pool } = fakePool([pluginGrantDbRow('odoo-hr')]);
  const store = new AgentGraphStore(pool);
  const [row] = await store.listPluginMcpGrants();
  assert.equal(row!.pluginId, 'odoo-hr');
  assert.equal(row!.mcpServerId, SERVER_ID);
  assert.equal(row!.grantedBy, 'operator@example.com');
});

// ── applyMcpToolAllowlist (transactional bulk edit, W0c #862) ───────────────

/** Pool whose `connect()` hands out a capturing client — `applyMcpToolAllowlist`
 *  must run every write on ONE client inside BEGIN/COMMIT. */
function fakeClientPool(failOn?: RegExp): {
  pool: Pool;
  calls: string[];
  released: { value: boolean };
} {
  const calls: string[] = [];
  const released = { value: false };
  const client = {
    query: async (sql: string, _params?: unknown[]) => {
      calls.push(sql);
      if (failOn && failOn.test(sql)) throw new Error(`boom on ${sql.slice(0, 30)}`);
      return { rows: [] };
    },
    release: () => {
      released.value = true;
    },
  };
  const pool = {
    connect: async () => client,
    query: async () => {
      throw new Error('applyMcpToolAllowlist must not use pool.query — writes belong on the transaction client');
    },
  } as unknown as Pool;
  return { pool, calls, released };
}

test('applyMcpToolAllowlist wraps every grant and revoke in one BEGIN/COMMIT', async () => {
  const { pool, calls, released } = fakeClientPool();
  const store = new AgentGraphStore(pool);
  await store.applyMcpToolAllowlist({
    agentId: AGENT_ID,
    mcpServerId: SERVER_ID,
    grantRefs: ['read_partners', 'search'],
    revokeIds: ['00000000-0000-0000-0000-0000000000aa'],
  });
  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls.at(-1), 'COMMIT');
  const inserts = calls.filter((c) => /INSERT INTO agent_tool_grants/.test(c));
  const deletes = calls.filter((c) => /DELETE FROM agent_tool_grants/.test(c));
  assert.equal(inserts.length, 2);
  assert.equal(deletes.length, 1);
  assert.match(inserts[0]!, /ON CONFLICT/, 'keeps createToolGrant\'s idempotent contract (0014)');
  assert.equal(released.value, true, 'client returned to the pool');
});

test('applyMcpToolAllowlist rolls back the whole edit when one write fails', async () => {
  const { pool, calls, released } = fakeClientPool(/DELETE FROM/);
  const store = new AgentGraphStore(pool);
  await assert.rejects(
    store.applyMcpToolAllowlist({
      agentId: AGENT_ID,
      mcpServerId: SERVER_ID,
      grantRefs: ['read_partners'],
      revokeIds: ['00000000-0000-0000-0000-0000000000aa'],
    }),
    /boom/,
  );
  assert.equal(calls.at(-1), 'ROLLBACK', 'a partial edit must not persist');
  assert.ok(!calls.includes('COMMIT'));
  assert.equal(released.value, true, 'client returned to the pool even on failure');
});
