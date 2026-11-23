/**
 * S6 rollout finding (web-ui): the default-agent table, the binding form and
 * the routing tester offered plugin ids (`channel-discord`) instead of
 * channel types (`discord`), because the UI guessed the type from the id.
 * The server now names them: the types an active channel plugin claimed,
 * else what the dispatcher derives for its id.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import { ChannelTypeClaims } from '../src/channels/scopedCoreApi.js';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

describe('channel types of channel plugins', () => {
  it('ChannelTypeClaims lists the types a plugin holds', () => {
    const claims = new ChannelTypeClaims();
    claims.claim('@omadia/channel-discord', 'discord');
    claims.claim('@omadia/channel-teams', 'teams');
    claims.claim('@omadia/channel-discord', 'discord');
    assert.deepEqual(claims.typesOf('@omadia/channel-discord'), ['discord']);
    assert.deepEqual(claims.typesOf('@omadia/channel-slack'), []);
    claims.release('@omadia/channel-discord');
    assert.deepEqual(claims.typesOf('@omadia/channel-discord'), []);
  });

  it('GET /plugin-catalog names channel_types for channel plugins only', async () => {
    const plugin = (id: string, kind: string) => ({ plugin: { id, name: id, kind, version: '1.0.0' } });
    const catalog = {
      list: () => [plugin('@omadia/channel-discord', 'channel'), plugin('@omadia/odoo', 'tool')],
    };
    const installed = { list: () => [{ id: '@omadia/channel-discord' }, { id: '@omadia/odoo' }] };
    const app = express();
    app.use(
      '/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => undefined,
        getRegistry: () => undefined,
        getChatSessionStore: () => undefined,
        getPluginCatalog: () => catalog,
        getInstalledRegistry: () => installed,
        channelTypesOf: (id: string) => (id === '@omadia/channel-discord' ? ['discord'] : []),
      } as never),
    );
    const server = await listenLoopback(app);
    try {
      const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/agents/plugin-catalog`);
      const body = (await res.json()) as { items: Array<{ id: string; channel_types?: string[] }> };
      const byId = new Map(body.items.map((i) => [i.id, i]));
      assert.deepEqual(byId.get('@omadia/channel-discord')?.channel_types, ['discord']);
      assert.equal(byId.get('@omadia/odoo')?.channel_types, undefined);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
