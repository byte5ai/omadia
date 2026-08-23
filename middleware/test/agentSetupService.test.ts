import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConfigValidationError } from '@omadia/orchestrator';
import type { ConfigStore } from '@omadia/orchestrator';
import type { Pool } from 'pg';

import { createAgentSetupServices } from '../src/platform/agentSetupService.js';
import { ObservedConversationInvites } from '../src/platform/observedConversationInvites.js';
import type { ConductorEphemeralAttachmentsStore, EphemeralAttachment } from '../src/conductor/ephemeralAttachmentsStore.js';

// #330 C2a — the two plugin-facing setup services, including the review-driven
// security regressions: no config wipe on existing agents (H4), guarded unbind
// (H1), namespaced create-only persona skills (H3), and never adopting an
// operator binding into the ephemeral lifecycle (H5).

interface Calls {
  createdAgents: string[];
  attachedPlugins: Array<{ agentId: string; pluginId: string }>;
  bindings: Array<{ agentId: string; channelKey: string }>;
  reloads: number;
  pendingUpserts: string[];
  disposed: Array<{ channelKey: string; actor: string }>;
  audits: Array<{ action: string; channelKey: string }>;
}

function harness(opts?: {
  existingAgent?: boolean;
  pluginAlreadyAttached?: boolean;
  bindingTakenByOther?: boolean;
  attachmentRow?: Partial<EphemeralAttachment> | null;
  kernelReady?: boolean;
}): {
  services: ReturnType<typeof createAgentSetupServices>;
  invites: ObservedConversationInvites;
  calls: Calls;
} {
  const calls: Calls = {
    createdAgents: [], attachedPlugins: [], bindings: [], reloads: 0, pendingUpserts: [], disposed: [], audits: [],
  };
  const ready = opts?.kernelReady ?? true;
  const attachmentRow: EphemeralAttachment | undefined =
    opts?.attachmentRow === null
      ? undefined
      : opts?.attachmentRow
        ? {
            id: '1', workflowId: null, agentSlug: 'facilitator', channelType: 'teams', channelKey: 'conv-1',
            roleKey: null, state: 'pending', expiresAt: new Date('2026-08-22T10:00:00.000Z'),
            ...opts.attachmentRow,
          }
        : undefined;

  const configStore = {
    getAgentBySlug: async (slug: string) =>
      opts?.existingAgent ? { id: 'agent-1', slug, name: 'Existing' } : undefined,
    createAgent: async (input: { slug: string }) => {
      calls.createdAgents.push(input.slug);
      return { id: 'agent-1', slug: input.slug };
    },
    listAgentPlugins: async () =>
      opts?.pluginAlreadyAttached ? [{ pluginId: '@omadia/agent-facilitator', enabled: false, config: { keep: true } }] : [],
    upsertAgentPlugin: async (agentId: string, input: { pluginId: string }) => {
      calls.attachedPlugins.push({ agentId, pluginId: input.pluginId });
      return {};
    },
    createChannelBinding: async (agentId: string, input: { channelKey: string }) => {
      if (opts?.bindingTakenByOther || opts?.attachmentRow !== undefined) {
        throw new ConfigValidationError('already bound');
      }
      calls.bindings.push({ agentId, channelKey: input.channelKey });
      return {};
    },
    listChannelBindingsForAgent: async () =>
      opts?.bindingTakenByOther ? [] : [{ channelType: 'teams', channelKey: 'conv-1' }],
    removeChannelBinding: async () => undefined,
  } as unknown as ConfigStore;

  const registry = {
    reload: async () => {
      calls.reloads += 1;
      return {};
    },
  };

  const attachments = {
    upsertPending: async (input: { channelKey: string }) => {
      calls.pendingUpserts.push(input.channelKey);
      return {};
    },
    attachToWorkflow: async (input: { agentSlug: string }) =>
      input.agentSlug === 'facilitator' ? ({} as EphemeralAttachment) : undefined,
    getByConversation: async () => attachmentRow,
    getByWorkflow: async () => [],
    listByAgent: async (agentSlug: string) =>
      agentSlug === 'facilitator'
        ? [
            {
              id: '1',
              workflowId: 'wf-1',
              agentSlug: 'facilitator',
              channelType: 'teams',
              channelKey: 'conv-1',
              roleKey: 'facilitation-abc',
              state: 'attached',
              expiresAt: new Date('2026-08-23T00:00:00.000Z'),
            },
            {
              id: '2',
              workflowId: null,
              agentSlug: 'facilitator',
              channelType: 'teams',
              channelKey: 'conv-pending',
              roleKey: null,
              state: 'pending',
              expiresAt: new Date('2026-08-23T00:00:00.000Z'),
            },
          ]
        : [],
    listExpiredPending: async () => [],
    listExpiredAttached: async () => [],
    delete: async () => undefined,
  } as unknown as ConductorEphemeralAttachmentsStore;

  const invites = new ObservedConversationInvites();
  const services = createAgentSetupServices({
    pool: {} as Pool,
    getConfigStore: () => (ready ? configStore : undefined),
    getRegistry: () => (ready ? registry : undefined),
    invites,
    attachments,
    disposeAttachment: async (attachment, actor) => {
      calls.disposed.push({ channelKey: attachment.channelKey, actor });
    },
    resolveActiveRun: async (workflowId) => (workflowId === 'wf-1' ? 'run-restored' : null),
    auditBindingChange: async (entry) => {
      calls.audits.push({ action: entry.action, channelKey: entry.channelKey });
    },
  });
  return { services, invites, calls };
}

