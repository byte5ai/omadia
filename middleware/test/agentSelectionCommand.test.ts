import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseAgentCommand } from '../packages/harness-channel-sdk/src/agentCommand.js';
import { KernelAgentSelectionService } from '../packages/harness-orchestrator/src/management/agentSelection.js';
import { SnapshotRoutingView } from '../packages/harness-orchestrator/src/registry/routingView.js';
import type { AgentRow, ConfigSnapshot } from '../packages/harness-orchestrator/src/registry/configStore.js';
import type { AgentSelectionRow } from '../packages/harness-orchestrator/src/registry/routingTables.js';

/**
 * #2055 — choosing an agent in plain text (spec 2042 §5.3, criterion 30's
 * "choosing an agent" through the plain-text path): `/agent <name>` stores the
 * sender's selection and is confirmed by a `system` notice; `/agents` lists
 * only agents available to the sender here.
 */

describe('parseAgentCommand', () => {
  it('reads /agent <name>, /agent and /agents', () => {
    assert.deepEqual(parseAgentCommand('/agent Mira'), { kind: 'select', name: 'Mira' });
    assert.deepEqual(parseAgentCommand('  /agent   Mira Weber  '), { kind: 'select', name: 'Mira Weber' });
    assert.deepEqual(parseAgentCommand('/agent "Mira"'), { kind: 'select', name: 'Mira' });
    assert.deepEqual(parseAgentCommand('/agent'), { kind: 'clear' });
    assert.deepEqual(parseAgentCommand('/agents'), { kind: 'list' });
    assert.deepEqual(parseAgentCommand('/AGENT@omadia_bot Mira'), { kind: 'select', name: 'Mira' });
  });

  it('ordinary text is not a command', () => {
    assert.equal(parseAgentCommand('Kannst du /agent Mira fragen?'), undefined);
    assert.equal(parseAgentCommand('/agents please'), undefined);
    assert.equal(parseAgentCommand('/agentur Mira'), undefined);
    assert.equal(parseAgentCommand('#strategist hi'), undefined);
  });
});

const NOW = new Date('2026-11-20T00:00:00Z');

function agent(slug: string, displayName: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName: displayName,
    availableToEveryone: true,
    availableChannels: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(agents: AgentRow[]) {
  let snap: ConfigSnapshot = { agents, agentPlugins: [], channelBindings: [], selections: [] };
  const writes: string[] = [];
  const registry = {
    routingView: () => new SnapshotRoutingView(snap),
    adoptSelection: (row: AgentSelectionRow) => {
      snap = { ...snap, selections: [...(snap.selections ?? []), row] };
    },
    forgetSelection: () => {
      snap = { ...snap, selections: [] };
    },
  };
  const tables = {
    setSelection: async (row: Omit<AgentSelectionRow, 'selectedAt'>) => {
      writes.push(`set ${row.principal} ${row.agentId}`);
      return { ...row, selectedAt: NOW };
    },
    clearSelection: async (_c: string, _k: string, principal: string) => {
      writes.push(`clear ${principal}`);
    },
  };
  return {
    service: new KernelAgentSelectionService({ registry: registry as never, tables }),
    writes,
    selections: () => snap.selections ?? [],
  };
}

const context = { channelType: 'telegram', conversationKey: 'chat-1', principal: 'user:anna@example.com', locale: 'de' };

describe('KernelAgentSelectionService', () => {
  it('selects an available agent by display name and confirms as system', async () => {
    const h = harness([agent('mira-sales', 'Mira')]);
    const notice = await h.service.handle({ kind: 'select', name: 'mira' }, context);
    assert.equal(notice.code, 'agent_selected');
    assert.match(notice.text, /Mira/);
    assert.deepEqual(h.writes, ['set user:anna@example.com id-mira-sales']);
    assert.equal(h.selections()[0]?.agentId, 'id-mira-sales');
  });

  it('refuses an agent that is not available to the sender, without storing anything', async () => {
    const h = harness([agent('hr', 'Hanna', { availableToEveryone: false })]);
    const notice = await h.service.handle({ kind: 'select', name: 'Hanna' }, context);
    assert.equal(notice.code, 'agent_not_available');
    assert.deepEqual(h.writes, []);
  });

  it('names a disabled agent as disabled and an unknown one as unknown', async () => {
    const h = harness([agent('old', 'Olga', { status: 'disabled' })]);
    assert.equal((await h.service.handle({ kind: 'select', name: 'Olga' }, context)).code, 'agent_disabled');
    assert.equal((await h.service.handle({ kind: 'select', name: 'Nobody' }, context)).code, 'agent_unknown');
  });

  it('lists only the agents available here, never a facilitator', async () => {
    const h = harness([
      agent('mira', 'Mira'),
      agent('hr', 'Hanna', { availableToEveryone: false }),
      agent('fac', 'Fritz', { archetype: 'facilitator' }),
      agent('slack-only', 'Sven', { availableChannels: ['slack'] }),
    ]);
    const notice = await h.service.handle({ kind: 'list' }, context);
    assert.equal(notice.code, 'agent_directory');
    assert.match(notice.text, /Mira/);
    assert.doesNotMatch(notice.text, /Hanna|Fritz|Sven/);
  });

  it('clears the selection', async () => {
    const h = harness([agent('mira', 'Mira')]);
    const notice = await h.service.handle({ kind: 'clear' }, context);
    assert.equal(notice.code, 'agent_selection_cleared');
    assert.deepEqual(h.writes, ['clear user:anna@example.com']);
  });
});

describe('managementChatAgent — the ChatAgent a channel gets from routing', () => {
  async function stream(agent: import('@omadia/channel-sdk').ChatAgent, text: string) {
    const events = [];
    for await (const e of agent.chatStream({ userMessage: text })) events.push(e);
    return events;
  }

  it('handles /agent itself and never runs the routed agent for it', async () => {
    const { managementChatAgent } = await import('../packages/harness-orchestrator/src/management/managementChatAgent.js');
    let ran = 0;
    const inner = {
      chat: async () => {
        ran += 1;
        return { text: 'agent' };
      },
      async *chatStream() {
        ran += 1;
        yield { type: 'done' as const, answer: 'agent', toolCalls: 0, iterations: 1 };
      },
    };
    const h = harness([agent('mira', 'Mira')]);
    const routed = managementChatAgent(inner, { ...context, selection: h.service });
    const events = await stream(routed, '/agent Mira');
    assert.equal(ran, 0);
    assert.equal(events.length, 1);
    const done = events[0];
    assert.equal(done?.type === 'done' && done.systemNotice?.code, 'agent_selected');
    assert.deepEqual(done?.type === 'done' && done.speaker, { kind: 'system' });
    assert.equal((await routed.chat({ userMessage: 'Hallo' })).text, 'agent');
    assert.equal(ran, 1);
  });

  it('on a refusal it answers with the notice from system, and /agent still works', async () => {
    const { managementChatAgent } = await import('../packages/harness-orchestrator/src/management/managementChatAgent.js');
    const { buildSystemNotice } = await import('../packages/harness-orchestrator/src/management/systemNotices.js');
    const h = harness([agent('mira', 'Mira')]);
    const refused = managementChatAgent(undefined, { ...context, selection: h.service }, buildSystemNotice('no_agent'));
    const answer = await refused.chat({ userMessage: 'Hallo?' });
    assert.equal(answer.systemNotice?.code, 'no_agent');
    assert.deepEqual(answer.speaker, { kind: 'system' });
    const selected = await refused.chat({ userMessage: '/agent Mira' });
    assert.equal(selected.systemNotice?.code, 'agent_selected');
  });
});
