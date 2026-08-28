import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  ChannelKeyDirectory,
  ChannelKeyEntry,
} from '@omadia/channel-sdk';
import type {
  ConfigStore,
  OrchestratorRegistry,
} from '@omadia/orchestrator';

import { ChannelDirectoryRegistry } from '../src/channels/channelDirectoryRegistry.js';
import { createOperatorChannelsRouter } from '../src/routes/operatorChannels.js';

/**
 * `members` / `memberCount` passthrough — the optional member-resolution
 * fields a channel plugin (e.g. Teams via Graph) can attach to its
 * directory entries. Two layers under test:
 *
 *   1. ChannelDirectoryRegistry.listAll() forwards the fields verbatim
 *      and omits them when the plugin did not set them.
 *   2. GET /api/v1/operator/channels maps them to `members` /
 *      `member_count` in the DTO; stale binding rows never carry them.
 */

function fakeDirectory(
  channelType: string,
  entries: readonly ChannelKeyEntry[],
): ChannelKeyDirectory {
  return {
    channelType,
    originPluginId: `@omadia/channel-${channelType}`,
    listKeys: async () => entries,
  };
}

describe('ChannelDirectoryRegistry members passthrough', () => {
  it('forwards members + memberCount and omits them when unset', async () => {
    const registry = new ChannelDirectoryRegistry();
    registry.register(
      fakeDirectory('teams', [
        {
          key: '19:chat@thread.skype',
          label: 'Project Group',
          members: ['Alice Adams', 'Bob Brown'],
          memberCount: 5,
        },
        { key: '28:bot-app-id', label: 'Teams Bot (all)', hint: 'catch-all' },
      ]),
    );

    const all = await registry.listAll();
    assert.equal(all.length, 2);

    const enriched = all.find((e) => e.key === '19:chat@thread.skype');
    assert.ok(enriched);
    assert.deepEqual(enriched.members, ['Alice Adams', 'Bob Brown']);
    assert.equal(enriched.memberCount, 5);

    const plain = all.find((e) => e.key === '28:bot-app-id');
    assert.ok(plain);
    assert.equal('members' in plain, false);
    assert.equal('memberCount' in plain, false);
  });

  it('caps oversized member lists and names at the kernel boundary', async () => {
    const registry = new ChannelDirectoryRegistry();
    registry.register(
      fakeDirectory('teams', [
        {
          key: '19:big@thread.skype',
          label: 'Big Group',
          members: Array.from({ length: 40 }, (_, i) => `Member ${String(i)}`),
          memberCount: 40,
        },
        {
          key: '19:long@thread.skype',
          label: 'Long Names',
          members: ['x'.repeat(500)],
          memberCount: -3,
        },
      ]),
    );

    const all = await registry.listAll();
    const big = all.find((e) => e.key === '19:big@thread.skype');
    assert.ok(big?.members);
    assert.equal(big.members.length, 16);
    assert.equal(big.memberCount, 40);

    const long = all.find((e) => e.key === '19:long@thread.skype');
    assert.ok(long?.members);
    assert.equal(long.members[0]?.length, 121); // 120 chars + ellipsis
    assert.equal('memberCount' in long, false); // negative count dropped
  });
});

interface Harness {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

async function makeRouteHarness(
  entries: readonly ChannelKeyEntry[],
  bindings: Array<{
    channelType: string;
    channelKey: string;
    agentId: string;
  }> = [],
): Promise<Harness> {
  const directory = new ChannelDirectoryRegistry();
  directory.register(fakeDirectory('teams', entries));

  const store = {
    listAgents: async () => [
      { id: 'a1', slug: 'hr', name: 'HR', status: 'enabled' },
    ],
    listChannelBindings: async () => bindings,
    getPlatformSettings: async () => ({ fallbackAgentId: 'a1' }),
  } as unknown as ConfigStore;
  const orchestratorRegistry = {
    reload: async () => undefined,
  } as unknown as OrchestratorRegistry;

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/operator/channels',
    createOperatorChannelsRouter({
      getConfigStore: () => store,
      getRegistry: () => orchestratorRegistry,
      getDirectoryRegistry: () => directory,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('GET /api/v1/operator/channels members mapping', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('maps members/memberCount to members/member_count and leaves them off plain rows', async () => {
    harness = await makeRouteHarness([
      {
        key: '19:chat@thread.skype',
        label: 'Project Group',
        members: ['Alice Adams', 'Bob Brown'],
        memberCount: 5,
      },
      { key: '28:bot-app-id', label: 'Teams Bot (all)' },
    ]);

    const res = await fetch(`${harness.baseUrl}/api/v1/operator/channels`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      channels: Array<Record<string, unknown>>;
    };

    const withMembers = body.channels.find(
      (c) => c['channel_key'] === '19:chat@thread.skype',
    );
    assert.ok(withMembers);
    assert.deepEqual(withMembers['members'], ['Alice Adams', 'Bob Brown']);
    assert.equal(withMembers['member_count'], 5);

    const plain = body.channels.find(
      (c) => c['channel_key'] === '28:bot-app-id',
    );
    assert.ok(plain);
    assert.equal('members' in plain, false);
    assert.equal('member_count' in plain, false);
  });

  it('never adds members to stale binding rows', async () => {
    harness = await makeRouteHarness(
      [{ key: '28:bot-app-id', label: 'Teams Bot (all)' }],
      [{ channelType: 'teams', channelKey: '19:gone@thread.skype', agentId: 'a1' }],
    );

    const res = await fetch(`${harness.baseUrl}/api/v1/operator/channels`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      channels: Array<Record<string, unknown>>;
    };
    const stale = body.channels.find((c) => c['stale'] === true);
    assert.ok(stale);
    assert.equal(stale['channel_key'], '19:gone@thread.skype');
    assert.equal('members' in stale, false);
    assert.equal('member_count' in stale, false);
  });
});
