import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NotificationRouter } from '../src/platform/notificationRouter.js';

describe('NotificationRouter', () => {
  it('fans out to every registered channel and reports delivered', async () => {
    const router = new NotificationRouter();
    const seen: { channel: string; pluginId: string; title: string }[] = [];
    router.registerChannel('teams', async (p) => {
      seen.push({ channel: 'teams', pluginId: p.pluginId, title: p.title });
    });
    router.registerChannel('telegram', async (p) => {
      seen.push({ channel: 'telegram', pluginId: p.pluginId, title: p.title });
    });

    const result = await router.dispatch('@omadia/test-plugin', {
      title: 'Hello',
      body: 'World',
    });

    assert.deepEqual(result.delivered, ['teams', 'telegram']);
    assert.equal(result.failed.length, 0);
    assert.equal(result.anyHandlerPresent, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.pluginId, '@omadia/test-plugin');
    assert.equal(seen[1]?.pluginId, '@omadia/test-plugin');
  });

  it('reports failed channels but still delivers the others', async () => {
    const router = new NotificationRouter();
    router.registerChannel('boom', async () => {
      throw new Error('handler exploded');
    });
    router.registerChannel('ok', async () => {
      /* succeed */
    });

    const result = await router.dispatch('@plugin/x', { title: 't', body: 'b' });
    assert.deepEqual(result.delivered, ['ok']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.channelId, 'boom');
    assert.equal(result.failed[0]?.error, 'handler exploded');
  });

  it('anyHandlerPresent=false when nothing is registered', async () => {
    const router = new NotificationRouter();
    const result = await router.dispatch('@plugin/x', { title: 't', body: 'b' });
    assert.equal(result.anyHandlerPresent, false);
    assert.equal(result.delivered.length, 0);
    assert.equal(result.failed.length, 0);
  });

  it('default recipients=broadcast is injected for handlers', async () => {
    const router = new NotificationRouter();
    let captured: { recipients: 'broadcast' | readonly string[] } | undefined;
    router.registerChannel('teams', async (p) => {
      captured = { recipients: p.recipients };
    });
    await router.dispatch('@plugin/x', { title: 't', body: 'b' });
    assert.equal(captured?.recipients, 'broadcast');
  });

  it('caller-supplied recipients list reaches the handler unchanged', async () => {
    const router = new NotificationRouter();
    let captured: readonly string[] | 'broadcast' | undefined;
    router.registerChannel('teams', async (p) => {
      captured = p.recipients;
    });
    await router.dispatch('@plugin/x', {
      title: 't',
      body: 'b',
      recipients: ['user-1', 'user-2'],
    });
    assert.deepEqual(captured, ['user-1', 'user-2']);
  });

  it('re-registering the same channel throws (forces explicit dispose)', () => {
    const router = new NotificationRouter();
    router.registerChannel('teams', async () => {});
    assert.throws(
      () => router.registerChannel('teams', async () => {}),
      /already has a notification handler/,
    );
  });

  it('dispose handle removes the registration', async () => {
    const router = new NotificationRouter();
    const dispose = router.registerChannel('teams', async () => {});
    assert.deepEqual(router.list(), ['teams']);
    dispose();
    assert.deepEqual(router.list(), []);
    // Re-register works after dispose:
    router.registerChannel('teams', async () => {});
    assert.deepEqual(router.list(), ['teams']);
  });

  it('stale dispose from previous registration does not unregister the new owner', () => {
    const router = new NotificationRouter();
    const disposeA = router.registerChannel('teams', async () => {});
    disposeA(); // teams removed
    router.registerChannel('teams', async () => {}); // new owner
    disposeA(); // stale closure — must be a no-op
    assert.deepEqual(
      router.list(),
      ['teams'],
      'new owner survives a stale dispose call',
    );
  });

  it('rejects empty channelId and non-function handler', () => {
    const router = new NotificationRouter();
    assert.throws(
      () => router.registerChannel('', async () => {}),
      /non-empty string/,
    );
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => router.registerChannel('teams', undefined as any),
      /must be a function/,
    );
  });
});
