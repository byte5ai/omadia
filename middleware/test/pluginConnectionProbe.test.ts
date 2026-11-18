/**
 * Issue #1453 — kernel-run connection probe.
 *
 * The seam under test is `runConnectionProbe()`: it takes a plugin's optional
 * `verifyConnection` export, bounds it, and translates its verdict into the
 * operator-facing `ctx.status` channel. The rules it has to hold are the ones
 * `providerCredentialVerifier.ts` paid for on the LLM side — only an explicit
 * credential rejection may read as "broken", everything else is inconclusive —
 * plus one this layer adds: a probe must never be able to fail an activation.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginActionStatus } from '@omadia/plugin-api';

import {
  CONNECTION_PROBE_CACHE_TTL_MS,
  __clearConnectionProbeCache,
  runConnectionProbe,
  type ConnectionProbeOutcome,
} from '../src/plugins/connectionProbe.js';

/** Captures what the probe pushed into the status sink, in order. */
function recordingStatus(): {
  readonly status: { report(s: PluginActionStatus): void; clear(): void };
  readonly reports: PluginActionStatus[];
  readonly clears: number[];
} {
  const reports: PluginActionStatus[] = [];
  const clears: number[] = [];
  return {
    reports,
    clears,
    status: {
      report(s: PluginActionStatus): void {
        reports.push(s);
      },
      clear(): void {
        clears.push(1);
      },
    },
  };
}

describe('runConnectionProbe', () => {
  it('maps a rejected verdict to an error status carrying the plugin’s own copy', async () => {
    const rec = recordingStatus();

    const outcome = await runConnectionProbe({
      pluginId: '@omadia/integration-odoo',
      status: rec.status,
      verify: () => ({
        status: 'rejected' as const,
        cause: 'protocol_auth_failure' as const,
        title: 'Nicht verbunden',
        detail: 'Odoo hat den API-Key abgelehnt',
      }),
    });

    assert.equal(outcome.status, 'rejected');
    assert.equal(rec.reports.length, 1);
    assert.equal(rec.reports[0]?.state, 'error');
    assert.equal(rec.reports[0]?.title, 'Nicht verbunden');
    assert.equal(rec.reports[0]?.detail, 'Odoo hat den API-Key abgelehnt');
  });

  it('maps a connected verdict with a title to a positive status', async () => {
    const rec = recordingStatus();

    const outcome = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => ({ status: 'connected' as const, title: 'Verbunden' }),
    });

    assert.equal(outcome.status, 'connected');
    assert.deepEqual(rec.reports, [{ state: 'ok', title: 'Verbunden' }]);
  });

  it('clears a stale verdict when a connected probe carries no copy of its own', async () => {
    // The re-probe path (POST .../verify) runs without a deactivation, so a
    // previous `error` would otherwise outlive the key that fixed it.
    const rec = recordingStatus();

    await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => ({ status: 'connected' as const }),
    });

    assert.equal(rec.reports.length, 0);
    assert.equal(rec.clears.length, 1);
  });

  it('leaves the operator’s status untouched for every inconclusive case', async () => {
    const cases: Array<{ label: string; verify: () => unknown }> = [
      { label: 'declared inconclusive', verify: () => ({ status: 'inconclusive' }) },
      {
        label: 'threw',
        verify: () => {
          throw new Error('ECONNREFUSED');
        },
      },
      { label: 'returned nothing', verify: () => undefined },
      { label: 'returned a bare boolean', verify: () => true },
      { label: 'returned an unknown status', verify: () => ({ status: 'maybe' }) },
    ];

    for (const c of cases) {
      const rec = recordingStatus();
      const outcome = await runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        verify: c.verify,
      });
      assert.equal(outcome.status, 'inconclusive', c.label);
      assert.equal(rec.reports.length, 0, c.label);
      assert.equal(rec.clears.length, 0, c.label);
    }
  });

  it('reports the reason a probe produced no verdict', async () => {
    const rec = recordingStatus();

    const threw = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => {
        throw new Error('boom');
      },
    });
    assert.equal(threw.reason, 'threw');

    const malformed = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => 'connected',
    });
    assert.equal(malformed.reason, 'malformed');
  });

  it('gives up on a probe that never answers, without failing', async () => {
    const rec = recordingStatus();
    const started = Date.now();

    const outcome = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      timeoutMs: 25,
      verify: () => new Promise(() => {
        /* never settles — the target accepted the TCP connection and went away */
      }),
    });

    assert.equal(outcome.status, 'inconclusive');
    assert.equal(outcome.reason, 'timed_out');
    assert.equal(rec.reports.length, 0);
    assert.ok(Date.now() - started < 2_000);
  });

  it('survives a status sink that throws', async () => {
    // `ctx.status.report` reaches an in-memory registry, but the probe runs on
    // the activation path: a diagnostic must not be able to take down the
    // plugin it diagnoses.
    const outcome = await runConnectionProbe({
      pluginId: 'p',
      status: {
        report(): void {
          throw new Error('registry gone');
        },
        clear(): void {
          throw new Error('registry gone');
        },
      },
      verify: () => ({ status: 'rejected' as const, cause: 'http_401' as const }),
    });

    assert.equal(outcome.status, 'rejected');
  });
});

