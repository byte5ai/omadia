/**
 * #2050 — the envelope of an internal helper (DB sub-agent) is a subset of its
 * agent's (spec 2042 §5.6, §6 criterion 11):
 *
 *   - a helper run that calls a capability its agent lacks is refused, for
 *     native and for MCP tools, and revoking the AGENT's grant after the helper
 *     was materialised removes the helper's access on the next call;
 *   - a helper model the agent's policy does not allow is not run;
 *   - helper tool names are collision-free: a clash (with another helper or one
 *     of the agent's other tools) is refused for all members, never shadowed.
 *
 * The helper runs through the production factory `buildSubAgentDomainTools`
 * with the kernel's own subset check (`parentHoldsGrant`), on a scripted model.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  clearExternalModels,
  registerExternalModels,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
  type ModelInfo,
} from '@omadia/llm-provider';
import type { LocalSubAgentTool } from '@omadia/plugin-api';
import {
  buildSubAgentDomainTools,
  helperDefaultModelRef,
  helperModelVerdict,
  helperToolNameConflicts,
  type McpManager,
  type ToolGrantRow,
  type SubAgentRow,
} from '@omadia/orchestrator';

import {
  parentHoldsGrant,
  registerDbSubAgentTools,
  type LiveParentView,
} from '../src/agents/subAgentToolHydration.js';

const model = (id: string, cls: ModelInfo['class'], provider = 'anthropic'): ModelInfo => ({
  id: `${provider}:${id}`,
  provider,
  modelId: id,
  label: id,
  class: cls,
  maxTokens: 8192,
  contextWindow: 200000,
  vision: false,
  classDefault: true,
});
const HAIKU = model('claude-haiku-test', 'fast');
const SONNET = model('claude-sonnet-test', 'balanced');
const OPUS = model('claude-opus-test', 'frontier');
const GPT = model('gpt-test', 'fast', 'openai');

before(() => {
  clearExternalModels();
  registerExternalModels([HAIKU, SONNET, OPUS, GPT]);
});
after(() => clearExternalModels());

const CAPS = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;
const USAGE = { inputTokens: 1, outputTokens: 1 };

/**
 * A helper model that calls `toolName` once and then answers with the tool
 * result it read. Records every request.
 */
function toolCallingModel(toolName: string): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const provider = {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      requests.push(req);
      const first = requests.length === 1;
      const lastResult = JSON.stringify(req.messages.at(-1) ?? '');
      const response = first
        ? {
            content: [{ type: 'tool_call', id: 't1', name: toolName, input: {} }],
            finishReason: 'tool_calls',
            providerFinishReason: 'tool_use',
            model: req.model,
            usage: USAGE,
          }
        : {
            content: [{ type: 'text', text: `saw: ${lastResult}` }],
            finishReason: 'stop',
            providerFinishReason: 'end_turn',
            model: req.model,
            usage: USAGE,
          };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response } as unknown as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
  return { provider, requests };
}

