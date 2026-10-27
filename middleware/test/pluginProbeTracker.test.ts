/**
 * Issue #1453 — the per-runtime half of the connection probe.
 *
 * `PluginProbeTracker` is what both `ToolPluginRuntime` and
 * `DynamicAgentRuntime` hold: it reads a dynamically imported module's optional
 * `verifyConnection`, binds it to the plugin's context, keeps in-flight probes
 * observable, and makes the verdict sink fall silent once the plugin is gone.
 *
 * It exists as its own unit because the logic shipped twice, in two
 * near-identical copies — and only one of them was reachable from a test.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginActionStatus } from '@omadia/plugin-api';

import {
  PluginProbeTracker,
  credentialFingerprint,
  type ConnectionProbeStatusSink,
} from '../src/plugins/connectionProbe.js';

function statusSpy(): {
  readonly sink: ConnectionProbeStatusSink;
  readonly reports: PluginActionStatus[];
} {
  const reports: PluginActionStatus[] = [];
  return {
    reports,
    sink: {
      report(s: PluginActionStatus): void {
        reports.push(s);
      },
      clear(): void {
        /* not asserted here — see pluginConnectionProbe.test.ts */
      },
    },
  };
}

describe('PluginProbeTracker', () => {
  it('binds a module-level verifyConnection and hands it the plugin context', async () => {
    const spy = statusSpy();
    const seen: unknown[] = [];
    const ctx = { status: spy.sink, marker: 'the real context' };
    const tracker = new PluginProbeTracker({ isActive: () => true });

    const probe = tracker.bind(
      'p',
      {
        verifyConnection: (received: unknown) => {
          seen.push(received);
          return {
            status: 'rejected' as const,
            cause: 'http_401' as const,
            title: 'Nicht verbunden',
          };
        },
      },
      ctx,
    );
    assert.ok(probe, 'a module that exports verifyConnection must bind');

    const outcome = await tracker.run('p', probe);
    assert.equal(outcome.status, 'rejected');
    assert.deepEqual(seen, [ctx], 'the plugin gets its own context, unwrapped');
    assert.equal(spy.reports[0]?.state, 'error');
  });

  it('also finds verifyConnection on a default export', () => {
    const tracker = new PluginProbeTracker({ isActive: () => true });
    const probe = tracker.bind(
      'p',
      { default: { verifyConnection: () => ({ status: 'connected' as const }) } },
      { status: statusSpy().sink },
    );
    assert.ok(probe);
  });

  it('binds nothing for a module that declares no probe', () => {
    const tracker = new PluginProbeTracker({ isActive: () => true });
    assert.equal(
      tracker.bind('p', {}, { status: statusSpy().sink }),
      undefined,
    );
    assert.equal(
      // A non-function export is not a probe either.
      tracker.bind(
        'p',
        { verifyConnection: 'yes' as unknown as () => unknown },
        { status: statusSpy().sink },
      ),
      undefined,
    );
  });

  it('keeps a backgrounded probe observable until it settles', async () => {
    const spy = statusSpy();
    const tracker = new PluginProbeTracker({ isActive: () => true });
    const probe = tracker.bind(
      'p',
      {
        verifyConnection: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { status: 'rejected' as const, cause: 'http_401' as const };
        },
      },
      { status: spy.sink },
    );
    assert.ok(probe);

    tracker.start('p', probe);
    assert.deepEqual(spy.reports, [], 'start() must not block on the probe');

    await tracker.settled();
    assert.equal(spy.reports.length, 1);
    await tracker.settled(); // idempotent once nothing is in flight
  });

  it('drops a verdict that arrives after the plugin stopped being active', async () => {
    const spy = statusSpy();
    let active = true;
    const tracker = new PluginProbeTracker({ isActive: () => active });
    const probe = tracker.bind(
      'p',
      {
        verifyConnection: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { status: 'rejected' as const, cause: 'http_401' as const };
        },
      },
      { status: spy.sink },
    );
    assert.ok(probe);

    tracker.start('p', probe);
    active = false; // deactivate() landed while the probe was in flight
    await tracker.settled();

    assert.deepEqual(
      spy.reports,
      [],
      'a deactivated plugin must not get a badge back',
    );
  });
});

