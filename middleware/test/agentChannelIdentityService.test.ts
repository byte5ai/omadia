/**
 * Spec 2042 §5.3 — registering an agent's own bot through its channel plugin.
 *
 * Pinned: the credentials reach the plugin and nothing else (not the store,
 * not a log line, not a response); the plugin's default bot and another
 * agent's bot are refused without being released; a failed store write stops
 * the bot again; removal stops the bot before the row goes.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { AgentIdentityProvider, AgentIdentityProvisionInput } from '@omadia/channel-sdk';

import {
  createAgentChannelIdentityService,
  scrubCredentials,
  validateCredentials,
} from '../src/platform/agentChannelIdentityService.js';
import {
  AgentChannelIdentityConflict,
  type AgentChannelIdentityInput,
  type AgentChannelIdentityRecord,
  type AgentChannelIdentityStore,
} from '../src/platform/agentChannelIdentityStore.js';

const TOKEN = '7000000001:AAH-very-secret-token';
const MIRA = { id: 'a-mira', slug: 'mira', name: 'Mira' };
const OTTO = { id: 'a-otto', slug: 'otto', name: 'Otto' };

function memoryStore(): AgentChannelIdentityStore & { rows: AgentChannelIdentityRecord[]; inserted: AgentChannelIdentityInput[]; failNext?: Error } {
  const store = {
    rows: [] as AgentChannelIdentityRecord[],
    inserted: [] as AgentChannelIdentityInput[],
    failNext: undefined as Error | undefined,
    listForAgent: (agentId: string) => Promise.resolve(store.rows.filter((r) => r.agentId === agentId)),
    get: (agentId: string, channelType: string) =>
      Promise.resolve(store.rows.find((r) => r.agentId === agentId && r.channelType === channelType)),
    ownerOf: (channelType: string, channelKey: string) =>
      Promise.resolve(store.rows.find((r) => r.channelType === channelType && r.channelKey === channelKey)?.agentId),
    insert: (input: AgentChannelIdentityInput) => {
      store.inserted.push(input);
      if (store.failNext) {
        const err = store.failNext;
        store.failNext = undefined;
        return Promise.reject(err);
      }
      const record: AgentChannelIdentityRecord = {
        agentId: input.agentId,
        channelType: input.channelType,
        channelKey: input.channelKey,
        displayName: input.displayName ?? null,
        externalRef: input.externalRef ?? null,
        createdAt: new Date('2026-11-20T10:00:00Z'),
        updatedAt: new Date('2026-11-20T10:00:00Z'),
      };
      store.rows.push(record);
      return Promise.resolve(record);
    },
    delete: (agentId: string, channelType: string) => {
      const before = store.rows.length;
      store.rows = store.rows.filter((r) => !(r.agentId === agentId && r.channelType === channelType));
      return Promise.resolve(store.rows.length < before);
    },
  };
  return store;
}

function telegram(over: Partial<AgentIdentityProvider> = {}): AgentIdentityProvider & { identified: AgentIdentityProvisionInput[]; provisioned: AgentIdentityProvisionInput[]; provisionedKeys: string[]; released: string[] } {
  const provider = {
    channelType: 'telegram',
    fields: [{ key: 'bot_token', label: { en: 'Bot token' }, secret: true }],
    identified: [] as AgentIdentityProvisionInput[],
    provisioned: [] as AgentIdentityProvisionInput[],
    provisionedKeys: [] as string[],
    released: [] as string[],
    identify: (input: AgentIdentityProvisionInput) => {
      provider.identified.push(input);
      return Promise.resolve({ ok: true as const, channelKey: 'TG:7000000001', externalRef: '@mira_bot' });
    },
    provision: (input: AgentIdentityProvisionInput, key: string) => {
      provider.provisioned.push(input);
      provider.provisionedKeys.push(key);
      return Promise.resolve({ ok: true as const });
    },
    release: (key: string) => {
      provider.released.push(key);
      return Promise.resolve();
    },
    status: () => Promise.resolve({ state: 'running' as const }),
    defaultChannelKey: () => 'tg:6999999999',
    ...over,
  };
  return provider;
}

function harness(provider = telegram()) {
  const store = memoryStore();
  const logs: string[] = [];
  let reloads = 0;
  const service = createAgentChannelIdentityService({
    providers: { get: (t) => (t === provider.channelType ? provider : undefined), types: () => [provider.channelType] },
    store,
    reload: () => {
      reloads += 1;
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
  });
  return { service, store, provider, logs, reloads: () => reloads };
}

describe('agent channel identities — provisioning', () => {
  it('hands the credentials to the plugin, stores only the lowercased key, reloads routing', async () => {
    const h = harness();
    const result = await h.service.provision(MIRA, 'telegram', { bot_token: ` ${TOKEN} ` });
    assert.equal(result.ok, true);
    assert.deepEqual(h.provider.provisioned[0]?.credentials, { bot_token: TOKEN });
    assert.deepEqual(h.provider.provisionedKeys, ['tg:7000000001'], 'provision is told the key identify named');
    assert.equal(h.provider.provisioned[0]?.agentDisplayName, 'Mira');
    assert.equal(h.store.rows[0]?.channelKey, 'tg:7000000001');
    assert.equal(h.store.rows[0]?.externalRef, '@mira_bot');
    assert.equal(JSON.stringify(h.store.inserted).includes(TOKEN), false, 'no credential reaches the store');
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'no credential in the response');
    assert.equal(h.logs.join('\n').includes(TOKEN), false, 'no credential in the log');
    assert.equal(h.reloads(), 1);
  });

  it('refuses unknown and missing fields before the plugin is called', async () => {
    const h = harness();
    assert.equal((await h.service.provision(MIRA, 'telegram', {})).ok, false);
    assert.equal((await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN, extra: 'x' })).ok, false);
    assert.equal((await h.service.provision(MIRA, 'telegram', 'token')).ok, false);
    assert.equal(h.provider.identified.length, 0);
    assert.equal(h.provider.provisioned.length, 0);
  });

  it('refuses a channel without an active plugin', async () => {
    const h = harness();
    const result = await h.service.provision(MIRA, 'discord', { bot_token: TOKEN });
    assert.deepEqual(result.ok ? null : [result.status, result.error], [404, 'channel_not_available']);
  });

  it("refuses the plugin's default bot before the plugin does anything to it", async () => {
    const h = harness(telegram({ defaultChannelKey: () => 'tg:7000000001' }));
    const result = await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(result.ok ? null : [result.status, result.error], [409, 'already_in_use']);
    assert.equal(h.provider.provisioned.length, 0, 'not provisioned');
    assert.deepEqual(h.provider.released, []);
    assert.equal(h.store.rows.length, 0);
  });

  it("refuses another agent's bot before the plugin does anything to it", async () => {
    const h = harness();
    assert.equal((await h.service.provision(OTTO, 'telegram', { bot_token: TOKEN })).ok, true);
    const result = await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(result.ok ? null : [result.status, result.error], [409, 'bot_taken']);
    assert.equal(h.provider.provisioned.length, 1, 'only Otto’s provision ran');
    assert.deepEqual(h.provider.released, []);
  });

  it('refuses a second bot for the same agent and channel', async () => {
    const h = harness();
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    const result = await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(result.ok ? null : [result.status, result.error], [409, 'agent_has_identity']);
  });

  it('maps a plugin refusal and scrubs a credential it echoed', async () => {
    const h = harness(
      telegram({
        identify: () => Promise.resolve({ ok: false, code: 'invalid_credentials', message: `token ${TOKEN} was rejected` }),
      }),
    );
    const result = await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.equal(result.message.includes(TOKEN), false);
  });

  it('a plugin that throws is a 502 and its message never leaks the credential', async () => {
    const h = harness(telegram({ identify: () => Promise.reject(new Error(`boom ${TOKEN}`)) }));
    const result = await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(result.ok ? null : [result.status, result.error], [502, 'unreachable']);
    assert.equal(h.logs.join('\n').includes(TOKEN), false);
  });

  it('a failed store write stops the bot again', async () => {
    const h = harness();
    h.store.failNext = new Error('connection reset');
    await assert.rejects(h.service.provision(MIRA, 'telegram', { bot_token: TOKEN }));
    assert.deepEqual(h.provider.released, ['tg:7000000001']);
  });

  it('a race the database caught: the bot is kept when an agent owns it now, stopped when nobody does', async () => {
    const owned = harness();
    owned.store.failNext = new AgentChannelIdentityConflict('bot_taken', 'taken');
    const realOwner = owned.store.ownerOf;
    let calls = 0;
    owned.store.ownerOf = (type, key) => (calls++ === 0 ? realOwner(type, key) : Promise.resolve(OTTO.id));
    const a = await owned.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(a.ok ? null : [a.status, a.error], [409, 'bot_taken']);
    assert.deepEqual(owned.provider.released, [], 'another agent owns it now: kept');

    const orphan = harness();
    orphan.store.failNext = new AgentChannelIdentityConflict('agent_has_identity', 'has one');
    const b = await orphan.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(b.ok ? null : [b.status, b.error], [409, 'agent_has_identity']);
    assert.deepEqual(orphan.provider.released, ['tg:7000000001'], 'nobody owns it: stopped');
  });

  it('an unknown refusal code, a malformed answer and a throwing default key are handled', async () => {
    const unknown = harness(telegram({ identify: () => Promise.resolve({ ok: false, code: 'weird' as never, message: 'x' }) }));
    const a = await unknown.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual(a.ok ? null : [a.status, a.error], [502, 'unreachable']);
    const malformed = harness(telegram({ identify: () => Promise.resolve({ ok: true, channelKey: 42 } as never) }));
    const b = await malformed.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.equal(b.ok, false);
    assert.equal(malformed.provider.provisioned.length, 0);
    const throwing = harness(telegram({ defaultChannelKey: () => { throw new Error('not ready'); } }));
    assert.equal((await throwing.service.provision(MIRA, 'telegram', { bot_token: TOKEN })).ok, true);
  });

  it('names are capped before they are stored', async () => {
    const h = harness(telegram({ identify: () => Promise.resolve({ ok: true, channelKey: 'tg:1', externalRef: 'x'.repeat(500) }) }));
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.equal(h.store.rows[0]?.externalRef?.length, 200);
  });
});

describe('agent channel identities — removal and overview', () => {
  it('stops the bot first, then removes the row and reloads', async () => {
    const h = harness();
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    const result = await h.service.remove(MIRA, 'telegram');
    assert.equal(result.ok, true);
    assert.deepEqual(h.provider.released, ['tg:7000000001']);
    assert.equal(h.store.rows.length, 0);
    assert.equal(h.reloads(), 2);
  });

  it('keeps the row when the plugin cannot stop the bot', async () => {
    const h = harness(telegram({ release: () => Promise.reject(new Error('down')) }));
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    const result = await h.service.remove(MIRA, 'telegram');
    assert.deepEqual(result.ok ? null : [result.status, result.error], [502, 'unreachable']);
    assert.equal(h.store.rows.length, 1);
  });

  it('a release error is not logged with the plugin’s text (it may carry a credential)', async () => {
    const h = harness(telegram({ release: () => Promise.reject(new Error(`deleteWebhook on bot${TOKEN} failed`)) }));
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    await h.service.remove(MIRA, 'telegram');
    assert.equal(h.logs.join('\n').includes(TOKEN), false);
  });

  it('releaseAll stops every bot of an agent before a purge and reports what it could not', async () => {
    const h = harness();
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    await h.store.insert({ agentId: MIRA.id, channelType: 'slack', channelKey: 'slack-bot:u1' });
    const out = await h.service.releaseAll(MIRA.id);
    assert.deepEqual(out, { ok: true, failed: [], notReleased: ['slack:slack-bot:u1'] });
    assert.deepEqual(h.provider.released, ['tg:7000000001']);
    const failing = harness(telegram({ release: () => Promise.reject(new Error('down')) }));
    await failing.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    assert.deepEqual((await failing.service.releaseAll(MIRA.id)).failed, ['telegram:tg:7000000001']);
  });

  it('removes the row of an uninstalled plugin (nothing to stop)', async () => {
    const store = memoryStore();
    const service = createAgentChannelIdentityService({
      providers: { get: () => undefined, types: () => [] },
      store,
      reload: () => Promise.resolve(),
    });
    await store.insert({ agentId: MIRA.id, channelType: 'telegram', channelKey: 'tg:1' });
    const result = await service.remove(MIRA, 'telegram');
    assert.equal(result.ok && result.released, false);
    assert.equal(store.rows.length, 0);
  });

  it('lists channels with fields and the agent bot, including one whose plugin is inactive', async () => {
    const h = harness();
    await h.service.provision(MIRA, 'telegram', { bot_token: TOKEN });
    await h.store.insert({ agentId: MIRA.id, channelType: 'slack', channelKey: 'slack-bot:u1' });
    const { channels } = await h.service.overview(MIRA);
    assert.deepEqual(
      channels.map((c) => [c.channelType, c.fields.length, c.identity?.status.state]),
      [
        ['slack', 0, 'unknown'],
        ['telegram', 1, 'running'],
      ],
    );
  });
});

describe('credential helpers', () => {
  it('validateCredentials trims, drops empty optional fields and rejects non-strings', () => {
    const fields = [
      { key: 'token', label: { en: 'T' }, secret: true },
      { key: 'note', label: { en: 'N' }, secret: false, required: false },
    ];
    assert.deepEqual(validateCredentials(fields, { token: ' a ', note: '' }), { ok: true, credentials: { token: 'a' } });
    assert.equal(validateCredentials(fields, { token: 5 }).ok, false);
    assert.equal(validateCredentials(fields, { token: 'x'.repeat(5000) }).ok, false);
  });

  it('scrubCredentials also removes a URL-encoded credential (Telegram `:` as %3A or %3a)', () => {
    const token = '7000000001:AAfake-token_value';
    const text = `GET /bot7000000001%3AAAfake-token_value/getMe and /bot7000000001%3aAAfake-token_value`;
    assert.equal(scrubCredentials(text, { token }), 'GET /bot[redacted]/getMe and /bot[redacted]');
  });

  it('scrubCredentials removes every credential value', () => {
    assert.equal(scrubCredentials(`a ${TOKEN} b ${TOKEN}`, { t: TOKEN }), 'a [redacted] b [redacted]');
  });
});