function helperRow(overrides: Partial<SubAgentRow> = {}): SubAgentRow {
  return {
    id: 'helper-1',
    parentAgentId: 'agent-1',
    name: 'Researcher',
    skillId: null,
    model: HAIKU.id,
    maxTokens: null,
    maxIterations: null,
    systemPromptOverride: null,
    status: 'enabled',
    position: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function grant(overrides: Partial<ToolGrantRow>): ToolGrantRow {
  return {
    id: `g-${Math.random().toString(36).slice(2)}`,
    agentId: null,
    subAgentId: 'helper-1',
    toolKind: 'native',
    toolRef: 'crm_write',
    mcpServerId: null,
    config: {},
    createdAt: new Date(0),
    ...overrides,
  };
}

const SERVER_ID = 'srv-1';
const SERVER = { id: SERVER_ID, name: 'crm', transport: 'http' as const, endpoint: 'https://mcp.example' };

/** Mutable stand-in for the registry's live entry of the parent agent. */
function liveParent(initial: { grants: ToolGrantRow[]; natives: string[] }): {
  view: () => LiveParentView;
  set: (next: { grants?: ToolGrantRow[]; natives?: string[] }) => void;
} {
  let state = initial;
  return {
    view: () => ({
      toolGrants: state.grants,
      holdsNativeTool: (name: string) => state.natives.includes(name),
    }),
    set: (next) => {
      state = { grants: next.grants ?? state.grants, natives: next.natives ?? state.natives };
    },
  };
}

function buildHelper(args: {
  provider: LlmProvider;
  grants: ToolGrantRow[];
  parent: () => LiveParentView;
  nativeTool?: (ref: string) => LocalSubAgentTool | undefined;
  mcpManager?: McpManager;
}) {
  const logs: string[] = [];
  const tools = buildSubAgentDomainTools(
    { subAgents: [helperRow()], toolGrants: args.grants, skills: [] },
    {
      provider: args.provider,
      defaultModel: 'class:balanced',
      defaultMaxTokens: 1024,
      defaultMaxIterations: 4,
      ...(args.nativeTool ? { nativeTool: args.nativeTool } : {}),
      ...(args.mcpManager
        ? { mcpManager: args.mcpManager, mcpServersById: new Map([[SERVER_ID, SERVER]]) }
        : {}),
      // Exactly what `registerDbSubAgentTools` wires in the kernel.
      parentHolds: (g) => parentHoldsGrant(args.parent(), g, g.mcpServerId ? SERVER.name : undefined),
      log: (m) => logs.push(m),
    },
  );
  assert.equal(tools.length, 1, 'the helper itself is built');
  return { tool: tools[0]!, logs };
}

const offeredTools = (req: LlmRequest | undefined): string[] => (req?.tools ?? []).map((t) => t.name);

describe('#2050 §6.11 — a helper never exceeds its agent (native tools)', () => {
  function crmWrite(calls: { n: number }): LocalSubAgentTool {
    return {
      spec: { name: 'crm_write', description: 'write', input_schema: { type: 'object', properties: {}, required: [] } },
      handle: async () => {
        calls.n += 1;
        return 'written';
      },
    };
  }

  it('a native grant the agent lacks is not materialised, and a call to it does not run', async () => {
    const calls = { n: 0 };
    const model = toolCallingModel('crm_write');
    const parent = liveParent({ grants: [], natives: [] });
    const { tool, logs } = buildHelper({
      provider: model.provider,
      grants: [grant({})],
      parent: parent.view,
      nativeTool: () => crmWrite(calls),
    });
    await tool.handle({ question: 'write it' });
    assert.deepEqual(offeredTools(model.requests[0]), [], 'the helper is not offered the tool');
    assert.equal(calls.n, 0, 'the capability never ran');
    assert.ok(logs.some((l) => /native grant "crm_write" refused — the agent itself does not hold it/.test(l)));
  });

  it('revoking the agent grant after materialisation refuses the next helper call', async () => {
    const calls = { n: 0 };
    const model = toolCallingModel('crm_write');
    const parent = liveParent({ grants: [], natives: ['crm_write'] });
    const { tool } = buildHelper({
      provider: model.provider,
      grants: [grant({})],
      parent: parent.view,
      nativeTool: () => crmWrite(calls),
    });
    parent.set({ natives: [] }); // the operator takes the tool away from the agent
    const answer = await tool.handle({ question: 'write it' });
    assert.deepEqual(offeredTools(model.requests[0]), ['crm_write'], 'it was materialised while held');
    assert.equal(calls.n, 0, 'the revoked capability never ran');
    assert.match(answer, /not available: the agent this helper works for does not hold it/);
  });

  it('while the agent holds the tool the helper uses it', async () => {
    const calls = { n: 0 };
    const model = toolCallingModel('crm_write');
    const parent = liveParent({ grants: [], natives: ['crm_write'] });
    const { tool } = buildHelper({
      provider: model.provider,
      grants: [grant({})],
      parent: parent.view,
      nativeTool: () => crmWrite(calls),
    });
    await tool.handle({ question: 'write it' });
    assert.equal(calls.n, 1);
  });
});

describe('#2050 §6.11 — a helper never exceeds its agent (MCP tools)', () => {
  const MCP_TOOL = 'mcp__crm__search';
  function manager(calls: { n: number }): McpManager {
    return {
      rememberToolSchema: () => undefined,
      callTool: async () => {
        calls.n += 1;
        return 'crm rows';
      },
    } as unknown as McpManager;
  }
  const helperMcpGrant = grant({ toolKind: 'mcp', toolRef: 'search', mcpServerId: SERVER_ID });
  const agentMcpGrant = grant({
    agentId: 'agent-1',
    subAgentId: null,
    toolKind: 'mcp',
    toolRef: 'search',
    mcpServerId: SERVER_ID,
  });

  it('an MCP grant held only by the helper is not materialised and never called', async () => {
    const calls = { n: 0 };
    const model = toolCallingModel(MCP_TOOL);
    const parent = liveParent({ grants: [], natives: [] });
    const { tool, logs } = buildHelper({
      provider: model.provider,
      grants: [helperMcpGrant],
      parent: parent.view,
      mcpManager: manager(calls),
    });
    await tool.handle({ question: 'search' });
    assert.deepEqual(offeredTools(model.requests[0]), []);
    assert.equal(calls.n, 0);
    assert.ok(logs.some((l) => /mcp grant "search" refused/.test(l)));
  });

  it('revoking the agent MCP grant after materialisation refuses the next helper call', async () => {
    const calls = { n: 0 };
    const model = toolCallingModel(MCP_TOOL);
    const parent = liveParent({ grants: [agentMcpGrant], natives: [] });
    const { tool } = buildHelper({
      provider: model.provider,
      grants: [helperMcpGrant, agentMcpGrant],
      parent: parent.view,
      mcpManager: manager(calls),
    });
    parent.set({ grants: [] }); // agent-level grant revoked; the helper's row still exists
    const answer = await tool.handle({ question: 'search' });
    assert.deepEqual(offeredTools(model.requests[0]), [MCP_TOOL], 'it was materialised while held');
    assert.equal(calls.n, 0, 'the MCP server was never called');
    assert.match(answer, /not available/);
  });

  it('while the agent holds the MCP tool the helper uses it', async () => {
    const calls = { n: 0 };
    const model = toolCallingModel(MCP_TOOL);
    const parent = liveParent({ grants: [agentMcpGrant], natives: [] });
    const { tool } = buildHelper({
      provider: model.provider,
      grants: [helperMcpGrant, agentMcpGrant],
      parent: parent.view,
      mcpManager: manager(calls),
    });
    await tool.handle({ question: 'search' });
    assert.equal(calls.n, 1);
  });

  it('without a live check the snapshot rule still refuses an MCP grant the agent lacks', () => {
    const logs: string[] = [];
    buildSubAgentDomainTools(
      { subAgents: [helperRow()], toolGrants: [helperMcpGrant], skills: [] },
      {
        provider: toolCallingModel(MCP_TOOL).provider,
        defaultModel: 'class:balanced',
        defaultMaxTokens: 1,
        defaultMaxIterations: 1,
        mcpManager: manager({ n: 0 }),
        mcpServersById: new Map([[SERVER_ID, SERVER]]),
        log: (m) => logs.push(m),
      },
    );
    assert.ok(logs.some((l) => /mcp grant "search" refused/.test(l)));
  });

  it('parentHoldsGrant: no live parent (agent gone) refuses everything', () => {
    assert.equal(parentHoldsGrant(undefined, grant({})), false);
    assert.equal(parentHoldsGrant(undefined, helperMcpGrant, 'crm'), false);
  });
});

describe('#2050 — the helper model must fit the agent model policy', () => {
  const pinnedSonnet = {
    primary: { provider: 'anthropic', model: SONNET.modelId },
    fallback: 'none' as const,
  };

  it('same or cheaper class on the agent provider is allowed; stronger or foreign is not', () => {
    assert.equal(helperModelVerdict(HAIKU.id, pinnedSonnet, 'anthropic').allowed, true);
    assert.equal(helperModelVerdict(SONNET.id, pinnedSonnet, 'anthropic').allowed, true);
    assert.equal(helperModelVerdict(OPUS.id, pinnedSonnet, 'anthropic').allowed, false);
    assert.equal(helperModelVerdict(GPT.id, pinnedSonnet, 'anthropic').allowed, false);
    assert.equal(helperModelVerdict(null, pinnedSonnet, 'anthropic').allowed, true, 'inherit');
    assert.equal(
      helperModelVerdict(OPUS.id, { primary: 'auto', fallback: 'none' }, 'anthropic').allowed,
      true,
      'an `auto` policy allows any model the host serves',
    );
  });

  it('a helper whose model the policy does not allow is not run', () => {
    const logs: string[] = [];
    const tools = buildSubAgentDomainTools(
      { subAgents: [helperRow({ model: OPUS.id })], toolGrants: [], skills: [] },
      {
        provider: toolCallingModel('x').provider,
        defaultModel: 'class:balanced',
        defaultMaxTokens: 1,
        defaultMaxIterations: 1,
        parentModelPolicy: pinnedSonnet,
        log: (m) => logs.push(m),
      },
    );
    assert.equal(tools.length, 0);
    assert.ok(logs.some((l) => /helper "Researcher" refused — .*stronger than the agent's own balanced model/.test(l)));
  });

  it('a helper without its own model never inherits a model stronger than the agent', () => {
    const pinnedHaiku = { primary: { provider: 'anthropic', model: HAIKU.modelId }, fallback: 'none' as const };
    assert.equal(helperDefaultModelRef('class:balanced', pinnedHaiku, 'anthropic'), HAIKU.id);
    assert.equal(helperDefaultModelRef('class:balanced', pinnedSonnet, 'anthropic'), 'class:balanced');
    assert.equal(
      helperDefaultModelRef('class:balanced', { primary: 'auto', fallback: 'none' }, 'anthropic'),
      'class:balanced',
    );
  });
});

describe('#2050 — helper tool names are collision-free (runtime)', () => {
  it('helpers whose names map to the same tool are all refused, in any order', () => {
    const a = helperRow({ id: 'h-a', name: 'A B' });
    const b = helperRow({ id: 'h-b', name: 'A-B' });
    for (const order of [[a, b], [b, a]]) {
      const logs: string[] = [];
      const tools = buildSubAgentDomainTools(
        { subAgents: order, toolGrants: [], skills: [] },
        {
          provider: toolCallingModel('x').provider,
          defaultModel: HAIKU.id,
          defaultMaxTokens: 1,
          defaultMaxIterations: 1,
          log: (m) => logs.push(m),
        },
      );
      assert.equal(tools.length, 0, 'no first-wins shadowing');
      assert.equal(logs.filter((l) => /collides with another helper/.test(l)).length, 2);
    }
    assert.deepEqual(
      helperToolNameConflicts([a, b], new Set()).map((c) => c.toolName),
      ['ask_a_b', 'ask_a_b'],
    );
  });

  it("a helper that would shadow one of the agent's other tools is refused, the others still register", () => {
    const registered: { name: string }[] = [];
    const logs: string[] = [];
    const built = {
      orchestrator: {
        hasDomainTool: (name: string) => registered.some((t) => t.name === name),
        registerDomainTool: (tool: { name: string }) => {
          registered.push(tool);
        },
        listDomainTools: () => [{ name: 'ask_crm' }],
        listNativeToolNames: () => ['ask_user_choice'],
        holdsNativeTool: () => true,
      },
    };
    const n = registerDbSubAgentTools(
      {
        subAgents: [
          helperRow({ id: 'h-1', name: 'User Choice' }),
          helperRow({ id: 'h-2', name: 'CRM' }),
          helperRow({ id: 'h-3', name: 'Writer' }),
        ],
        toolGrants: [],
        skills: [],
      },
      built,
      {
        client: {} as Parameters<typeof registerDbSubAgentTools>[2]['client'],
        nativeToolRegistry: { get: () => undefined } as unknown as Parameters<
          typeof registerDbSubAgentTools
        >[2]['nativeToolRegistry'],
        mcpManager: {} as McpManager,
        mcpServers: [],
        defaultModel: HAIKU.id,
        log: (m) => logs.push(m),
      },
    );
    assert.equal(n, 1);
    assert.deepEqual(
      registered.map((t) => t.name),
      ['ask_writer'],
    );
    assert.equal(logs.filter((l) => /collides with another tool of this agent/.test(l)).length, 2);
  });
});