describe('credentialFingerprint', () => {
  function vault(values: Record<string, string>) {
    return {
      listKeys: async (): Promise<string[]> => Object.keys(values),
      get: async (_id: string, key: string): Promise<string | undefined> =>
        values[key],
    };
  }

  it('is stable across calls and independent of key order', async () => {
    const a = await credentialFingerprint(vault({ api_key: 'k1', url: 'u' }), 'p');
    const b = await credentialFingerprint(vault({ url: 'u', api_key: 'k1' }), 'p');
    assert.equal(a, b);
    assert.ok(a);
  });

  it('changes when a value changes', async () => {
    const before = await credentialFingerprint(vault({ api_key: 'k1' }), 'p');
    const after = await credentialFingerprint(vault({ api_key: 'falsch-1234' }), 'p');
    assert.notEqual(before, after);
  });

  it('changes when a key is added or removed', async () => {
    const one = await credentialFingerprint(vault({ api_key: 'k1' }), 'p');
    const two = await credentialFingerprint(
      vault({ api_key: 'k1', extra: '' }),
      'p',
    );
    assert.notEqual(one, two);
  });

  it('never contains the secret itself', async () => {
    const fp = await credentialFingerprint(vault({ api_key: 'super-secret' }), 'p');
    assert.ok(fp);
    assert.equal(fp.includes('super-secret'), false);
  });

  it('is undefined when there are no credentials to fingerprint', async () => {
    assert.equal(await credentialFingerprint(vault({}), 'p'), undefined);
  });

  it('is undefined when the vault fails, so nothing gets cached', async () => {
    const broken = {
      listKeys: async (): Promise<string[]> => {
        throw new Error('vault locked');
      },
      get: async (): Promise<undefined> => undefined,
    };
    assert.equal(await credentialFingerprint(broken, 'p'), undefined);
  });

  // The non-secret half of the credential surface. odoo's `url`/`db`/`login`
  // are plain config, written through `PATCH /installed/:id/config` — which
  // reactivates. A fingerprint blind to them re-serves the cached `rejected`
  // after the operator has already repaired the host.
  it('changes when a non-secret config value changes', async () => {
    const v = vault({ api_key: 'k1' });
    const wrong = await credentialFingerprint(v, 'p', {
      url: 'https://wrong.example',
      db: 'prod',
    });
    const fixed = await credentialFingerprint(v, 'p', {
      url: 'https://right.example',
      db: 'prod',
    });
    assert.ok(wrong);
    assert.notEqual(wrong, fixed);
  });

  it('is independent of config key order and nested key order', async () => {
    const v = vault({ api_key: 'k1' });
    const a = await credentialFingerprint(v, 'p', {
      url: 'u',
      opts: { b: 1, a: [1, 2] },
    });
    const b = await credentialFingerprint(v, 'p', {
      opts: { a: [1, 2], b: 1 },
      url: 'u',
    });
    assert.equal(a, b);
    assert.ok(a);
  });

  it('changes when a config key is added or cleared', async () => {
    const v = vault({ api_key: 'k1' });
    const withKey = await credentialFingerprint(v, 'p', { url: 'u' });
    const without = await credentialFingerprint(v, 'p', {});
    assert.notEqual(withKey, without);
  });

  it('fingerprints a plugin that has config but no secrets', async () => {
    const fp = await credentialFingerprint(vault({}), 'p', { url: 'u' });
    assert.ok(fp);
  });

  it('does not confuse a vault entry with a config field of the same name', async () => {
    const asSecret = await credentialFingerprint(vault({ url: 'u' }), 'p', {});
    const asConfig = await credentialFingerprint(vault({}), 'p', { url: 'u' });
    assert.notEqual(asSecret, asConfig);
  });
});
