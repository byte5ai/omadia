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

test('listToolGrantsForAgent selects only the given agent, ordered by created_at', async () => {
  const { pool, calls } = fakePool([toolGrantDbRow()]);
  const store = new AgentGraphStore(pool);
  const rows = await store.listToolGrantsForAgent(AGENT_ID);

  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /FROM agent_tool_grants/);
  assert.match(sql, /WHERE agent_id = \$1/);
  assert.match(sql, /ORDER BY created_at/);
  assert.deepEqual(params, [AGENT_ID]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agentId, AGENT_ID);
  assert.equal(rows[0]!.toolRef, 'search');
  assert.equal(rows[0]!.mcpServerId, SERVER_ID);
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
