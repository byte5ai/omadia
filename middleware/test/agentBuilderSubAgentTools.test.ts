/**
 * Agent Builder P2/P4 — sub-agent DomainTool builder + MCP adapters.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

import {
  mcpNativeToolName,
  mcpToolToNativeSpec,
  renderToolResult,
  splitCommand,
} from '../packages/harness-orchestrator/src/mcp/mcpClient.js';
import type {
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import {
  buildSubAgentDomainTools,
  mcpToolNameFromRef,
  subAgentToolName,
} from '../packages/harness-orchestrator/src/registry/subAgentTools.js';

const fakeClient = {} as unknown as Anthropic;

function sub(overrides: Partial<SubAgentRow> = {}): SubAgentRow {
  return {
    id: 'sub-1',
    parentAgentId: 'agent-1',
    name: 'Researcher Bot',
    skillId: 'skill-1',
    model: null,
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

function skill(): SkillRow {
  return {
    id: 'skill-1',
    slug: 'research',
    name: 'Research',
    description: null,
    body: 'You are a researcher.',
    frontmatter: {},
    source: 'db',
    sourcePath: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function nativeGrant(): ToolGrantRow {
  return {
    id: 'g-1',
    agentId: null,
    subAgentId: 'sub-1',
    toolKind: 'native',
    toolRef: 'web_search',
    mcpServerId: null,
    config: {},
    createdAt: new Date(0),
  };
}

const stubNativeTool: LocalSubAgentTool = {
  spec: {
    name: 'web_search',
    description: 'search',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  handle: async () => 'ok',
};

test('builds one DomainTool per enabled sub-agent with sanitised name+domain', () => {
  const tools = buildSubAgentDomainTools(
    { subAgents: [sub()], toolGrants: [nativeGrant()], skills: [skill()] },
    {
      client: fakeClient,
      defaultModel: 'claude-sonnet-4-6',
      defaultMaxTokens: 2048,
      defaultMaxIterations: 6,
      nativeTool: (ref) => (ref === 'web_search' ? stubNativeTool : undefined),
    },
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'ask_researcher_bot');
  assert.equal(tools[0]!.domain, 'subagent.researcher-bot');
});

test('disabled sub-agents are skipped', () => {
  const tools = buildSubAgentDomainTools(
    { subAgents: [sub({ status: 'disabled' })], toolGrants: [], skills: [] },
    { client: fakeClient, defaultModel: 'm', defaultMaxTokens: 1, defaultMaxIterations: 1 },
  );
  assert.equal(tools.length, 0);
});

test('subAgentToolName + mcpToolNameFromRef', () => {
  assert.equal(subAgentToolName('GTM Agent!!'), 'ask_gtm_agent');
  assert.equal(mcpToolNameFromRef('exa:web_search', 'exa'), 'web_search');
  assert.equal(mcpToolNameFromRef('web_search', 'exa'), 'web_search');
});

test('mcp adapters: native tool name + spec + result rendering + command split', () => {
  assert.equal(mcpNativeToolName('Exa Search', 'web.search'), 'mcp__Exa_Search__web_search');
  const spec = mcpToolToNativeSpec('exa', { name: 'search', description: 'd' });
  assert.equal(spec.name, 'mcp__exa__search');
  assert.equal(spec.input_schema.type, 'object');
  assert.equal(spec.domain, 'mcp.exa');

  assert.equal(
    renderToolResult({ content: [{ type: 'text', text: 'hello' }] }),
    'hello',
  );
  assert.equal(
    renderToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
    'Error: boom',
  );
  assert.deepEqual(splitCommand('npx -y @scope/mcp --flag "a b"'), [
    'npx',
    '-y',
    '@scope/mcp',
    '--flag',
    'a b',
  ]);
});