describe('runConnectionProbe — core-enforced rejection rules (#1453)', () => {
  it('demotes a rejection that names no cause', async () => {
    // The lazy shape this guard exists for:
    //   catch { return { status: 'rejected' } }
    // Core cannot see the exchange, but it can refuse to paint an outage red
    // on the plugin's unexplained word.
    const rec = recordingStatus();

    const outcome = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => ({ status: 'rejected' as const, title: 'Nicht verbunden' }),
    });

    assert.equal(outcome.status, 'inconclusive');
    assert.equal(outcome.reason, 'unexplained_rejection');
    assert.deepEqual(rec.reports, [], 'nothing may turn red on this');
  });

  it('demotes a rejection whose cause this kernel does not know', async () => {
    const rec = recordingStatus();
    const outcome = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => ({ status: 'rejected' as const, cause: 'vibes' }),
    });
    assert.equal(outcome.status, 'inconclusive');
    assert.equal(outcome.reason, 'unexplained_rejection');
  });

  it('accepts every cause the contract names', async () => {
    for (const cause of ['http_401', 'http_403_auth', 'protocol_auth_failure'] as const) {
      const rec = recordingStatus();
      const outcome = await runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        verify: () => ({ status: 'rejected' as const, cause }),
      });
      assert.equal(outcome.status, 'rejected', cause);
      assert.equal(outcome.cause, cause);
      assert.equal(rec.reports[0]?.state, 'error', cause);
    }
  });

  it('ignores a cause on a verdict that is not a rejection', async () => {
    const rec = recordingStatus();
    const outcome = await runConnectionProbe({
      pluginId: 'p',
      status: rec.status,
      verify: () => ({ status: 'connected' as const, cause: 'http_401', title: 'Verbunden' }),
    });
    assert.equal(outcome.status, 'connected');
    assert.equal(outcome.cause, undefined);
    assert.equal(rec.reports[0]?.state, 'ok');
  });
});

describe('runConnectionProbe — verdict cache (#1453)', () => {
  it('skips a second probe for the same credential inside the TTL', async () => {
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    let calls = 0;
    const probe = async (): Promise<ConnectionProbeOutcome> =>
      runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        credentialFingerprint: 'fp-1',
        verify: () => {
          calls += 1;
          return { status: 'rejected' as const, cause: 'http_401' as const };
        },
      });

    const first = await probe();
    const second = await probe();

    assert.equal(calls, 1, 'the target system is asked once');
    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'rejected');
    assert.equal(second.cached, true);
    assert.equal(first.cached, undefined);
    assert.equal(
      rec.reports.length,
      2,
      'a cache hit still writes the status — the registry is cleared on deactivate',
    );
  });

  it('probes again once the credential changed', async () => {
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    const fingerprints = ['fp-1', 'fp-2'];
    let calls = 0;
    for (const credentialFingerprint of fingerprints) {
      await runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        credentialFingerprint,
        verify: () => {
          calls += 1;
          return { status: 'connected' as const };
        },
      });
    }
    assert.equal(calls, 2, 'a saved key is a different question');
  });

  it('never caches an inconclusive verdict', async () => {
    // An outage must not pin "we don't know" for the whole TTL; the next
    // activation has to be allowed to find the target healthy again.
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    let calls = 0;
    for (let i = 0; i < 2; i += 1) {
      await runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        credentialFingerprint: 'fp-1',
        verify: () => {
          calls += 1;
          throw new Error('ECONNREFUSED');
        },
      });
    }
    assert.equal(calls, 2);
  });

  it('does not cache at all without a fingerprint to key on', async () => {
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    let calls = 0;
    for (let i = 0; i < 2; i += 1) {
      await runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        verify: () => {
          calls += 1;
          return { status: 'connected' as const };
        },
      });
    }
    assert.equal(calls, 2, 'an unkeyed verdict could outlive the key it is about');
  });

  it('honours force, so the operator can always re-check', async () => {
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    let calls = 0;
    const run = (force: boolean): Promise<ConnectionProbeOutcome> =>
      runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        credentialFingerprint: 'fp-1',
        force,
        verify: () => {
          calls += 1;
          return { status: 'connected' as const };
        },
      });

    await run(false);
    await run(false);
    assert.equal(calls, 1);
    const forced = await run(true);
    assert.equal(calls, 2);
    assert.equal(forced.cached, undefined);
  });

  it('keys the cache per plugin', async () => {
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    let calls = 0;
    for (const pluginId of ['a', 'b']) {
      await runConnectionProbe({
        pluginId,
        status: rec.status,
        credentialFingerprint: 'fp-shared',
        verify: () => {
          calls += 1;
          return { status: 'connected' as const };
        },
      });
    }
    assert.equal(calls, 2, 'two plugins holding the same key are two questions');
  });

  it('re-probes once the TTL has passed', async () => {
    __clearConnectionProbeCache();
    const rec = recordingStatus();
    let now = 1_000_000;
    let calls = 0;
    const run = (): Promise<ConnectionProbeOutcome> =>
      runConnectionProbe({
        pluginId: 'p',
        status: rec.status,
        credentialFingerprint: 'fp-1',
        now: () => now,
        verify: () => {
          calls += 1;
          return { status: 'connected' as const };
        },
      });

    await run();
    now += CONNECTION_PROBE_CACHE_TTL_MS - 1;
    await run();
    assert.equal(calls, 1);
    now += 2;
    await run();
    assert.equal(calls, 2);
  });
});