function observeInvite(invites: ObservedConversationInvites, conversationId = 'conv-1'): void {
  invites.observe({
    kind: 'bot_added',
    channelId: 'de.byte5.channel.teams',
    channelType: 'teams',
    conversationId,
    conversationType: 'group',
    members: [],
    occurredAt: '2026-08-21T10:00:00.000Z',
  });
}

describe('agentProvisioning.ensureAgent', () => {
  it('creates a missing agent and attaches the calling plugin', async () => {
    const { services, calls } = harness();
    const out = await services.agentProvisioning.ensureAgent({
      slug: 'facilitator',
      name: 'omadia Facilitator',
      pluginId: '@omadia/agent-facilitator',
    });
    assert.deepEqual(out, { created: true, agentSlug: 'facilitator' });
    assert.deepEqual(calls.createdAgents, ['facilitator']);
    assert.deepEqual(calls.attachedPlugins, [{ agentId: 'agent-1', pluginId: '@omadia/agent-facilitator' }]);
  });

  it('H4 — an existing agent_plugins row is NEVER upserted (operator config/enabled stays)', async () => {
    const { services, calls } = harness({ existingAgent: true, pluginAlreadyAttached: true });
    const out = await services.agentProvisioning.ensureAgent({
      slug: 'facilitator',
      name: 'ignored',
      pluginId: '@omadia/agent-facilitator',
    });
    assert.deepEqual(out, { created: false, agentSlug: 'facilitator' });
    assert.deepEqual(calls.createdAgents, []);
    assert.deepEqual(calls.attachedPlugins, [], 'no upsert may touch the operator-configured row');
  });

  it('H3 — personaSkill.slug must be namespaced under the agent slug', async () => {
    const { services } = harness();
    await assert.rejects(
      services.agentProvisioning.ensureAgent({
        slug: 'facilitator',
        name: 'x',
        pluginId: 'p',
        personaSkill: { slug: 'someone-elses-skill', name: 'x', body: 'injected' },
      }),
      /namespaced under 'facilitator-'/,
    );
  });

  it("refuses the 'fallback' agent and fails loudly before the kernel is ready", async () => {
    const { services } = harness();
    await assert.rejects(
      services.agentProvisioning.ensureAgent({ slug: 'fallback', name: 'x', pluginId: 'p' }),
      ConfigValidationError,
    );
    const cold = harness({ kernelReady: false });
    await assert.rejects(
      cold.services.agentProvisioning.ensureAgent({ slug: 'facilitator', name: 'x', pluginId: 'p' }),
      /not published yet/,
    );
  });
});

