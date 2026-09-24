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
import type { ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import { ChannelDirectoryRegistry } from '../src/channels/channelDirectoryRegistry.js';
import { createOperatorChannelsRouter } from '../src/routes/operatorChannels.js';

/**
 * A PROVISIONED BOT IS NOT A FREE CHANNEL KEY.
 *
 * Routing resolves `28:<appId>` from `agent_teams_identities` — the agent the
 * bot was provisioned FOR — and that beats a `channel_bindings` row. So a
 * binding pointing such a key at a DIFFERENT agent used to be accepted,
 * written, confirmed with a 200, rendered on the channels screen as the
 * operator's choice — and changed nothing at all. The bot went on answering
 * as its own agent while every screen said otherwise.
 *
 * Accepted-and-ignored is the worst of the three possible behaviours (honour
 * it, refuse it, ignore it), because it is the only one an operator cannot
 * see. This is the refusal, plus the two cases that must NOT be refused.
 */

const BOT_KEY = '28:11111111-2222-3333-4444-555555555555';

function fakeDirectory(entries: readonly ChannelKeyEntry[]): ChannelKeyDirectory {
  return {
    channelType: 'teams',
    originPluginId: '@omadia/channel-teams',
    listKeys: async () => entries,
  };
}

interface Harness {
  baseUrl: string;
  /** Every binding write the route performed, in order. */
  readonly created: Array<{ agentId: string; channelKey: string }>;
  readonly reloads: number[];
  close(): Promise<void>;
}

interface HarnessInput {
  /** Provisioned bots, as `listChannelIdentities` projects them. */
  readonly identities?: ReadonlyArray<{
    channelType: string;
    channelKey: string;
    agentId: string;
  }>;
  /** Omit the method entirely — a store predating per-bot routing. */
  readonly withoutIdentityListing?: boolean;
}

async function makeHarness(input: HarnessInput = {}): Promise<Harness> {
  const directory = new ChannelDirectoryRegistry();
  directory.register(fakeDirectory([{ key: BOT_KEY, label: 'HR Bot' }]));

  const created: Array<{ agentId: string; channelKey: string }> = [];
  const reloads: number[] = [];

  const base = {
    listAgents: async () => [
      { id: 'a-hr', slug: 'hr', name: 'HR', status: 'enabled' },
      { id: 'a-sales', slug: 'sales', name: 'Sales', status: 'enabled' },
    ],
    listChannelBindings: async () => [],
    getPlatformSettings: async () => ({ fallbackAgentId: 'a-hr' }),
    getAgentBySlug: async (slug: string) =>
      slug === 'hr'
        ? { id: 'a-hr', slug: 'hr' }
        : slug === 'sales'
          ? { id: 'a-sales', slug: 'sales' }
          : undefined,
    createChannelBinding: async (
      agentId: string,
      binding: { channelType: string; channelKey: string },
    ) => {
      created.push({ agentId, channelKey: binding.channelKey });
      return undefined;
    },
    removeChannelBinding: async () => undefined,
  };

  const store = (
    input.withoutIdentityListing
      ? base
      : {
          ...base,
          listChannelIdentities: async () => input.identities ?? [],
        }
  ) as unknown as ConfigStore;

  const orchestratorRegistry = {
    reload: async () => {
      reloads.push(1);
      return undefined;
    },
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
    baseUrl: `http://127.0.0.1:${port}`,
    created,
    reloads,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function putBinding(
  harness: Harness,
  agentSlug: string | null,
  channelKey = BOT_KEY,
): Promise<globalThis.Response> {
  return fetch(`${harness.baseUrl}/api/v1/operator/channels/binding`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel_type: 'teams',
      channel_key: channelKey,
      agent_slug: agentSlug,
    }),
  });
}

describe('PUT /operator/channels/binding — provisioned bots', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('refuses to point a provisioned bot at another agent', async () => {
    harness = await makeHarness({
      identities: [
        { channelType: 'teams', channelKey: BOT_KEY, agentId: 'a-hr' },
      ],
    });

    const res = await putBinding(harness, 'sales');
    assert.equal(res.status, 409);
    const body = (await res.json()) as {
      error: string;
      message: string;
      owned_by_agent_slug: string;
    };
    assert.equal(body.error, 'channel_owned_by_provisioned_bot');
    // The refusal names the agent that DOES own the bot — without it the
    // operator has to go and find out which one is in the way.
    assert.equal(body.owned_by_agent_slug, 'hr');
    assert.match(body.message, /would be recorded and never take effect/);

    // Nothing written, nothing rolled.
    assert.deepEqual(harness.created, []);
    assert.deepEqual(harness.reloads, []);
  });

  it('allows binding a provisioned bot to the agent it belongs to', async () => {
    // Agrees with the identity, so it is a no-op by construction — not worth
    // an error the operator cannot act on.
    harness = await makeHarness({
      identities: [
        { channelType: 'teams', channelKey: BOT_KEY, agentId: 'a-hr' },
      ],
    });

    const res = await putBinding(harness, 'hr');
    assert.equal(res.status, 200);
    assert.deepEqual(harness.created, [{ agentId: 'a-hr', channelKey: BOT_KEY }]);
  });

  it('leaves an ordinary channel key alone', async () => {
    // The guard must not turn into "no bindings allowed": a group chat, a
    // Telegram chat, anything that is not a provisioned bot still binds.
    harness = await makeHarness({
      identities: [
        { channelType: 'teams', channelKey: BOT_KEY, agentId: 'a-hr' },
      ],
    });

    const res = await putBinding(harness, 'sales', '19:group@thread.v2');
    assert.equal(res.status, 200);
    assert.deepEqual(harness.created, [
      { agentId: 'a-sales', channelKey: '19:group@thread.v2' },
    ]);
  });

  it('degrades to "no provisioned bots" against a store without the listing', async () => {
    // The method arrived with per-bot routing. A store double (or a mount)
    // that predates it must not turn this route into a 500 — there is simply
    // no bot claiming the key.
    harness = await makeHarness({ withoutIdentityListing: true });

    const res = await putBinding(harness, 'sales');
    assert.equal(res.status, 200);
    assert.deepEqual(harness.created, [
      { agentId: 'a-sales', channelKey: BOT_KEY },
    ]);
  });

  it('never blocks CLEARING a binding', async () => {
    // Clearing removes a row that was doing nothing anyway. Refusing it would
    // trap an operator with a binding they can neither use nor delete.
    harness = await makeHarness({
      identities: [
        { channelType: 'teams', channelKey: BOT_KEY, agentId: 'a-hr' },
      ],
    });

    const res = await putBinding(harness, null);
    assert.equal(res.status, 200);
  });
});
