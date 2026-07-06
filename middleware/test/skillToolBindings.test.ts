import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseRequiresTools,
  registerDbSubAgentTools,
  type HydrateDeps,
} from '../src/agents/subAgentToolHydration.js';

import type {
  McpManager,
  McpServerRow,
  NativeToolRegistry,
  SkillRow,
  SkillToolBindingRow,
} from '@omadia/orchestrator';
import type { AnthropicClient } from '@omadia/llm-adapter-anthropic';

const SERVER_ID = '00000000-0000-4000-8000-0000000000aa';
const SKILL_ID = '00000000-0000-4000-8000-0000000000bb';

function server(overrides?: Partial<McpServerRow>): McpServerRow {
  return {
    id: SERVER_ID,
    name: 'crm',
    transport: 'http',
    endpoint: 'http://localhost:9999/mcp',
    headers: {},
    secretRef: null,
    status: 'enabled',
    lastDiscoveredAt: new Date(),
    discoveredTools: [{ name: 'lookup_customer', description: 'Looks up a customer.' }],
    createdAt: new Date(),
    updatedAt: new Date(),
    source: 'manual',
    registryId: null,
    license: null,
    author: null,
    sourceUrl: null,
    ...overrides,
  };
}

function skill(frontmatter: Record<string, unknown>): SkillRow {
  return {
    id: SKILL_ID,
    slug: 'crm-helper',
    name: 'CRM Helper',
    frontmatter,
    body: 'You help with CRM lookups.',
  } as unknown as SkillRow;
}

function binding(overrides?: Partial<SkillToolBindingRow>): SkillToolBindingRow {
  return {
    skillId: SKILL_ID,
    contract: 'customer-lookup',
    mcpServerId: SERVER_ID,
    toolName: 'lookup_customer',
    boundBy: 'op@example.com',
    boundAt: new Date(),
    ...overrides,
  };
}

interface Recorded {
  tool: string;
  callerKind: string | undefined;
  callerId: string | undefined;
}

function makeDeps(
  recorded: Recorded[],
  extras?: Partial<HydrateDeps>,
): HydrateDeps {
  return {
    client: {} as unknown as AnthropicClient,
    nativeToolRegistry: { get: () => undefined } as unknown as NativeToolRegistry,
    mcpManager: {
      callTool: async (_cfg: unknown, toolName: string): Promise<string> => {
        // Read the ALS inside the call, exactly where the audit observer does.
        const { turnContext } = await import('@omadia/orchestrator');
        const ctx = turnContext.current();
        recorded.push({
          tool: toolName,
          callerKind: ctx?.mcpCallerKind,
          callerId: ctx?.mcpCallerId,
        });
        return 'ok';
      },
    } as unknown as McpManager,
    mcpServers: [server()],
    defaultModel: 'claude-sonnet-4-6',
    ...extras,
  };
}

function host(): {
  registered: Map<string, { handle: (i: unknown) => Promise<string> }>;
  orchestrator: { hasDomainTool(n: string): boolean; registerDomainTool(t: unknown): void };
} {
  const registered = new Map<string, { handle: (i: unknown) => Promise<string> }>();
  return {
    registered,
    orchestrator: {
      hasDomainTool: (n: string) => registered.has(n),
      registerDomainTool: (t: unknown) =>
        registered.set(
          (t as { name: string }).name,
          t as { handle: (i: unknown) => Promise<string> },
        ),
    },
  };
}

describe('parseRequiresTools', () => {
  it('parses valid contracts and drops malformed entries', () => {
    const parsed = parseRequiresTools({
      requires_tools: [
        { contract: 'customer-lookup', description: 'Find customers' },
        { contract: '' },
        'nonsense',
        { noContract: true },
        { contract: '  spaced  ' },
      ],
    });
    assert.deepEqual(
      parsed.map((c) => c.contract),
      ['customer-lookup', 'spaced'],
    );
  });

  it('returns empty for absent or non-array fields', () => {
    assert.deepEqual(parseRequiresTools({}), []);
    assert.deepEqual(parseRequiresTools({ requires_tools: 'yes' }), []);
  });
});

describe('skill capability bindings at hydration (#456)', () => {
  it('a bound contract materializes with skill attribution on calls', async () => {
    const recorded: Recorded[] = [];
    const h = host();
    const n = registerDbSubAgentTools(
      { subAgents: [], skills: [], toolGrants: [] },
      h,
      makeDeps(recorded, {
        personaSkills: [skill({ requires_tools: [{ contract: 'customer-lookup' }] })],
        skillToolBindings: [binding()],
      }),
    );
    assert.equal(n, 1);
    const tool = h.registered.get('mcp__crm__lookup_customer');
    assert.ok(tool);
    await tool.handle({ q: 'acme' });
    assert.equal(recorded[0]?.callerKind, 'skill');
    assert.equal(recorded[0]?.callerId, 'crm-helper');
  });

  it('an unbound contract fails closed (no tool, log line)', () => {
    const logs: string[] = [];
    const h = host();
    const n = registerDbSubAgentTools(
      { subAgents: [], skills: [], toolGrants: [] },
      h,
      makeDeps([], {
        personaSkills: [skill({ requires_tools: [{ contract: 'customer-lookup' }] })],
        skillToolBindings: [],
        log: (m) => logs.push(m),
      }),
    );
    assert.equal(n, 0);
    assert.ok(logs.some((m) => m.includes('unbound')));
  });

  it('a policy-blocked binding is skipped', () => {
    const h = host();
    const n = registerDbSubAgentTools(
      { subAgents: [], skills: [], toolGrants: [] },
      h,
      makeDeps([], {
        personaSkills: [skill({ requires_tools: [{ contract: 'customer-lookup' }] })],
        skillToolBindings: [binding()],
        blockedMcpGrant: () => true,
      }),
    );
    assert.equal(n, 0);
  });

  it('a binding to a disabled server is skipped', () => {
    const h = host();
    const deps = makeDeps([], {
      personaSkills: [skill({ requires_tools: [{ contract: 'customer-lookup' }] })],
      skillToolBindings: [binding()],
    });
    const n = registerDbSubAgentTools(
      { subAgents: [], skills: [], toolGrants: [] },
      h,
      { ...deps, mcpServers: [server({ status: 'disabled' })] },
    );
    assert.equal(n, 0);
  });
});
