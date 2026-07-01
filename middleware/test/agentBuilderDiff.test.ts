/**
 * Agent Builder P0 — diffSnapshots graph-awareness.
 *
 * Verifies that `diffSnapshots` treats the new editable-graph collections
 * (sub-agents, tool grants, referenced-skill bodies, model routing) as
 * runtime-relevant — a change rebuilds the owning agent — while schedules,
 * consumed by the cron worker rather than the orchestrator build, produce no
 * orchestrator action.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ScheduleRow,
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import { diffSnapshots } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type {
  AgentRow,
  ConfigSnapshot,
} from '../packages/harness-orchestrator/src/registry/configStore.js';

const AGENT_ID = '00000000-0000-0000-0000-000000000001';
const SKILL_ID = '00000000-0000-0000-0000-0000000000a1';
const SUB_ID = '00000000-0000-0000-0000-0000000000b1';

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    slug: 'public',
    name: 'public',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function snap(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    agents: [agent()],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
    subAgents: [],
    toolGrants: [],
    schedules: [],
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

function subAgent(overrides: Partial<SubAgentRow> = {}): SubAgentRow {
  return {
    id: SUB_ID,
    parentAgentId: AGENT_ID,
    name: 'researcher',
    skillId: null,
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

function skill(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: SKILL_ID,
    slug: 'research',
    name: 'Research',
    description: null,
    body: 'You research things.',
    frontmatter: {},
    source: 'db',
    sourcePath: null,
    contentHash: null,
    forkedFrom: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function grant(overrides: Partial<ToolGrantRow> = {}): ToolGrantRow {
  return {
    id: '00000000-0000-0000-0000-0000000000c1',
    agentId: AGENT_ID,
    subAgentId: null,
    toolKind: 'native',
    toolRef: 'web_search',
    mcpServerId: null,
    config: {},
    createdAt: new Date(0),
    ...overrides,
  };
}

function onlyRebuild(plan: ReturnType<typeof diffSnapshots>) {
  assert.equal(plan.actions.length, 1, 'exactly one action');
  const [action] = plan.actions;
  assert.equal(action!.kind, 'rebuild');
  return action as { kind: 'rebuild'; reason: string };
}

test('adding a sub-agent rebuilds the owning agent (reason: graph)', () => {
  const before = snap();
  const after = snap({ subAgents: [subAgent()] });
  const reason = onlyRebuild(diffSnapshots(before, after)).reason;
  assert.match(reason, /graph/);
});

test('editing a referenced skill body rebuilds the agent', () => {
  const base = {
    subAgents: [subAgent({ skillId: SKILL_ID })],
    skills: [skill()],
  };
  const before = snap(base);
  const after = snap({
    subAgents: [subAgent({ skillId: SKILL_ID })],
    skills: [skill({ body: 'You research things, deeply.' })],
  });
  assert.match(onlyRebuild(diffSnapshots(before, after)).reason, /graph/);
});

test('an unrelated skill edit does NOT rebuild the agent', () => {
  const before = snap({ skills: [skill()] });
  const after = snap({ skills: [skill({ body: 'changed' })] });
  // No sub-agent references this skill → no graph change for the agent.
  assert.equal(diffSnapshots(before, after).actions.length, 0);
});

test('granting a tool to a sub-agent rebuilds the agent', () => {
  const before = snap({ subAgents: [subAgent()] });
  const after = snap({
    subAgents: [subAgent()],
    toolGrants: [grant({ agentId: null, subAgentId: SUB_ID })],
  });
  assert.match(onlyRebuild(diffSnapshots(before, after)).reason, /graph/);
});

test('changing model_routing rebuilds the agent (reason: model_routing)', () => {
  const before = snap();
  const after = snap({
    agents: [agent({ modelRouting: { mode: 'triage', main: 'opus' } })],
  });
  assert.match(onlyRebuild(diffSnapshots(before, after)).reason, /model_routing/);
});

test('adding a schedule produces NO orchestrator action', () => {
  const before = snap();
  const after = snap({
    schedules: [
      {
        id: '00000000-0000-0000-0000-0000000000d1',
        agentId: AGENT_ID,
        cron: '0 9 * * *',
        payload: {},
        timezone: 'UTC',
        status: 'enabled',
        lastRunAt: null,
        createdAt: new Date(0),
      } satisfies ScheduleRow,
    ],
  });
  assert.equal(diffSnapshots(before, after).actions.length, 0);
});

test('idempotent: identical graph-populated snapshot yields zero actions', () => {
  const populated = snap({
    subAgents: [subAgent({ skillId: SKILL_ID })],
    skills: [skill()],
    toolGrants: [grant()],
  });
  assert.equal(diffSnapshots(populated, populated).actions.length, 0);
});
