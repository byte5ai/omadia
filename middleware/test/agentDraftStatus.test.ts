/**
 * #2049 (spec 2042 §5.10) — a preview runs as a `draft` agent, which is never
 * addressable: the registry builds only `enabled` agents, so a draft has no
 * runtime presence until an operator enables it. Routing (stream S1) treats
 * every status except `enabled` as not addressable; this pins the registry
 * half, which holds on its own.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffSnapshots } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type { AgentRow, ConfigSnapshot } from '../packages/harness-orchestrator/src/registry/configStore.js';

const ID = '00000000-0000-0000-0000-0000000000d1';

function agent(status: AgentRow['status']): AgentRow {
  return {
    id: ID,
    slug: 'strategist',
    name: 'Strategist',
    description: null,
    privacyProfile: 'default',
    status,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function snapshot(a: AgentRow | undefined): ConfigSnapshot {
  return {
    agents: a ? [a] : [],
    agentPlugins: [],
    channelBindings: [],
  };
}

test('#2049: a draft agent is never built into the registry', () => {
  assert.deepEqual(diffSnapshots(undefined, snapshot(agent('draft'))).actions, []);
  assert.deepEqual(diffSnapshots(snapshot(undefined), snapshot(agent('draft'))).actions, []);
});

test('#2049: enabling a draft builds it; nothing else does', () => {
  const enabled = diffSnapshots(snapshot(agent('draft')), snapshot(agent('enabled'))).actions;
  assert.deepEqual(enabled.map((a) => a.kind), ['add']);
  assert.deepEqual(diffSnapshots(snapshot(agent('draft')), snapshot(agent('disabled'))).actions, []);
});
