import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { McpServerConfig, McpServerRow } from '@omadia/orchestrator';

import { mcpActionId, parseMcpActionId } from '../src/conductor/mcpActionId.js';
import { createMcpActionInvoker, mcpActionIds } from '../src/conductor/mcpActionInvoker.js';

// MCP tools as Conductor action steps: id algebra, catalog derivation, and the
// fail-closed dispatcher (service delegation only, errors never become results).

function server(over: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: 'srv-1',
    name: 'Pleo',
    transport: 'http',
    endpoint: 'https://mcp.pleo.example/mcp',
    headers: {},
    secretRef: null,
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [{ name: 'list_missing_receipts' }, { name: 'attach_receipt' }, { nope: true }, { name: '  ' }],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    source: 'manual',
    registryId: null,
    license: null,
    author: null,
    sourceUrl: null,
    privacyBypass: false,
    kgIngest: false,
    configSchema: [],
    config: {},
    delegation: 'service',
    ...over,
  } as McpServerRow;
}

describe('mcp action ids', () => {
  it('round-trips, keeps colons inside tool names, rejects non-mcp ids', () => {
    assert.deepEqual(parseMcpActionId(mcpActionId('abc', 'do_x')), { serverId: 'abc', toolName: 'do_x' });
    assert.deepEqual(parseMcpActionId('mcp:abc:ns:tool'), { serverId: 'abc', toolName: 'ns:tool' });
    assert.equal(parseMcpActionId('webhook.post'), null);
    assert.equal(parseMcpActionId('mcp:abc:'), null);
    assert.equal(parseMcpActionId('mcp::tool'), null);
  });

  it('derives sorted ids for enabled service-delegated servers only, skipping nameless tools', () => {
    const ids = mcpActionIds([server(), server({ id: 'srv-2', status: 'disabled' }), server({ id: 'srv-3', delegation: 'per_user' })]);
    assert.deepEqual(ids, ['mcp:srv-1:attach_receipt', 'mcp:srv-1:list_missing_receipts']);
    const gated = mcpActionIds([server()], (_s, t) => (t === 'attach_receipt' ? 'blocked' : null));
    assert.deepEqual(gated, ['mcp:srv-1:list_missing_receipts'], 'verdict-blocked tools leave the catalog so the builder reports them missing');
  });
});

describe('createMcpActionInvoker', () => {
  function harness(rows: McpServerRow[], result = 'ok', denial: (s: string, t: string) => string | null = () => null) {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const invoke = createMcpActionInvoker({
      dispatchDenial: denial,
      listServers: async () => rows,
      getMcp: () => ({
        callTool: async (_cfg, toolName, args) => {
          calls.push({ toolName, args });
          return result;
        },
      }),
      toConfig: (row) => ({ id: row.id, name: row.name, transport: row.transport, endpoint: row.endpoint ?? undefined }) as unknown as McpServerConfig,
    });
    return { invoke, calls };
  }

  it('calls the tool with object input and returns the text result', async () => {
    const { invoke, calls } = harness([server()]);
    assert.equal(await invoke('mcp:srv-1:attach_receipt', { id: 7 }), 'ok');
    assert.deepEqual(calls, [{ toolName: 'attach_receipt', args: { id: 7 } }]);
  });

  it('coerces non-object input to {}', async () => {
    const { invoke, calls } = harness([server()]);
    await invoke('mcp:srv-1:attach_receipt', 'nope');
    assert.deepEqual(calls[0]?.args, {});
  });

  it('fails closed: unknown server, disabled server, non-service delegation — no call issued', async () => {
    const { invoke, calls } = harness([server({ id: 'srv-1' }), server({ id: 'srv-off', status: 'disabled' }), server({ id: 'srv-user', delegation: 'per_user' })]);
    await assert.rejects(invoke('mcp:ghost:tool', {}), /mcp server not found/);
    await assert.rejects(invoke('mcp:srv-off:tool', {}), /mcp server disabled/);
    await assert.rejects(invoke('mcp:srv-user:tool', {}), /service delegation/);
    const { invoke: invokeUndefined } = harness([server({ delegation: undefined as unknown as 'service' })]);
    await assert.rejects(invokeUndefined('mcp:srv-1:tool', {}), /service delegation/);
    assert.equal(calls.length, 0);
  });

  it('throws when mcp is not wired or the id is not an mcp id', async () => {
    const invoke = createMcpActionInvoker({ listServers: async () => [server()], getMcp: () => undefined, toConfig: () => ({}) as unknown as McpServerConfig, dispatchDenial: () => null });
    await assert.rejects(invoke('mcp:srv-1:tool', {}), /mcp is not wired/);
    await assert.rejects(invoke('webhook.post', {}), /not an mcp action id/);
  });

  it('enforces the scan-verdict dispatch gate before calling (no call on denial)', async () => {
    const { invoke, calls } = harness([server()], 'ok', (_s, t) => (t === 'attach_receipt' ? 'Error: MCP tool "attach_receipt" is blocked by the scan-verdict policy' : null));
    await assert.rejects(invoke('mcp:srv-1:attach_receipt', {}), /scan-verdict policy/);
    assert.equal(calls.length, 0);
    assert.equal(await invoke('mcp:srv-1:list_missing_receipts', {}), 'ok');
  });

  it('turns an "Error: …" text result into a step failure', async () => {
    const { invoke } = harness([server()], 'Error: receipt not found');
    await assert.rejects(invoke('mcp:srv-1:attach_receipt', {}), /Error: receipt not found/);
  });
});
