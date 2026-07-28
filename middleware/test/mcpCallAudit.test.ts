import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  McpManager,
  turnContext,
  type McpCallLogEntry,
  type McpServerConfig,
} from '@omadia/orchestrator';

const UNREACHABLE: McpServerConfig = {
  id: '00000000-0000-4000-8000-0000000000ab',
  name: 'dead-server',
  transport: 'http',
  // Port 9 (discard) on localhost: connection refused fast, no external I/O.
  endpoint: 'http://127.0.0.1:9/mcp',
};

describe('McpManager call audit observer (#462)', () => {
  it('emits an unattributed failure entry outside any turn context', async () => {
    const entries: McpCallLogEntry[] = [];
    const manager = new McpManager({ onToolCall: (e) => entries.push(e) });
    const result = await manager.callTool(UNREACHABLE, 'ping', { a: 1 });
    assert.ok(result.startsWith('Error:'));
    assert.equal(entries.length, 1);
    const e = entries[0]!;
    assert.equal(e.serverId, UNREACHABLE.id);
    assert.equal(e.serverName, 'dead-server');
    assert.equal(e.toolName, 'ping');
    assert.equal(e.ok, false);
    assert.ok(e.error?.startsWith('Error:'));
    assert.equal(e.callerKind, 'unattributed');
    assert.equal(e.turnId, null);
    assert.ok(e.durationMs >= 0);
  });

  it('attributes agent turns via turnContext', async () => {
    const entries: McpCallLogEntry[] = [];
    const manager = new McpManager({ onToolCall: (e) => entries.push(e) });
    await turnContext.run(
      { turnId: 'turn-1', turnDate: '2026-07-06', agentSlug: 'main' },
      () => manager.callTool(UNREACHABLE, 'ping', {}),
    );
    assert.equal(entries[0]?.callerKind, 'agent');
    assert.equal(entries[0]?.callerAgent, 'main');
    assert.equal(entries[0]?.turnId, 'turn-1');
  });

  it('attributes sub-agent dispatches via the owner marker', async () => {
    const entries: McpCallLogEntry[] = [];
    const manager = new McpManager({ onToolCall: (e) => entries.push(e) });
    await turnContext.run(
      {
        turnId: 'turn-2',
        turnDate: '2026-07-06',
        agentSlug: 'main',
        subAgentOwnerPluginId: '@omadia/agent-billing',
      },
      () => manager.callTool(UNREACHABLE, 'ping', {}),
    );
    assert.equal(entries[0]?.callerKind, 'subagent');
  });

  it('honors explicit skill/plugin caller overrides (taxonomy for W4/W5)', async () => {
    const entries: McpCallLogEntry[] = [];
    const manager = new McpManager({ onToolCall: (e) => entries.push(e) });
    await turnContext.run(
      {
        turnId: 'turn-3',
        turnDate: '2026-07-06',
        agentSlug: 'main',
        mcpCallerKind: 'plugin',
        mcpCallerId: '@omadia/integration-example',
      },
      () => manager.callTool(UNREACHABLE, 'ping', {}),
    );
    assert.equal(entries[0]?.callerKind, 'plugin');
    assert.equal(entries[0]?.callerAgent, '@omadia/integration-example');
  });

  it('a throwing observer never breaks the tool call', async () => {
    const manager = new McpManager({
      onToolCall: () => {
        throw new Error('observer exploded');
      },
    });
    const result = await manager.callTool(UNREACHABLE, 'ping', {});
    assert.ok(result.startsWith('Error: could not connect'));
  });

  it('the dispatch guard denies before any connection attempt and is audited', async () => {
    const entries: McpCallLogEntry[] = [];
    const manager = new McpManager({
      onToolCall: (e) => entries.push(e),
      guard: (serverId, toolName) =>
        toolName === 'ping' ? `Error: MCP tool "${toolName}" on ${serverId} denied by policy.` : null,
    });
    const denied = await manager.callTool(UNREACHABLE, 'ping', {});
    assert.ok(denied.includes('denied by policy'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, false);
    assert.ok(entries[0]?.error?.includes('denied by policy'));
    const allowed = await manager.callTool(UNREACHABLE, 'other', {});
    assert.ok(allowed.startsWith('Error: could not connect'));
  });

  it('a throwing guard fails open to the normal call path', async () => {
    const manager = new McpManager({
      guard: () => {
        throw new Error('guard exploded');
      },
    });
    const result = await manager.callTool(UNREACHABLE, 'ping', {});
    assert.ok(result.startsWith('Error: could not connect'));
  });

  it('without an observer, behavior is unchanged', async () => {
    const manager = new McpManager();
    const result = await manager.callTool(UNREACHABLE, 'ping', {});
    assert.ok(result.startsWith('Error:'));
  });

  it('surfaces the auth message on ANY failure with no token (not just 401 text)', async () => {
    // The connection error here is "could not connect", not a 401 — but with no
    // token, a protected server should still prompt to authorize (#459 W9 fix:
    // a 401 can arrive as "-32000 Connection closed").
    const manager = new McpManager({
      auth: {
        getToken: async () => null,
        onAuthFailure: async () => '🔒 connect me first: https://auth.example/authorize',
      },
    });
    const result = await manager.callTool(UNREACHABLE, 'ping', {});
    assert.ok(result.includes('connect me first'));
    assert.ok(result.includes('https://auth.example/authorize'));
  });

  it('leaves the raw error when the provider says the server is not protected', async () => {
    const manager = new McpManager({
      auth: {
        getToken: async () => null,
        onAuthFailure: async () => null, // not OAuth-protected
      },
    });
    const result = await manager.callTool(UNREACHABLE, 'ping', {});
    assert.ok(result.startsWith('Error: could not connect'));
  });
});
