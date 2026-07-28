import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  mcpGrantToDomainTool,
  registerDbSubAgentTools,
  type HydrateDeps,
} from '../src/agents/subAgentToolHydration.js';

import type {
  McpManager,
  McpServerRow,
  NativeToolRegistry,
  ToolGrantRow,
} from '@omadia/orchestrator';
import type { AnthropicClient } from '@omadia/llm-adapter-anthropic';

const SERVER_ID = '00000000-0000-4000-8000-0000000000aa';

function fakeServerRow(overrides?: Partial<McpServerRow>): McpServerRow {
  return {
    id: SERVER_ID,
    name: 'billing',
    transport: 'http',
    endpoint: 'http://localhost:9999/mcp',
    headers: {},
    secretRef: null,
    status: 'enabled',
    lastDiscoveredAt: new Date(),
    discoveredTools: [
      {
        name: 'sum',
        description: 'Adds two numbers.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function grant(overrides?: Partial<ToolGrantRow>): ToolGrantRow {
  return {
    id: 'g1',
    agentId: 'agent-a',
    subAgentId: null,
    toolKind: 'mcp',
    toolRef: 'sum',
    mcpServerId: SERVER_ID,
    config: {},
    createdAt: new Date(),
    ...overrides,
  };
}

interface FakeHost {
  readonly registered: Map<string, { name: string; domain: string; handle: (i: unknown) => Promise<string> }>;
  readonly orchestrator: {
    hasDomainTool(name: string): boolean;
    registerDomainTool(tool: unknown): void;
  };
}

function fakeHost(): FakeHost {
  const registered = new Map<string, { name: string; domain: string; handle: (i: unknown) => Promise<string> }>();
  return {
    registered,
    orchestrator: {
      hasDomainTool: (name: string) => registered.has(name),
      registerDomainTool: (tool: unknown) => {
        const t = tool as { name: string; domain: string; handle: (i: unknown) => Promise<string> };
        registered.set(t.name, t);
      },
    },
  };
}

function fakeDeps(calls: Array<{ server: string; tool: string; args: Record<string, unknown> }>): HydrateDeps {
  const manager = {
    callTool: async (
      cfg: { name: string },
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      calls.push({ server: cfg.name, tool: toolName, args });
      return 'tool-result';
    },
  } as unknown as McpManager;
  return {
    client: {} as unknown as AnthropicClient,
    nativeToolRegistry: { get: () => undefined } as unknown as NativeToolRegistry,
    mcpManager: manager,
    mcpServers: [fakeServerRow()],
    defaultModel: 'claude-sonnet-4-6',
  };
}

describe('registerDbSubAgentTools: top-level MCP grants (#457)', () => {
  it('materializes a top-level grant even when the agent has zero sub-agents', async () => {
    const host = fakeHost();
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const n = registerDbSubAgentTools(
      { subAgents: [], skills: [], toolGrants: [grant()] },
      host,
      fakeDeps(calls),
    );
    assert.equal(n, 1);
    const tool = host.registered.get('mcp__billing__sum');
    assert.ok(tool, 'expected mcp__billing__sum to be registered as a DomainTool');
    assert.equal(tool.domain, 'mcp.billing');
    const result = await tool.handle({ a: 1, b: 2 });
    assert.equal(result, 'tool-result');
    assert.deepEqual(calls, [{ server: 'billing', tool: 'sum', args: { a: 1, b: 2 } }]);
  });

  it('is idempotent across rebuilds (onAgentBuilt hot-reload)', () => {
    const host = fakeHost();
    const deps = fakeDeps([]);
    const slice = { subAgents: [], skills: [], toolGrants: [grant()] };
    assert.equal(registerDbSubAgentTools(slice, host, deps), 1);
    assert.equal(registerDbSubAgentTools(slice, host, deps), 0);
    assert.equal(host.registered.size, 1);
  });

  it('keeps grants isolated per agent host (no cross-agent leak)', () => {
    const hostA = fakeHost();
    const hostB = fakeHost();
    const deps = fakeDeps([]);
    registerDbSubAgentTools({ subAgents: [], skills: [], toolGrants: [grant()] }, hostA, deps);
    registerDbSubAgentTools({ subAgents: [], skills: [], toolGrants: [] }, hostB, deps);
    assert.equal(hostA.registered.size, 1);
    assert.equal(hostB.registered.size, 0);
  });

  it('skips grants referencing an unknown server and logs it', () => {
    const host = fakeHost();
    const logs: string[] = [];
    const deps = { ...fakeDeps([]), log: (m: string) => logs.push(m) };
    const n = registerDbSubAgentTools(
      {
        subAgents: [],
        skills: [],
        toolGrants: [grant({ mcpServerId: '00000000-0000-4000-8000-0000000000ff' })],
      },
      host,
      deps,
    );
    assert.equal(n, 0);
    assert.ok(logs.some((m) => m.includes('unknown mcp server')));
  });

  it('leaves native top-level grants alone (process-wide already)', () => {
    const host = fakeHost();
    const n = registerDbSubAgentTools(
      {
        subAgents: [],
        skills: [],
        toolGrants: [grant({ toolKind: 'native', toolRef: 'web_search', mcpServerId: null })],
      },
      host,
      fakeDeps([]),
    );
    assert.equal(n, 0);
    assert.equal(host.registered.size, 0);
  });

  it('falls back to a schema-less descriptor when the tool is not in discoveredTools', async () => {
    const host = fakeHost();
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const n = registerDbSubAgentTools(
      { subAgents: [], skills: [], toolGrants: [grant({ toolRef: 'undiscovered_tool' })] },
      host,
      fakeDeps(calls),
    );
    assert.equal(n, 1);
    const tool = host.registered.get('mcp__billing__undiscovered_tool');
    assert.ok(tool);
    await tool.handle('not-an-object');
    assert.deepEqual(calls[0]?.args, {});
  });
});

describe('mcpGrantToDomainTool', () => {
  it('carries description and input schema from the discovered descriptor', () => {
    const manager = { callTool: async () => 'x' } as unknown as McpManager;
    const tool = mcpGrantToDomainTool(
      manager,
      { id: SERVER_ID, name: 'billing', transport: 'http', endpoint: 'http://x' },
      {
        name: 'sum',
        description: 'Adds two numbers.',
        inputSchema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      },
    );
    assert.equal(tool.name, 'mcp__billing__sum');
    assert.equal(tool.spec.description, 'Adds two numbers.');
    assert.deepEqual(Object.keys(tool.spec.input_schema.properties), ['a']);
    assert.deepEqual(tool.spec.input_schema.required, ['a']);
  });
});
