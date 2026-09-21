import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { CoreApi, ChannelKeyDirectory } from '../../packages/harness-channel-sdk/src/index.js';
import type { PluginContext, SecretsAccessor } from '../../packages/plugin-api/src/index.js';
import { API_PREFIX, activate } from '../../packages/harness-channel-api/src/plugin.js';
import { createFakeSecrets } from './testSecrets.js';

/** Records the ChannelKeyDirectory register/unregister calls the plugin makes
 *  against the kernel's `channelDirectoryRegistry` service (#1106). */
interface FakeDirectoryRegistry {
  registered: ChannelKeyDirectory[];
  unregistered: string[];
  register(directory: ChannelKeyDirectory): void;
  unregister(channelType: string): void;
}

function makeDirectoryRegistry(): FakeDirectoryRegistry {
  const reg: FakeDirectoryRegistry = {
    registered: [],
    unregistered: [],
    register(directory) {
      reg.registered.push(directory);
    },
    unregister(channelType) {
      reg.unregistered.push(channelType);
    },
  };
  return reg;
}

/** Mirrors `test/uiChannelPlugin.test.ts`'s `makeMocks()` for the sibling
 *  `@omadia/ui-channel` package, adapted to `registerRouter` instead of a
 *  single `registerRoute`. When `directoryRegistry` is supplied, it is served
 *  via `ctx.services.getOptional('channelDirectoryRegistry')`; when omitted,
 *  `getOptional` returns undefined (a kernel that doesn't publish it). */
function makeMocks(secrets: SecretsAccessor, directoryRegistry?: FakeDirectoryRegistry) {
  const ctx = {
    agentId: '@omadia/channel-api',
    log: () => {},
    secrets,
    services: {
      getOptional<T>(name: string): T | undefined {
        return name === 'channelDirectoryRegistry'
          ? (directoryRegistry as unknown as T | undefined)
          : undefined;
      },
    },
  } as unknown as PluginContext;
  const captured: { channelId?: string; prefix?: string; router?: unknown } = {};
  const core = {
    registerRouter: (channelId: string, prefix: string, router: unknown) => {
      captured.channelId = channelId;
      captured.prefix = prefix;
      captured.router = router;
    },
  } as unknown as CoreApi;
  return { ctx, core, captured };
}

describe('@omadia/channel-api activate', () => {
  it('mounts one router at /api/public/v1, scoped to its own channelId', async () => {
    const { ctx, core, captured } = makeMocks(createFakeSecrets());
    const handle = await activate(ctx, core);
    assert.equal(captured.channelId, '@omadia/channel-api');
    assert.equal(captured.prefix, API_PREFIX);
    assert.ok(captured.router, 'a router was registered');
    assert.ok(handle.close, 'returns a closeable handle');
    await handle.close();
  });

  it('contributes a ChannelKeyDirectory for its channel type, and retracts it on close (#1106)', async () => {
    const registry = makeDirectoryRegistry();
    const { ctx, core } = makeMocks(createFakeSecrets(), registry);
    const handle = await activate(ctx, core);

    assert.equal(registry.registered.length, 1, 'one directory registered');
    assert.equal(
      registry.registered[0]?.channelType,
      '@omadia/channel-api',
      'directory channel_type matches what the dispatcher derives from the channelId',
    );
    assert.equal(registry.registered[0]?.originPluginId, '@omadia/channel-api');

    await handle.close();
    assert.deepEqual(
      registry.unregistered,
      ['@omadia/channel-api'],
      'the directory is retracted on deactivate',
    );
  });

  it('activates without a directory registry (kernel does not publish it) — routing still works', async () => {
    // No registry supplied → getOptional returns undefined. activate() must
    // not throw and must still mount the router.
    const { ctx, core, captured } = makeMocks(createFakeSecrets());
    const handle = await activate(ctx, core);
    assert.ok(captured.router, 'router still mounted without the directory service');
    await handle.close();
  });

  it('degrades to inert (no router mounted) when ctx.secrets has no write access', async () => {
    // A read-only accessor — as a plugin gets when the manifest is missing
    // permissions.secrets.runtime_write. activate() must not throw; it must
    // simply not mount the routes (see the doc comment in plugin.ts).
    const readOnlySecrets: SecretsAccessor = {
      async get() {
        return undefined;
      },
      async require(key: string) {
        throw new Error(`missing ${key}`);
      },
      async keys() {
        return [];
      },
    };
    const { ctx, core, captured } = makeMocks(readOnlySecrets);
    const handle = await activate(ctx, core);
    assert.equal(captured.router, undefined, 'no router registered without write access');
    await handle.close();
  });
});
