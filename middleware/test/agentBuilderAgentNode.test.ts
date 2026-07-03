/**
 * Route surface — `agentNode()` shape on `GET /agents/:slug/graph` (and
 * the `setModelRouting` response). Issue #296 acceptance #4: the registry's
 * resolved orchestrator model must be reachable from the Admin UI without
 * a kernel-side restart.
 *
 * `agentNode` is the route helper that builds the `agent` node payload from
 * an `AgentRow` and the live registry. Tested directly so we don't need to
 * spin up express or a real Postgres pool.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AgentRow,
  BuiltOrchestrator,
  OrchestratorRegistry,
} from '@omadia/orchestrator';

import { agentNode } from '../src/routes/agentBuilder.js';

const AGENT_ID = '00000000-0000-0000-0000-000000000001';

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    slug: 'public',
    name: 'Public',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** Minimal `OrchestratorRegistry` stub — `agentNode` only calls `.get(slug)`. */
function fakeRegistry(
  slug: string,
  built: Partial<BuiltOrchestrator>,
): OrchestratorRegistry {
  return {
    get: (s: string) => (s === slug ? { built } : undefined),
  } as unknown as OrchestratorRegistry;
}

test('effectiveModel is null when no registry is available (in-memory boot / disabled agent)', () => {
  const node = agentNode(agentRow(), undefined);
  assert.equal(node.effectiveModel, null);
  assert.equal(node.slug, 'public');
  assert.equal(node.modelRouting, null);
});

test('effectiveModel is null when the registry has no built entry for the agent', () => {
  // E.g. the agent is disabled, or hot-reload has not finished — the registry
  // is published but `.get(slug)` returns undefined. The UI then shows just
  // the persisted `modelRouting.main` hint, not a stale "Active: X" badge.
  const reg = fakeRegistry('some-other-slug', { effectiveModel: 'haiku' });
  const node = agentNode(agentRow(), reg);
  assert.equal(node.effectiveModel, null);
});

test('effectiveModel mirrors the registry-resolved model id (per-agent overlay applied)', () => {
  const reg = fakeRegistry('public', { effectiveModel: 'claude-opus-4-8' });
  const node = agentNode(agentRow(), reg);
  assert.equal(node.effectiveModel, 'claude-opus-4-8');
});

test('persisted modelRouting passes through verbatim alongside effectiveModel', () => {
  // setModelRouting -> agentNode echoes the persisted JSON so the Inspector
  // hydrates form state from the response without a second GET.
  const reg = fakeRegistry('public', { effectiveModel: 'claude-haiku-4-5' });
  const node = agentNode(
    agentRow({
      modelRouting: { mode: 'triage', main: 'claude-opus-4-8', triage: 'claude-haiku-4-5' },
    }),
    reg,
  );
  assert.deepEqual(node.modelRouting, {
    mode: 'triage',
    main: 'claude-opus-4-8',
    triage: 'claude-haiku-4-5',
  });
  assert.equal(node.effectiveModel, 'claude-haiku-4-5');
});
