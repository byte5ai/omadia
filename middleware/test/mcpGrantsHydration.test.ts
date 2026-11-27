import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MCP_NATIVE_TOOL_NAME_PATTERN,
  McpManager,
  mcpNativeToolName,
  mcpNativeToolNameCollision,
  type McpServerConfig,
} from '../packages/harness-orchestrator/src/mcp/mcpClient.js';
import type { ToolGrantRow } from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import {
  mcpToolNameFromRef,
  resolveSubAgentTools,
} from '../packages/harness-orchestrator/src/registry/subAgentTools.js';
import { persistDiscoveredTools } from '../src/services/mcpDiscoveryPersist.js';

/**
 * W09-10 grants/hydration — #1948 native names, #1939 duplicate grants,
 * #1910 helper descriptors, #1917 tools no longer offered + empty tool lists.
 */

describe('mcpNativeToolName (#1948)', () => {
  it('keeps every name that fits exactly as before', () => {
    assert.equal(mcpNativeToolName('Exa Search', 'web.search'), 'mcp__Exa_Search__web_search');
    assert.equal(mcpNativeToolName('exa', 'search'), 'mcp__exa__search');
  });

  it('gives two long names that share 64 characters different, valid names', () => {
    const prefix = 'x'.repeat(70);
    const a = mcpNativeToolName('srv', `${prefix}_list`);
    const b = mcpNativeToolName('srv', `${prefix}_delete`);
    assert.notEqual(a, b);
    for (const name of [a, b]) {
      assert.match(name, MCP_NATIVE_TOOL_NAME_PATTERN);
      assert.equal(name.length, 64);
    }
    assert.equal(mcpNativeToolName('srv', `${prefix}_list`), a, 'stable');
  });

  it('reports a collision through replaced characters, not a tool with itself', () => {
    assert.equal(mcpNativeToolNameCollision('srv', 'a_b', ['a.b', 'c']), 'a.b');
    assert.equal(mcpNativeToolNameCollision('srv', 'a_b', ['a_b', 'c']), undefined);
  });
});

describe('mcpToolNameFromRef (#1948)', () => {
  it('strips only the "<server>:" prefix; a ":" in the tool name stays', () => {
    assert.equal(mcpToolNameFromRef('exa:web_search', 'exa'), 'web_search');
    assert.equal(mcpToolNameFromRef('ns:tool', 'exa'), 'ns:tool');
    assert.equal(mcpToolNameFromRef('exa:ns:tool', 'exa'), 'ns:tool');
  });
});

const SERVER_ID = '00000000-0000-4000-8000-000000001910';
const cfg: McpServerConfig = { id: SERVER_ID, name: 'billing', transport: 'http', endpoint: 'http://x.invalid/mcp' };

function grant(id: string, toolRef: string, toolKind: 'mcp' | 'native' = 'mcp'): ToolGrantRow {
  return {
    id,
    agentId: null,
    subAgentId: 'sub-1',
    toolKind,
    toolRef,
    mcpServerId: toolKind === 'mcp' ? SERVER_ID : null,
    config: {},
    createdAt: new Date(),
  } as unknown as ToolGrantRow;
}

describe('resolveSubAgentTools (#1910, #1939, #1917)', () => {
  const deps = {
    provider: {} as never,
    defaultModel: 'm',
    defaultMaxTokens: 1,
    defaultMaxIterations: 1,
    mcpManager: new McpManager(),
    mcpServersById: new Map([[SERVER_ID, cfg]]),
  };

  it('one tool per granted tool, whatever the number of rows', () => {
    const tools = resolveSubAgentTools([grant('g1', 'sum'), grant('g2', 'sum'), grant('g3', 'billing:sum')], deps);
    assert.deepEqual(
      tools.map((t) => t.spec.name),
      ['mcp__billing__sum'],
    );
  });

  it('carries the discovered description and input schema', () => {
    const [tool] = resolveSubAgentTools([grant('g1', 'sum')], {
      ...deps,
      mcpDescriptor: (_s, name) => ({
        name,
        description: 'Adds two numbers.',
        inputSchema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      }),
    });
    assert.equal(tool!.spec.description, 'Adds two numbers.');
    assert.deepEqual(tool!.spec.input_schema.required, ['a']);
  });

  it('skips a tool the server no longer offers', () => {
    const tools = resolveSubAgentTools([grant('g1', 'gone')], { ...deps, mcpDescriptor: () => undefined });
    assert.deepEqual(tools, []);
  });
});

describe('persistDiscoveredTools (#1917)', () => {
  function fakeGraph() {
    const calls: string[] = [];
    return {
      calls,
      graph: {
        upsertMcpToolVerdict: async () => {
          calls.push('verdict');
        },
        pruneMcpToolVerdicts: async () => {
          calls.push('prune');
        },
        setMcpDiscoveredTools: async () => {
          calls.push('store');
        },
      } as never,
    };
  }

  it('keeps the previous tools when a server suddenly lists none', async () => {
    const { calls, graph } = fakeGraph();
    const out = await persistDiscoveredTools(graph, { id: SERVER_ID, discoveredTools: [{ name: 'sum' }] }, []);
    assert.equal(out.emptyListIgnored, true);
    assert.deepEqual(calls, [], 'nothing pruned, nothing stored');
  });

  it('stores an empty list for a server that never listed tools', async () => {
    const { calls, graph } = fakeGraph();
    const out = await persistDiscoveredTools(graph, { id: SERVER_ID, discoveredTools: [] }, []);
    assert.equal(out.emptyListIgnored, false);
    assert.deepEqual(calls, ['prune', 'store']);
  });

  it('scans, prunes, then stores a non-empty list', async () => {
    const { calls, graph } = fakeGraph();
    await persistDiscoveredTools(graph, { id: SERVER_ID, discoveredTools: [] }, [{ name: 'sum' }]);
    assert.deepEqual(calls, ['verdict', 'prune', 'store']);
  });
});
