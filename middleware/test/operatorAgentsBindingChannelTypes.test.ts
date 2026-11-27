/**
 * #1879 — the agent card's binding editor and the routing tester accepted any
 * channel type. The agents page once offered `channel-api` for the Public API
 * channel, whose routing type is its plugin id `@omadia/channel-api`
 * (ADR-0141); a binding saved under the guess never matched a turn, and the
 * tester answered "fallback" for every bound key. The routes now accept only
 * the types the installed channel plugins route (the list the dashboard
 * offers), and a binding the agent already holds may stay.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { registeredChannelTypes } from '../src/routes/registeredChannelTypes.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { FakeConfigRevisions } from './_helpers/fakeConfigRevisions.js';

interface Binding {
  agentId: string;
  channelType: string;
  channelKey: string;
}

const AGENT = { id: 'a-1', slug: 'dritter', name: 'Dritter', archetype: 'standard', status: 'enabled' };

class FakeStore {
  /** #2315 — per-resource config revisions. */
  private readonly revisionTwin = new FakeConfigRevisions();
  configRevisions = this.revisionTwin.configRevisions;
  claimConfigRevision = this.revisionTwin.claimConfigRevision;
  bindings: Binding[] = [];
  getAgentBySlug(slug: string) {
    return Promise.resolve(slug === AGENT.slug ? AGENT : undefined);
  }
  listChannelBindingsForAgent(agentId: string) {
    return Promise.resolve(this.bindings.filter((b) => b.agentId === agentId));
  }
  removeChannelBinding(channelType: string, channelKey: string) {
    this.bindings = this.bindings.filter((b) => !(b.channelType === channelType && b.channelKey === channelKey));
    return Promise.resolve();
  }
  createChannelBinding(agentId: string, b: { channelType: string; channelKey: string }) {
    if (this.bindings.some((x) => x.channelType === b.channelType && x.channelKey === b.channelKey)) {
      return Promise.resolve();
    }
    this.bindings = [...this.bindings, { agentId, ...b }];
    return Promise.resolve();
  }
  resolveBinding(channelType: string, channelKey: string) {
    return Promise.resolve(this.bindings.find((b) => b.channelType === channelType && b.channelKey === channelKey));
  }
}

const registry = {
  reload: () => Promise.resolve({ actions: [] }),
  instanceDefaultAgent: () => undefined,
  identityForChannel: () => undefined,
  resolveBinding: () => undefined,
  list: () => [],
  get: () => undefined,
};

const plugin = (id: string, kind: string) => ({ plugin: { id, name: id, kind, version: '1.0.0' } });
const catalog = {
  list: () => [
    plugin('@omadia/channel-api', 'channel'),
    plugin('@omadia/channel-discord', 'channel'),
    plugin('@omadia/channel-slack', 'channel'),
    plugin('@omadia/odoo', 'tool'),
  ],
};
// Slack is in the catalog but not installed: its type is not offered.
const installed = { list: () => [{ id: '@omadia/channel-api' }, { id: '@omadia/channel-discord' }, { id: '@omadia/odoo' }] };
const channelTypesOf = (id: string): readonly string[] =>
  id === '@omadia/channel-discord' ? ['discord'] : id === '@omadia/channel-slack' ? ['slack'] : [id];

describe('#1879 channel types on the binding and routing-tester routes', () => {
  let store: FakeStore;
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store,
        getRegistry: () => registry,
        getChatSessionStore: () => undefined,
        getPluginCatalog: () => catalog,
        getInstalledRegistry: () => installed,
        channelTypesOf,
      } as never),
    );
    const server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/agents`;
    close = () => new Promise<void>((done) => server.close(() => done()));
  });
  after(async () => close());
  beforeEach(() => {
    store = new FakeStore();
  });

  const put = (bindings: Array<{ channel_type: string; channel_key: string }>) =>
    fetch(`${baseUrl}/dritter/bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings }),
    });

  it('the known types are those of the installed channel plugins plus the kernel web chat', () => {
    const known = registeredChannelTypes({ catalog, installed, channelTypesOf });
    assert.deepEqual([...(known ?? [])].sort(), ['@omadia/channel-api', 'discord', 'web']);
    assert.equal(registeredChannelTypes({ catalog: undefined, installed, channelTypesOf }), undefined);
  });

  it('stores a binding under a registered type', async () => {
    const res = await put([{ channel_type: '@omadia/channel-api', channel_key: 'key:k1' }]);
    assert.equal(res.status, 200);
    assert.deepEqual(store.bindings, [{ agentId: 'a-1', channelType: '@omadia/channel-api', channelKey: 'key:k1' }]);
  });

  it('refuses a new binding under a guessed type with 400 and the accepted list', async () => {
    const res = await put([{ channel_type: 'channel-api', channel_key: 'key:k1' }]);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; channel_type: string; known_channel_types: string[] };
    assert.equal(body.error, 'unknown_channel_type');
    assert.equal(body.channel_type, 'channel-api');
    assert.deepEqual(body.known_channel_types, ['@omadia/channel-api', 'discord', 'web']);
    assert.deepEqual(store.bindings, []);
  });

  it('accepts the kernel web chat type without any channel plugin for it', async () => {
    const res = await put([{ channel_type: 'web', channel_key: 'session-1' }]);
    assert.equal(res.status, 200);
    const tester = await fetch(`${baseUrl}/resolve-channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel_type: 'web', channel_key: 'session-1' }),
    });
    // The fake registry cannot resolve a turn; what is guarded here is that
    // the type check lets `web` through instead of refusing it.
    assert.notEqual(tester.status, 400);
  });

  it('refuses the type of a channel that is not installed', async () => {
    const res = await put([{ channel_type: 'slack', channel_key: 'C1' }]);
    assert.equal(res.status, 400);
  });

  it('keeps a binding the agent already holds under a type no channel routes any more', async () => {
    store.bindings = [{ agentId: 'a-1', channelType: 'slack', channelKey: 'C1' }];
    const res = await put([
      { channel_type: 'slack', channel_key: 'C1' },
      { channel_type: 'discord', channel_key: '123' },
    ]);
    assert.equal(res.status, 200);
    assert.equal(store.bindings.length, 2);
  });

  it('the routing tester refuses an unknown type instead of answering "fallback"', async () => {
    const res = await fetch(`${baseUrl}/resolve-channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel_type: 'channel-api', channel_key: 'key:k1' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'unknown_channel_type');
  });

  it('migration 0117 rewrites only unambiguous `channel-api` rows of the API key form', () => {
    const sql = readFileSync(new URL('../migrations/0117_channel_api_binding_type.sql', import.meta.url), 'utf8');
    assert.match(sql, /SET channel_type = '@omadia\/channel-api'/);
    assert.match(sql, /channel_key LIKE 'key:%'/);
    assert.match(sql, /NOT EXISTS/);
  });
});
