import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createEcbEurRateSource,
  ECB_DAILY_URL,
  parseEcbDailyXml,
} from '../packages/harness-usage-telemetry/src/exchangeRate.js';
import { computeCacheSavingsUsd } from '../packages/harness-usage-telemetry/src/pricing.js';

/**
 * Cost dashboard: the cache saving (what the same calls would have cost
 * without prompt caching) and the ECB USD→EUR rate behind the EUR view.
 */
describe('computeCacheSavingsUsd', () => {
  it('bills reads at full input minus the cached rate (Anthropic 0.1×)', () => {
    // Sonnet 4.6 at $3/MTok: 1M reads save $3 − $0.30.
    assert.equal(computeCacheSavingsUsd('claude-sonnet-4-6', { cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }), 2.7);
  });

  it('uses an absolute cached rate where the model has one (Opus 5.5 reads at $0.20)', () => {
    assert.equal(computeCacheSavingsUsd('claude-opus-5-5', { cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }), 3.8);
  });

  it('subtracts the cache-write premium and can go negative', () => {
    // Opus 5.5 writes at 1.25 × $4: the premium is $1 per 1M written.
    assert.equal(computeCacheSavingsUsd('claude-opus-5-5', { cacheReadTokens: 0, cacheCreationTokens: 1_000_000 }), -1);
    assert.equal(
      computeCacheSavingsUsd('claude-opus-5-5', { cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }),
      2.8,
    );
  });

  it('saves nothing on a model without a price', () => {
    assert.equal(computeCacheSavingsUsd('mystery-model-9', { cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }), 0);
  });
});

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube><Cube time='2026-11-13'>
<Cube currency='JPY' rate='170.12'/><Cube currency='USD' rate='1.0800'/>
</Cube></Cube></gesmes:Envelope>`;

describe('ECB EUR rate', () => {
  it('parses the USD quote as euros per dollar, with its date', () => {
    const fx = parseEcbDailyXml(ECB_XML);
    assert.equal(fx.date, '2026-11-13');
    assert.ok(Math.abs(fx.eurPerUsd - 1 / 1.08) < 1e-12);
  });

  it('refuses a document without a USD rate', () => {
    assert.throws(() => parseEcbDailyXml("<Cube time='2026-11-13'><Cube currency='JPY' rate='170'/></Cube>"));
  });

  it('caches, keeps the last good rate on failure and backs off', async () => {
    let clock = 0;
    let calls = 0;
    let fail = false;
    const source = createEcbEurRateSource({
      now: () => clock,
      fetchImpl: async (url) => {
        calls += 1;
        assert.equal(url, ECB_DAILY_URL);
        if (fail) throw new Error('offline');
        return { ok: true, status: 200, text: async () => ECB_XML };
      },
    });

    assert.equal((await source())?.date, '2026-11-13');
    assert.equal((await source())?.date, '2026-11-13');
    assert.equal(calls, 1, 'served from cache while fresh');

    fail = true;
    clock += 7 * 60 * 60 * 1000;
    assert.equal((await source())?.date, '2026-11-13', 'stale rate survives a failed refresh');
    assert.equal(calls, 2);
    await source();
    assert.equal(calls, 2, 'no retry inside the back-off');
  });

  it('answers null when there never was a rate', async () => {
    const source = createEcbEurRateSource({
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    });
    assert.equal(await source(), null);
  });
});
