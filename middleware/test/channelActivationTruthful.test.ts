import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DefaultChannelRegistry } from '../src/channels/channelRegistry.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

/**
 * #1452 — a channel's activation outcome has to reach the installed registry.
 *
 * `channelRegistry` was the one runtime that recorded nothing: not on success,
 * not on failure, and not in the boot loop — so for `kind: channel` the
 * circuit breaker never tripped either, and a channel that failed to come up
 * read `active` forever. That became load-bearing once the upload path started
 * flipping entries to `errored` (the update seam): without a boot-time
 * correction, a channel left `errored` by a failed hot-swap would come up fine
 * on the next boot — `activateAllInstalled` activates channels regardless of
 * status — and still read `errored` in the store, in readiness and in the admin
 * runtime route, with a stale error, forever.
 *
 * So both directions are pinned here: the boot loop lifts a stale `errored`
 * when the channel comes up, and records the reason when it does not.
 *
 * "Does not come up" includes the quiet case: `activate()` warns and returns
 * when the resolver yields no usable `ChannelPlugin` (a broken export in a
 * freshly uploaded package), which is why the loop asserts `isActive` instead
 * of trusting a normal return.
 */

const CHANNEL_ID = '@test/channel-truthful';

const manifest = {
  schema_version: '1',
  identity: { id: CHANNEL_ID, kind: 'channel', domain: 'channel.test' },
};

function makeRegistry(
  installedRegistry: InMemoryInstalledRegistry,
  resolve: () => Promise<unknown>,
): DefaultChannelRegistry {
  const noop = (): void => undefined;
  const unsub = (): (() => void) => () => undefined;
  const entry = {
    plugin: {
      kind: 'channel',
      domain: 'channel.test',
      depends_on: [],
      permissions_summary: {},
      setup_fields: [],
      integrations_summary: [],
      provides: [],
      requires: [],
      jobs: [],
    },
    manifest,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    catalog: {
      get: () => entry,
      has: () => true,
      list: () => [entry],
      isBundledId: () => false,
    },
    installedRegistry,
    vault: { get: noop, set: noop, list: () => [] },
    serviceRegistry: { get: () => undefined, has: () => false, provide: unsub, replace: unsub },
    nativeToolRegistry: { register: noop, unregister: noop, list: () => [] },
    pluginRouteRegistry: { register: noop, deactivate: noop },
    notificationRouter: { registerChannel: unsub },
    uiRouteCatalog: { disposeBySource: noop },
    jobScheduler: { stopForPlugin: noop },
    pluginStatusRegistry: { clear: noop },
    resolver: { resolve, invalidate: noop },
    coreApi: { log: noop, registerRoute: noop, registerRouter: noop },
    routes: { setActive: noop, deactivateChannel: noop },
    webSockets: { setActive: noop, deactivateChannel: noop },
  };
  return new DefaultChannelRegistry(deps);
}

/** A channel the upload seam left `errored` after a failed hot-swap. */
async function erroredEntry(): Promise<InMemoryInstalledRegistry> {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: CHANNEL_ID,
    installed_version: '0.2.0',
    installed_at: '2026-10-01T00:00:00.000Z',
    status: 'errored',
    config: {},
    activation_failure_count: 1,
    last_activation_error: 'the package exports no usable ChannelPlugin',
    last_activation_error_at: '2026-10-25T00:00:00.000Z',
  });
  return registry;
}

void describe('channel activation reaches the installed registry (#1452)', () => {
  void it('lifts a stale errored entry when the channel comes up at boot', async () => {
    const installed = await erroredEntry();
    const channels = makeRegistry(installed, async () => ({
      activate: async () => ({ close: async () => undefined }),
    }));

    await channels.activateAllInstalled();

    const entry = installed.get(CHANNEL_ID);
    assert.equal(entry?.status, 'active', 'the channel is running, so the entry must say so');
    assert.equal(entry?.last_activation_error, undefined);
    assert.ok(entry?.last_activated_at, 'and the successful activation is stamped');
  });

  void it('records the reason when the channel does not come up at boot', async () => {
    const installed = await erroredEntry();
    const channels = makeRegistry(installed, async () => undefined);

    await channels.activateAllInstalled();

    const entry = installed.get(CHANNEL_ID);
    assert.equal(entry?.status, 'errored');
    assert.equal(entry?.activation_failure_count, 2, 'the attempt is counted');
    assert.match(String(entry?.last_activation_error), /ChannelPlugin/);
  });
});
