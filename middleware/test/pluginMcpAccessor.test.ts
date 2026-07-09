import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createPluginMcpAccessor } from '../src/platform/pluginContext.js';

import { turnContext } from '@omadia/orchestrator';

const SERVER_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000ff';

interface Recorded {
  server: string;
  tool: string;
  callerKind: string | undefined;
  callerId: string | undefined;
}

function makeRegistry(grantedIds: string[], recorded: Recorded[]): {
  get<T>(name: string): T | undefined;
} {
  const service = {
    listServers: async () => [
      {
        id: SERVER_ID,
        name: 'billing',
        transport: 'http' as const,
        endpoint: 'http://x/mcp',
        headers: {},
        status: 'enabled' as const,
      },
      {
        id: OTHER_ID,
        name: 'dark',
        transport: 'http' as const,
        endpoint: 'http://y/mcp',
        headers: {},
        status: 'disabled' as const,
      },
    ],
    listGrantedServerIds: async () => grantedIds,
    listTools: async () => [{ name: 'sum' }],
    callTool: async (cfg: { name: string }, toolName: string): Promise<string> => {
      const ctx = turnContext.current();
      recorded.push({
        server: cfg.name,
        tool: toolName,
        callerKind: ctx?.mcpCallerKind,
        callerId: ctx?.mcpCallerId,
      });
      return 'result';
    },
  };
  return { get: <T>(name: string) => (name === 'mcp' ? (service as T) : undefined) };
}

describe('createPluginMcpAccessor (#458)', () => {
  it('calls a granted server with plugin attribution', async () => {
    const recorded: Recorded[] = [];
    const accessor = createPluginMcpAccessor(
      '@omadia/integration-example',
      makeRegistry([SERVER_ID], recorded),
    );
    const result = await accessor.callTool(SERVER_ID, 'sum', { a: 1 });
    assert.equal(result, 'result');
    assert.equal(recorded[0]?.callerKind, 'plugin');
    assert.equal(recorded[0]?.callerId, '@omadia/integration-example');
  });

  it('denies ungranted servers fail-closed', async () => {
    const accessor = createPluginMcpAccessor('@x/p', makeRegistry([], []));
    await assert.rejects(accessor.callTool(SERVER_ID, 'sum', {}), /not granted/);
    await assert.rejects(accessor.listTools(SERVER_ID), /not granted/);
  });

  it('denies granted-but-disabled servers', async () => {
    const accessor = createPluginMcpAccessor('@x/p', makeRegistry([OTHER_ID], []));
    await assert.rejects(accessor.callTool(OTHER_ID, 'sum', {}), /missing or disabled/);
  });

  it('listServers returns exactly the granted ids', async () => {
    const accessor = createPluginMcpAccessor('@x/p', makeRegistry([SERVER_ID], []));
    assert.deepEqual(await accessor.listServers(), [SERVER_ID]);
  });

  it('throws a clear error when the host service is absent', async () => {
    const accessor = createPluginMcpAccessor('@x/p', { get: () => undefined });
    await assert.rejects(accessor.listServers(), /host service unavailable/);
  });
});
