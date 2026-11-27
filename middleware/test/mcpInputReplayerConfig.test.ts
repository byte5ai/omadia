import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { McpServerConfig, McpServerRow, PendingMcpInput } from '@omadia/orchestrator';

import { createMcpInputReplayer } from '../src/services/mcpInputReplayer.js';

/**
 * #1932 — a replayed `input_required` call connects with the server's full
 * config: non-secret endpoint placeholders filled and static headers set, the
 * same mapping (`mcpRowToConfig`) as every other call path. The pool may have
 * evicted the original connection by the time the user answers, so the replay
 * config is what the reconnect uses.
 */

const SERVER_ID = '00000000-0000-4000-8000-000000001932';

const row = {
  id: SERVER_ID,
  name: 'tenant-api',
  transport: 'http',
  endpoint: 'https://{tenant}.example.com/mcp',
  headers: { 'X-Static': 'static-value', 'X-Region': '{region}' },
  config: { tenant: 'acme', region: 'eu' },
  secretRef: null,
  status: 'enabled',
  lastDiscoveredAt: new Date(),
  discoveredTools: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as McpServerRow;

const record: PendingMcpInput = {
  correlationId: 'c-1',
  serverId: SERVER_ID,
  serverName: 'tenant-api',
  toolName: 'lookup',
  originalArgs: { q: 'x' },
  inputRequests: [{ name: 'customerNumber', required: true }],
  replayDepth: 0,
};

describe('MCP input replayer config (#1932)', () => {
  it('replays with placeholders filled and static headers kept', async () => {
    const seen: McpServerConfig[] = [];
    const replayer = createMcpInputReplayer({
      listServers: async () => [row],
      manager: {
        callTool: async (cfg: McpServerConfig) => {
          seen.push(cfg);
          return 'ok';
        },
      },
    });

    const out = await replayer.replay(record, { customerNumber: '42' });

    assert.equal(out, 'ok');
    assert.equal(seen[0]!.endpoint, 'https://acme.example.com/mcp');
    assert.deepEqual(seen[0]!.headers, { 'X-Static': 'static-value', 'X-Region': 'eu' });
  });

  it('a deleted server is unreachable, not a call', async () => {
    let calls = 0;
    const replayer = createMcpInputReplayer({
      listServers: async () => [],
      manager: { callTool: async () => String(++calls) },
    });
    assert.equal(await replayer.replay(record, {}), undefined);
    assert.equal(calls, 0);
  });
});
