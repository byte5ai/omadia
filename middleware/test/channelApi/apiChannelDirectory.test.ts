import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createApiChannelDirectory } from '../../packages/harness-channel-api/src/apiChannelDirectory.js';
import { createFakeSecrets } from './testSecrets.js';

/**
 * #1106 finding #1 — the Public API channel now contributes a
 * `ChannelKeyDirectory` so `/operator/channels` lists one bindable row per
 * active API key. These tests pin the directory contract directly (the
 * registry aggregation + REST surface are exercised in
 * `channelDirectoryMembers.test.ts` / `operatorChannels*` tests).
 */
describe('channelApi/apiChannelDirectory', () => {
  const CHANNEL_TYPE = '@omadia/channel-api';
  const ORIGIN = '@omadia/channel-api';

  it('advertises the channel type and origin plugin for the dashboard', () => {
    const apiKeys = createApiKeyStore(createFakeSecrets());
    const directory = createApiChannelDirectory({
      apiKeys,
      channelType: CHANNEL_TYPE,
      originPluginId: ORIGIN,
    });
    assert.equal(directory.channelType, CHANNEL_TYPE);
    assert.equal(directory.originPluginId, ORIGIN);
  });

  it('lists one entry per active key, keyed by `key:<uuid>` (the routing selector)', async () => {
    const apiKeys = createApiKeyStore(createFakeSecrets());
    const alpha = await apiKeys.create({ label: 'alpha' });
    const beta = await apiKeys.create({ label: 'beta' });

    const directory = createApiChannelDirectory({
      apiKeys,
      channelType: CHANNEL_TYPE,
      originPluginId: ORIGIN,
    });
    const entries = await directory.listKeys();

    assert.equal(entries.length, 2);
    // The key IS the value the router now sets as `IncomingTurn.channelKey`,
    // so binding this row routes real turns (see chatRouter.ts #1106).
    const byKey = new Map(entries.map((e) => [e.key, e]));
    assert.ok(byKey.has(`key:${alpha.record.id}`), 'alpha listed by key:<uuid>');
    assert.ok(byKey.has(`key:${beta.record.id}`), 'beta listed by key:<uuid>');
    assert.equal(byKey.get(`key:${alpha.record.id}`)?.label, 'alpha');
    assert.equal(byKey.get(`key:${beta.record.id}`)?.label, 'beta');
  });

  it('omits revoked keys — a revoked key is no longer bindable', async () => {
    const apiKeys = createApiKeyStore(createFakeSecrets());
    const live = await apiKeys.create({ label: 'live' });
    const dead = await apiKeys.create({ label: 'dead' });
    await apiKeys.revoke(dead.record.id);

    const directory = createApiChannelDirectory({
      apiKeys,
      channelType: CHANNEL_TYPE,
      originPluginId: ORIGIN,
    });
    const entries = await directory.listKeys();

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.key, `key:${live.record.id}`);
  });

  it('falls back to a self-describing label when a key has none', async () => {
    const apiKeys = createApiKeyStore(createFakeSecrets());
    const created = await apiKeys.create({});

    const directory = createApiChannelDirectory({
      apiKeys,
      channelType: CHANNEL_TYPE,
      originPluginId: ORIGIN,
    });
    const [entry] = await directory.listKeys();

    // No operator label — the row must still be distinguishable from its
    // neighbours without reading the opaque key.
    assert.ok(entry);
    assert.notEqual(entry.label.trim(), '');
    assert.match(entry.label, new RegExp(created.record.id.slice(0, 8)));
  });
});
