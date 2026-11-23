import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ManagementRouter,
  setRoleMembership,
  type RouteOutcome,
} from '../packages/harness-orchestrator/src/routing/managementRouter.js';
import { SnapshotRoutingView } from '../packages/harness-orchestrator/src/registry/routingView.js';
import type {
  AgentRow,
  ConfigSnapshot,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import type { DefaultAgentEntryRow } from '../packages/harness-orchestrator/src/registry/routingTables.js';

/**
 * #2055 / #1880 — the management layer routes deterministically and never
 * lets another agent answer in the named one's place. Spec 2042 §6 criteria
 * 7, 8, 14, 36, 39, 40 at the routing level; the HTTP and channel paths that
 * turn a notice into a `system` message are covered in their own tests.
 */

const NOW = new Date('2026-11-20T00:00:00Z');

function agent(slug: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName: slug.charAt(0).toUpperCase() + slug.slice(1),
    availableToEveryone: true,
    availableChannels: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function entry(
  principal: string | null,
  channelType: string | null,
  agentId: string | null,
): DefaultAgentEntryRow {
  return {
    id: `entry-${principal ?? '*'}-${channelType ?? '*'}`,
    principal,
    channelType,
    agentId,
    updatedBy: null,
    updatedAt: NOW,
  };
}

function snapshot(parts: Partial<ConfigSnapshot>): ConfigSnapshot {
  return {
    agents: [],
    agentPlugins: [],
    channelBindings: [],
    ...parts,
  };
}

function route(snap: ConfigSnapshot, request: Parameters<ManagementRouter['route']>[0]): RouteOutcome {
  return new ManagementRouter({ view: new SnapshotRoutingView(snap) }).route(request);
}

function agentOf(outcome: RouteOutcome): string | undefined {
  return outcome.kind === 'agent' ? outcome.slug : undefined;
}

function noticeOf(outcome: RouteOutcome): string | undefined {
  return outcome.kind === 'notice' ? outcome.code : undefined;
}

const anna = 'user:anna@example.com';
const ben = 'user:ben@example.com';

describe('management router — fail loud (criterion 7, #1880)', () => {
  it('a binding to a disabled agent gives a notice naming it, never another agent', () => {
    const mira = agent('mira', { status: 'disabled' });
    const outcome = route(
      snapshot({
        agents: [mira, agent('default')],
        channelBindings: [{ channelType: 'api', channelKey: 'key:1', agentId: mira.id, createdAt: NOW }],
        defaultEntries: [entry(null, null, 'id-default')],
      }),
      { channelType: 'api', channelKey: 'key:1' },
    );
    assert.equal(noticeOf(outcome), 'agent_disabled');
    assert.equal(outcome.kind === 'notice' && outcome.agent?.displayName, 'Mira');
  });

  it('every status other than enabled is not addressable, a future `draft` too', () => {
    for (const status of ['disabled', 'draft', 'archived']) {
      const draft = agent('preview', { status: status as AgentRow['status'] });
      const outcome = route(snapshot({ agents: [draft, agent('default')], defaultEntries: [entry(null, null, 'id-default')] }), {
        channelType: 'web',
        channelKey: 'session:1',
        explicitSlug: 'preview',
      });
      assert.equal(noticeOf(outcome), 'agent_disabled', status);
    }
  });

  it('an agent that is enabled but whose provisioned bot is the key answers exclusively', () => {
    const mira = agent('mira');
    const outcome = route(
      snapshot({ agents: [mira], channelIdentities: [{ channelType: 'teams', channelKey: '28:app', agentId: mira.id }] }),
      { channelType: 'teams', channelKey: '28:app' },
    );
    assert.equal(agentOf(outcome), 'mira');
    assert.equal(outcome.kind === 'agent' && outcome.exclusive, true);
  });

  it("a provisioned bot whose agent is disabled is refused with the agent's name", () => {
    const mira = agent('mira', { status: 'disabled' });
    const outcome = route(
      snapshot({
        agents: [mira, agent('default')],
        channelIdentities: [{ channelType: 'teams', channelKey: '28:app', agentId: mira.id }],
        defaultEntries: [entry(null, null, 'id-default')],
      }),
      { channelType: 'teams', channelKey: '28:app' },
    );
    assert.equal(noticeOf(outcome), 'agent_disabled');
  });
});

describe('management router — no foreign agent (criterion 8)', () => {
  it('an unaddressed message with the instance entry off gets the no_agent notice', () => {
    const outcome = route(snapshot({ agents: [agent('mira')], defaultEntries: [entry(null, null, null)] }), {
      channelType: 'web',
      channelKey: 'session:1',
      principal: anna,
    });
    assert.equal(noticeOf(outcome), 'no_agent');
  });

  it('with no default-agent entry at all, nothing answers either', () => {
    const outcome = route(snapshot({ agents: [agent('mira')] }), { channelType: 'web', channelKey: 'session:1' });
    assert.equal(noticeOf(outcome), 'no_agent');
  });

  it('an explicit address to an unknown agent is refused, not rerouted', () => {
    const outcome = route(
      snapshot({ agents: [agent('mira')], defaultEntries: [entry(null, null, 'id-mira')] }),
      { channelType: 'web', channelKey: 'session:1', explicitSlug: 'strategist' },
    );
    assert.equal(noticeOf(outcome), 'agent_unknown');
  });
});

describe('management router — default-agent table (criterion 14)', () => {
  const snap = snapshot({
    agents: [agent('m'), agent('n')],
    defaultEntries: [entry(anna, 'teams', 'id-m'), entry(null, 'teams', 'id-n'), entry(null, null, null)],
  });

  it("U's unaddressed Teams message goes to M", () => {
    assert.equal(agentOf(route(snap, { channelType: 'teams', channelKey: 'conv', principal: anna })), 'm');
  });

  it("another user's goes to N", () => {
    assert.equal(agentOf(route(snap, { channelType: 'teams', channelKey: 'conv', principal: ben })), 'n');
  });

  it('an unaddressed web message gets the notice', () => {
    assert.equal(noticeOf(route(snap, { channelType: 'web', channelKey: 'session:1', principal: anna })), 'no_agent');
  });

  it('the user entry wins over the channel entry, and an `off` entry wins too', () => {
    const offForAnna = snapshot({
      agents: [agent('n')],
      defaultEntries: [entry(anna, null, null), entry(null, 'teams', 'id-n')],
    });
    assert.equal(noticeOf(route(offForAnna, { channelType: 'teams', channelKey: 'c', principal: anna })), 'no_agent');
    assert.equal(agentOf(route(offForAnna, { channelType: 'teams', channelKey: 'c', principal: ben })), 'n');
  });
});

describe('management router — selection vs binding (criterion 36)', () => {
  const snap = snapshot({
    agents: [agent('a'), agent('b'), agent('c')],
    channelBindings: [{ channelType: 'telegram', channelKey: 'group', agentId: 'id-a', createdAt: NOW }],
    selections: [
      { channelType: 'telegram', conversationKey: 'group', principal: anna, agentId: 'id-b', selectedAt: NOW },
      { channelType: 'telegram', conversationKey: 'group', principal: ben, agentId: 'id-c', selectedAt: NOW },
    ],
  });

  it("U's messages reach B, V's reach C, everyone else's reach A — also from a fresh view (restart)", () => {
    for (const view of [snap, structuredClone(snap)]) {
      assert.equal(agentOf(route(view, { channelType: 'telegram', channelKey: 'group', principal: anna })), 'b');
      assert.equal(agentOf(route(view, { channelType: 'telegram', channelKey: 'group', principal: ben })), 'c');
      assert.equal(
        agentOf(route(view, { channelType: 'telegram', channelKey: 'group', principal: 'user:carla@example.com' })),
        'a',
      );
    }
  });

  it('an explicit address wins over the binding', () => {
    assert.equal(
      agentOf(route(snap, { channelType: 'telegram', channelKey: 'group', principal: anna, explicitSlug: 'c' })),
      'c',
    );
  });
});

describe('management router — deleted agent stays named (criterion 39)', () => {
  const tombstone = {
    id: 'id-a',
    slug: 'a',
    name: 'Anton',
    archetype: 'standard',
    deletedAt: NOW.toISOString(),
    deletedBy: null,
  };
  const snap = snapshot({
    agents: [agent('b')],
    tombstones: [tombstone],
    channelBindings: [{ channelType: 'teams', channelKey: 'conv', agentId: 'id-a', createdAt: NOW }],
    selections: [{ channelType: 'slack', conversationKey: 'dm', principal: anna, agentId: 'id-a', selectedAt: NOW }],
    defaultEntries: [entry(anna, null, 'id-b')],
  });

  it('the binding to the deleted agent gives "Anton was deleted", B gets no turn', () => {
    const outcome = route(snap, { channelType: 'teams', channelKey: 'conv', principal: anna });
    assert.equal(noticeOf(outcome), 'agent_deleted');
    assert.equal(outcome.kind === 'notice' && outcome.agent?.displayName, 'Anton');
  });

  it('the same for a selection', () => {
    assert.equal(noticeOf(route(snap, { channelType: 'slack', channelKey: 'dm', principal: anna })), 'agent_deleted');
  });

  it('after the target is changed, routing follows it', () => {
    const changed = { ...snap, selections: [], channelBindings: [] };
    assert.equal(agentOf(route(changed, { channelType: 'teams', channelKey: 'conv', principal: anna })), 'b');
  });
});

describe('management router — availability (criterion 40)', () => {
  const a = agent('a', { availableToEveryone: false, availableChannels: ['teams'] });
  const snap = snapshot({
    agents: [a, agent('fallback-like')],
    availabilityPrincipals: [{ agentId: a.id, principal: anna }],
    defaultEntries: [entry(null, null, 'id-fallback-like')],
  });

  it('Ben addressing A in Teams gets the notice naming A, no other agent answers', () => {
    const outcome = route(snap, { channelType: 'teams', channelKey: 'c', principal: ben, explicitSlug: 'a' });
    assert.equal(noticeOf(outcome), 'agent_not_available');
    assert.equal(outcome.kind === 'notice' && outcome.agent?.slug, 'a');
  });

  it('criterion 40: Anna addressing A in Slack gets the notice naming A, no other agent answers', () => {
    const outcome = route(snap, { channelType: 'slack', channelKey: 'c', principal: anna, explicitSlug: 'a' });
    assert.equal(noticeOf(outcome), 'agent_not_available');
    assert.equal(outcome.kind === 'notice' && outcome.agent?.slug, 'a');
    assert.equal(outcome.kind === 'notice' && outcome.agent?.displayName, 'A');
  });

  it("Anna in Teams gets A's answer", () => {
    assert.equal(agentOf(route(snap, { channelType: 'teams', channelKey: 'c', principal: anna, explicitSlug: 'a' })), 'a');
  });

  it('a fresh agent is available to nobody', () => {
    const fresh = agent('fresh', { availableToEveryone: false });
    const outcome = route(snapshot({ agents: [fresh] }), {
      channelType: 'web',
      channelKey: 's',
      principal: anna,
      explicitSlug: 'fresh',
    });
    assert.equal(noticeOf(outcome), 'agent_not_available');
  });

  it('a group (role) grants availability through the membership seam', () => {
    const grouped = agent('g', { availableToEveryone: false });
    const view = new SnapshotRoutingView(
      snapshot({ agents: [grouped], availabilityPrincipals: [{ agentId: grouped.id, principal: 'role:sales' }] }),
    );
    const router = new ManagementRouter({ view, hasRole: (p, role) => p === anna && role === 'sales' });
    assert.equal(agentOf(router.route({ channelType: 'web', channelKey: 's', principal: anna, explicitSlug: 'g' })), 'g');
    assert.equal(
      noticeOf(router.route({ channelType: 'web', channelKey: 's', principal: ben, explicitSlug: 'g' })),
      'agent_not_available',
    );
  });
});

describe('management router — installed role membership', () => {
  it('a router without its own hasRole asks the membership the kernel installed; none installed admits nobody', () => {
    const grouped = agent('g', { availableToEveryone: false });
    const view = new SnapshotRoutingView(
      snapshot({ agents: [grouped], availabilityPrincipals: [{ agentId: grouped.id, principal: 'role:sales' }] }),
    );
    const router = new ManagementRouter({ view });
    const request = { channelType: 'web', channelKey: 's', principal: anna, explicitSlug: 'g' };
    assert.equal(noticeOf(router.route(request)), 'agent_not_available');
    setRoleMembership((p, role) => p === anna && role === 'sales');
    try {
      assert.equal(agentOf(router.route(request)), 'g');
    } finally {
      setRoleMembership(undefined);
    }
    assert.equal(noticeOf(router.route(request)), 'agent_not_available');
  });
});

describe('management router — facilitator', () => {
  it('a facilitator is never reached through a binding or as a default agent', () => {
    const fac = agent('fac', { archetype: 'facilitator' });
    const snap = snapshot({
      agents: [fac],
      channelBindings: [{ channelType: 'teams', channelKey: 'conv', agentId: fac.id, createdAt: NOW }],
      defaultEntries: [entry(null, null, fac.id)],
    });
    assert.equal(noticeOf(route(snap, { channelType: 'teams', channelKey: 'conv' })), 'agent_not_available');
    assert.equal(noticeOf(route(snap, { channelType: 'teams', channelKey: 'other' })), 'agent_not_available');
  });
});
