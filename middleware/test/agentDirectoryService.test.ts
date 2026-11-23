/**
 * Spec 2042 §5.3, criterion 40 — `agentDirectory@1`: the agents a person may
 * address in a channel and what an unaddressed message from them reaches.
 * The service and `GET /api/v1/agents/directory` are ONE function; only
 * channel plugins get the service; it lists for the principal the canvas
 * channel's turns are routed by.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { AGENT_DIRECTORY_SERVICE_NAME, type AgentDirectoryService } from '@omadia/plugin-api';

import { SnapshotRoutingView } from '../packages/harness-orchestrator/src/registry/routingView.js';
import type { AgentRow, ConfigSnapshot } from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  AgentDirectoryRefusedError,
  agentDirectoryService,
  buildAgentDirectory,
  createAgentDirectoryService,
  directoryPrincipal,
} from '../src/platform/agentDirectoryService.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const NOW = new Date('2026-11-23T00:00:00Z');

function agent(slug: string, over: Partial<AgentRow> = {}): AgentRow {
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
    ...over,
  };
}

function registryOf(snap: Partial<ConfigSnapshot>) {
  const full: ConfigSnapshot = { agents: [], agentPlugins: [], channelBindings: [], ...snap };
  return {
    routingView: () => new SnapshotRoutingView(full),
    getById: (id: string) => {
      const row = full.agents.find((a) => a.id === id);
      return row ? { agent: row, built: { bundle: { agent: { chat: () => undefined, chatStream: () => undefined } } } } : undefined;
    },
  } as never;
}

const mira = agent('mira');
const jonas = agent('jonas', { availableToEveryone: false });
const ghost = agent('ghost', { status: 'disabled' });
const webOnly = agent('webonly', { availableChannels: ['web'] });
const teamsOnly = agent('teamsonly', { availableChannels: ['teams'] });

const snap: Partial<ConfigSnapshot> = {
  agents: [mira, jonas, ghost, webOnly, teamsOnly],
  availabilityPrincipals: [{ agentId: jonas.id, principal: 'user:anna@example.com' }],
  defaultEntries: [{ id: 'e1', principal: null, channelType: null, agentId: mira.id, updatedBy: null, updatedAt: NOW }],
};

describe('agent directory — what a person may address in a channel', () => {
  it('lists the addressable agents available to the asker in that channel, sorted, with the default agent', () => {
    const dir = buildAgentDirectory(registryOf(snap), { channel: 'web', principal: 'user:anna@example.com' });
    assert.deepEqual(
      dir.agents.map((a) => a.slug),
      ['jonas', 'mira', 'webonly'],
      'jonas (named for anna), mira (everyone), webonly (web); not ghost (disabled), not teamsonly (other channel)',
    );
    assert.equal(dir.agents[1]!.id, mira.id, 'the entry carries agents.id — what a turn is addressed by');
    assert.deepEqual(dir.default_agent, { slug: 'mira' });
    assert.equal(dir.channel, 'web');
  });

  it('does not list an agent that is not available to this person', () => {
    const dir = buildAgentDirectory(registryOf(snap), { channel: 'web', principal: 'user:ben@example.com' });
    assert.deepEqual(dir.agents.map((a) => a.slug), ['mira', 'webonly']);
    const anonymous = buildAgentDirectory(registryOf(snap), { channel: 'web' });
    assert.deepEqual(anonymous.agents.map((a) => a.slug), ['mira', 'webonly']);
  });

  it('says why nobody is the default when no entry exists', () => {
    const dir = buildAgentDirectory(registryOf({ agents: [mira] }), { channel: 'web' });
    assert.equal(dir.default_agent.slug, null);
    assert.ok('notice' in dir.default_agent && dir.default_agent.notice.length > 0);
  });
});

describe('agentDirectory@1 — the service', () => {
  const request = {
    channel: 'web',
    channelId: 'de.byte5.channel.omadia-ui',
    subject: 'sub-1',
    email: 'Anna@Example.com',
    provider: 'entra',
  } as const;

  it('lists for the principal the canvas channel routes the person by (e-mail first, else custom:<subject>)', () => {
    assert.equal(directoryPrincipal(request), 'user:anna@example.com');
    const { email: _email, ...noMail } = request;
    assert.equal(directoryPrincipal(noMail), 'user:custom:sub-1');
    assert.equal(directoryPrincipal({ ...request, subject: '   ' }), undefined);
  });

  it('answers the same view as the route function, for that principal', async () => {
    const reg = registryOf(snap);
    const service = createAgentDirectoryService(() => reg);
    const viaService = await service.listAvailable(request);
    assert.deepEqual(viaService, buildAgentDirectory(reg, { channel: 'web', principal: 'user:anna@example.com' }));
    assert.ok(viaService.agents.some((a) => a.slug === 'jonas'));
  });

  it('rejects without a registry and for a malformed channel', async () => {
    await assert.rejects(createAgentDirectoryService(() => undefined).listAvailable(request), /unavailable/);
    await assert.rejects(createAgentDirectoryService(() => registryOf(snap)).listAvailable({ ...request, channel: ' ' }), /invalid_channel/);
    await assert.rejects(
      createAgentDirectoryService(() => registryOf(snap)).listAvailable({ ...request, channel: 'x'.repeat(65) }),
      /invalid_channel/,
    );
  });

  it('is given to channel plugins only', () => {
    const kinds: Record<string, string> = {
      '@omadia/ui-channel': 'channel',
      '@omadia/ui-orchestrator': 'system-module',
      '@acme/tool': 'tool',
    };
    const registry = new ServiceRegistry();
    registry.provide(
      AGENT_DIRECTORY_SERVICE_NAME,
      agentDirectoryService((id) => kinds[id] as never, () => registryOf(snap)),
    );
    const caller = (id: string) => ({ agentId: id, pluginId: id });
    assert.ok(registry.get<AgentDirectoryService>(AGENT_DIRECTORY_SERVICE_NAME, caller('@omadia/ui-channel')));
    for (const id of ['@omadia/ui-orchestrator', '@acme/tool', '@acme/unknown']) {
      assert.throws(
        () => registry.get(AGENT_DIRECTORY_SERVICE_NAME, caller(id)),
        (err: unknown) => err instanceof AgentDirectoryRefusedError,
        id,
      );
    }
  });
});
