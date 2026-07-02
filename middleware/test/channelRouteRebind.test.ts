import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express, { type Express } from 'express';

import { ExpressRouteRegistry } from '../src/channels/routeRegistry.js';

/** Regression coverage for #395: a plugin hot-reinstall must rebind the
 *  inbound handler in place, not serve the stale first-mounted route. */
describe('ExpressRouteRegistry · hot-reinstall handler rebind (#395)', () => {
  let app: Express;
  let registry: ExpressRouteRegistry;
  let baseUrl: string;
  let server: ReturnType<Express['listen']>;

  const CHANNEL = '@test/channel-395';
  const PATH = '/api/test-395/messages';

  before(async () => {
    app = express();
    app.use(express.json());
    registry = new ExpressRouteRegistry(app);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server.close();
  });

  const post = async (): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: res.status, body: await res.json() };
  };

  it('serves the freshly-registered handler after a re-registration', async () => {
    registry.register(CHANNEL, 'POST', PATH, (_req, res) => {
      res.json({ version: 'v1' });
    });
    registry.setActive(CHANNEL, true);
    assert.deepEqual((await post()).body, { version: 'v1' });

    // Hot reinstall → v2: deactivate, then re-register with the new handler.
    registry.deactivateChannel(CHANNEL);
    registry.register(CHANNEL, 'POST', PATH, (_req, res) => {
      res.json({ version: 'v2' });
    });
    registry.setActive(CHANNEL, true);

    assert.deepEqual(
      (await post()).body,
      { version: 'v2' },
      'inbound handler must serve the reinstalled module, not the stale one',
    );
  });

  it('does not stack a second Express route on re-registration', async () => {
    const mountsFor = () =>
      registry.describe().filter((r) => r.path === PATH && r.method === 'POST');
    assert.equal(mountsFor().length, 1, 'exactly one mount before re-register');
    registry.register(CHANNEL, 'POST', PATH, (_req, res) => {
      res.json({ version: 'v3' });
    });
    assert.equal(mountsFor().length, 1, 'still one mount after re-register');
    assert.deepEqual((await post()).body, { version: 'v3' });
  });

  it('rejects a different channel claiming an already-owned path/prefix', () => {
    assert.throws(
      () =>
        registry.register('@test/other-channel', 'POST', PATH, (_req, res) => {
          res.json({ version: 'intruder' });
        }),
      /already owned by channel '@test\/channel-395'/,
    );

    const PREFIX = '/api/test-395-router';
    registry.registerRouter(CHANNEL, PREFIX, express.Router());
    assert.throws(
      () => registry.registerRouter('@test/other-channel', PREFIX, express.Router()),
      /already owned by channel '@test\/channel-395'/,
    );
    // Same channel re-registering (hot-reinstall) must not throw.
    assert.doesNotThrow(() =>
      registry.registerRouter(CHANNEL, PREFIX, express.Router()),
    );
  });

  it('gates a deactivated channel with 503 until re-activation', async () => {
    registry.deactivateChannel(CHANNEL);
    const down = await post();
    assert.equal(down.status, 503);
    assert.equal((down.body as { code?: string }).code, 'channel.inactive');

    registry.setActive(CHANNEL, true);
    const up = await post();
    assert.equal(up.status, 200);
  });
});