describe('conversationBindings.bind', () => {
  it('binds ONLY a kernel-observed group invite, records the pending row, audits', async () => {
    const { services, invites, calls } = harness({ existingAgent: true });
    observeInvite(invites);

    const denied = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-never-invited',
    });
    assert.deepEqual(denied, { bound: false, reason: 'not_observed' });

    const bound = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
    });
    assert.equal(bound.bound, true);
    assert.deepEqual(calls.bindings, [{ agentId: 'agent-1', channelKey: 'conv-1' }]);
    assert.deepEqual(calls.pendingUpserts, ['conv-1']);
    assert.deepEqual(calls.audits, [{ action: 'bind', channelKey: 'conv-1' }]);
  });

  it('a channel-type mismatch is refused (composite invite key)', async () => {
    const { services, invites } = harness({ existingAgent: true });
    observeInvite(invites);
    const out = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'telegram', conversationId: 'conv-1',
    });
    assert.deepEqual(out, { bound: false, reason: 'not_observed' });
  });

  it('never steals a conversation bound to another agent', async () => {
    const { services, invites, calls } = harness({ bindingTakenByOther: true, existingAgent: true });
    observeInvite(invites);
    const out = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
    });
    assert.equal(out.bound, false);
    assert.equal(out.reason, 'bound_to_other_agent');
    assert.deepEqual(calls.pendingUpserts, []);
  });

  it('H5 — a pre-existing OPERATOR binding to this agent is usable but never adopted (no pending row)', async () => {
    const { services, invites, calls } = harness({ existingAgent: true, attachmentRow: null });
    observeInvite(invites);
    const out = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
    });
    assert.equal(out.bound, true);
    assert.equal(out.preexistingOperatorBinding, true);
    assert.deepEqual(calls.pendingUpserts, [], 'operator setup must not enter the self-disposing lifecycle');
  });

  it('a repeated invite on OUR earlier auto-bind refreshes the pending row', async () => {
    const { services, invites, calls } = harness({ existingAgent: true, attachmentRow: {} });
    observeInvite(invites);
    const out = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
    });
    assert.equal(out.bound, true);
    assert.notEqual(out.preexistingOperatorBinding, true);
    assert.deepEqual(calls.pendingUpserts, ['conv-1']);
  });

  it('degrades to kernel_not_ready before the orchestrator plugin published its stores', async () => {
    const { services, invites } = harness({ kernelReady: false });
    observeInvite(invites);
    const out = await services.conversationBindings.bind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
    });
    assert.equal(out.reason, 'kernel_not_ready');
  });
});

describe('conversationBindings.unbind (H1 guard)', () => {
  it('releases only an ephemeral attachment owned by the calling agent — via the shared disposal', async () => {
    const { services, calls } = harness({ attachmentRow: {} });
    const out = await services.conversationBindings.unbind({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
    });
    assert.deepEqual(out, { unbound: true });
    assert.deepEqual(calls.disposed, [{ channelKey: 'conv-1', actor: 'agent:facilitator' }]);
  });

  it('refuses foreign attachments AND operator bindings (no row)', async () => {
    const foreign = harness({ attachmentRow: { agentSlug: 'someone-else' } });
    assert.deepEqual(
      await foreign.services.conversationBindings.unbind({ agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1' }),
      { unbound: false },
    );
    assert.deepEqual(foreign.calls.disposed, []);

    const operator = harness({ attachmentRow: null });
    assert.deepEqual(
      await operator.services.conversationBindings.unbind({ agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1' }),
      { unbound: false },
    );
    assert.deepEqual(operator.calls.disposed, []);
  });
});

describe('conversationBindings.attachWorkflow (M1 guard)', () => {
  it('reports whether the guarded attach actually took', async () => {
    const { services } = harness();
    const mine = await services.conversationBindings.attachWorkflow({
      agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1',
      workflowId: 'wf-1', expiresAt: new Date(),
    });
    assert.deepEqual(mine, { attached: true });
    const foreign = await services.conversationBindings.attachWorkflow({
      agentSlug: 'intruder', channelType: 'teams', conversationId: 'conv-1',
      workflowId: 'wf-1', expiresAt: new Date(),
    });
    assert.deepEqual(foreign, { attached: false });
  });
});

// #330 field report — restart rehydration: the read-own listing that lets the
// facilitator rebuild its in-memory state after a deploy instead of refusing
// every progress/nudge call.
describe('conversationBindings.listOwnAttachments', () => {
  it('returns only the caller-scoped rows, enriched with the active run when one exists', async () => {
    const { services } = harness();
    const rows = await services.conversationBindings.listOwnAttachments({ agentSlug: 'facilitator' });
    assert.equal(rows.length, 2);
    const attached = rows.find((r) => r.conversationId === 'conv-1');
    assert.equal(attached?.state, 'attached');
    assert.equal(attached?.roleKey, 'facilitation-abc');
    assert.equal(attached?.activeRunId, 'run-restored');
    const pending = rows.find((r) => r.conversationId === 'conv-pending');
    assert.equal(pending?.state, 'pending');
    assert.equal(pending?.activeRunId, null);

    const foreign = await services.conversationBindings.listOwnAttachments({ agentSlug: 'intruder' });
    assert.deepEqual(foreign, []);
  });
});
