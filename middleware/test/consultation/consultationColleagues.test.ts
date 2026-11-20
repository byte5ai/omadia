/**
 * #2047 / #2056 — the colleagues an agent may consult are named in its prompt
 * (`consultableColleagues`), read from the registry snapshot: a changed
 * grant, switch or colleague name rebuilds the agent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffSnapshots } from '../../packages/harness-orchestrator/src/registry/applyDiff.js';
import type { AgentRow, ConfigSnapshot } from '../../packages/harness-orchestrator/src/registry/configStore.js';
import { consultableColleaguesOf } from '../../packages/harness-orchestrator/src/registry/consultationColleagues.js';
import { identityRules } from '../../packages/harness-orchestrator/src/management/agentIdentityPrompt.js';

const ANNA = '00000000-0000-0000-0000-000000000001';
const BEN = '00000000-0000-0000-0000-000000000002';
const FAC = '00000000-0000-0000-0000-000000000003';
const OFF = '00000000-0000-0000-0000-000000000004';

function agent(id: string, slug: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    slug,
    name: slug,
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
    agents: [
      agent(ANNA, 'anna'),
      agent(BEN, 'ben', { identityName: 'Ben Sales' }),
      agent(FAC, 'fac', { archetype: 'facilitator' }),
      agent(OFF, 'off', { status: 'disabled' }),
    ],
    agentPlugins: [],
    channelBindings: [],
    ...overrides,
  };
}

describe('consultable colleagues', () => {
  it('names the active pairs by display name; no facilitator, no disabled agent, no reverse direction', () => {
    const s = snap({
      consultationPairs: [
        { fromAgentId: ANNA, toAgentId: BEN },
        { fromAgentId: ANNA, toAgentId: FAC },
        { fromAgentId: ANNA, toAgentId: OFF },
      ],
    });
    assert.deepEqual(consultableColleaguesOf(ANNA, s), ['Ben Sales']);
    assert.deepEqual(consultableColleaguesOf(BEN, s), []);
    assert.match(identityRules(consultableColleaguesOf(ANNA, s)), /Ben Sales/);
  });

  it('a new grant, a revoked one and a renamed colleague rebuild the agent', () => {
    const before = snap();
    const granted = snap({ consultationPairs: [{ fromAgentId: ANNA, toAgentId: BEN }] });
    const rebuilt = (plan: ReturnType<typeof diffSnapshots>, slug: string) =>
      plan.actions.find((a) => a.kind === 'rebuild' && a.agent.slug === slug);

    const grant = diffSnapshots(before, granted);
    assert.match((rebuilt(grant, 'anna') as { reason: string } | undefined)?.reason ?? '', /consultation_colleagues/);
    assert.equal(rebuilt(grant, 'ben'), undefined, 'the consulted agent names nobody new');

    assert.ok(rebuilt(diffSnapshots(granted, before), 'anna'), 'a revoke rebuilds too');

    const renamed = snap({
      agents: [agent(ANNA, 'anna'), agent(BEN, 'ben', { identityName: 'Ben Vertrieb' }), agent(FAC, 'fac', { archetype: 'facilitator' }), agent(OFF, 'off', { status: 'disabled' })],
      consultationPairs: [{ fromAgentId: ANNA, toAgentId: BEN }],
    });
    assert.ok(rebuilt(diffSnapshots(granted, renamed), 'anna'));
  });
});
