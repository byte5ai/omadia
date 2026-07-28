import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { DeviceFlowStore } from '../../src/issues/deviceFlowStore.js';
import type { DevPlatformDeviceFlow } from '../../src/routes/devPlatformShared.js';
import { authHeaders, makeHarness, postJson } from './devPlatformRoutes.harness.js';

/**
 * Epic #470 — composition-root wiring regression (GAP 2).
 *
 * `POST /github/connect/start` 503s with `devplatform.device_flow_unconfigured`
 * UNLESS a `deviceFlow` dep is threaded into the router. The bug this fixes was
 * exactly that: index.ts called `assembleDevPlatform(...)` with NO `deviceFlow`
 * key, so PAT was the only working credential path and the device-flow card
 * always 503'd. index.ts now constructs the provider + store and supplies it via
 * conditional spread. These tests pin BOTH sides of the gate so a future refactor
 * that drops the `deviceFlow` wiring fails loudly here rather than in production.
 */

function fakeDeviceFlow(): DevPlatformDeviceFlow {
  const provider: DevPlatformDeviceFlow['provider'] = {
    requestDeviceCode: async () => ({
      // The device_code is the secret half — the route keeps it server-side.
      deviceCode: 'dc-secret-stays-server-side',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    }),
    pollAccessToken: async () => ({ status: 'pending' }),
    fetchUserLogin: async () => 'octocat',
  };
  return { provider, store: new DeviceFlowStore() };
}

describe('devPlatform device-flow wiring (epic #470 GAP 2)', () => {
  it('503s device_flow_unconfigured when no deviceFlow dep is supplied (the pre-fix state)', async () => {
    const h = await makeHarness();
    after(() => h.close());

    const res = await postJson(`${h.baseUrl}/github/connect/start`, authHeaders('alice'), {});

    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'devplatform.device_flow_unconfigured');
  });

  it('returns the device code (never the secret device_code) when deviceFlow is threaded in', async () => {
    const h = await makeHarness({ deviceFlow: fakeDeviceFlow() });
    after(() => h.close());

    const res = await postJson(`${h.baseUrl}/github/connect/start`, authHeaders('alice'), {});

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.userCode, 'WXYZ-1234');
    assert.equal(body.verificationUri, 'https://github.com/login/device');
    assert.equal(body.expiresIn, 900);
    assert.equal(body.interval, 5);
    // The secret half must never cross the wire.
    assert.equal(body.deviceCode, undefined);
  });
});
