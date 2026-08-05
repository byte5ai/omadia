import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { CoreApi } from '../../packages/harness-channel-sdk/src/index.js';
import type { PluginContext, SecretsAccessor } from '../../packages/plugin-api/src/index.js';
import { API_PREFIX, activate } from '../../packages/harness-channel-api/src/plugin.js';
import { createFakeSecrets } from './testSecrets.js';

/** Mirrors `test/uiChannelPlugin.test.ts`'s `makeMocks()` for the sibling
 *  `@omadia/ui-channel` package, adapted to `registerRouter` instead of a
 *  single `registerRoute`. */
function makeMocks(secrets: SecretsAccessor) {
  const ctx = {
    agentId: '@omadia/channel-api',
    log: () => {},
    secrets,
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
