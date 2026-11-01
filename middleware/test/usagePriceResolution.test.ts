import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hasKnownPrice } from '../packages/harness-usage-telemetry/src/pricing.js';
import {
  modelsToReprice,
  resolvePrices,
  type ZeroCostCall,
  type ZeroCostGroup,
} from '../packages/harness-usage-telemetry/src/priceResolution.js';
import { capByKey, type UsageByKey } from '../packages/harness-usage-telemetry/src/queries.js';

/**
 * #1389 — "price unknown" is resolved when the dashboard reads the ledger. A
 * metered $0 row of an unpriced model is counted as unpriced and stays out of
 * every cost; a $0 row of a model that has a price by now is priced from its
 * tokens. Postgres-free: the SQL side is in usageDashboardUnpriced.pg.test.ts.
 */

const row = (key: string, costUsd: number, calls = 1): UsageByKey => ({
  key,
  calls,
  costUsd,
  referenceCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

const call = (model: string, sourceKey: string, bucket: string, inputTokens: number): ZeroCostCall => ({
  model,
  sourceKey,
  bucket,
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

describe('#1389 — hasKnownPrice', () => {
  it('knows exact and family prices, not an unknown id', () => {
    assert.equal(hasKnownPrice('claude-sonnet-5-5'), true);
    assert.equal(hasKnownPrice('claude-haiku-4-5-20251001'), true, 'family match');
    assert.equal(hasKnownPrice('llama3.3:70b'), false);
  });
});

describe('#1389 — resolvePrices', () => {
  const T0 = '2026-03-02T00:00:00.000Z';
  const T1 = '2026-03-03T00:00:00.000Z';

  it('counts unpriced calls on the totals and their rows, and keeps them out of the costs', () => {
    const groups: ZeroCostGroup[] = [
      { model: 'llama3.3:70b', sourceKey: 'orchestrator', calls: 3 },
      { model: 'llama3.3:70b', sourceKey: 'fact-extractor', calls: 2 },
      { model: 'mystery-model', sourceKey: 'orchestrator', calls: 1 },
    ];
    const r = resolvePrices(
      {
        totalsCostUsd: 1.5,
        byModel: [row('claude-sonnet-5-5', 1.5, 4), row('llama3.3:70b', 0, 5), row('mystery-model', 0, 1)],
        bySource: [row('orchestrator', 1.5, 8), row('fact-extractor', 0, 2)],
        timeSeries: [{ bucket: T0, costUsd: 1.5, calls: 10 }],
      },
      groups,
      [],
    );
    assert.equal(r.totalsCostUsd, 1.5, 'unpriced calls add nothing to the total');
    assert.equal(r.unpricedCalls, 6);
    assert.deepEqual(r.unpricedModels, ['llama3.3:70b', 'mystery-model']);
    assert.equal(r.byModel.find((m) => m.key === 'llama3.3:70b')?.unpricedCalls, 5);
    assert.equal(r.byModel.find((m) => m.key === 'mystery-model')?.unpricedCalls, 1);
    assert.equal(r.byModel.find((m) => m.key === 'claude-sonnet-5-5')?.unpricedCalls, undefined);
    assert.equal(r.bySource.find((s) => s.key === 'orchestrator')?.unpricedCalls, 4);
    assert.equal(r.bySource.find((s) => s.key === 'fact-extractor')?.unpricedCalls, 2);
    assert.deepEqual(r.timeSeries, [{ bucket: T0, costUsd: 1.5, calls: 10 }]);
  });

  it('prices $0 rows of a model that has a price now, everywhere the cost shows', () => {
    // 1M input tokens of Sonnet 5.5 at $2/MTok = $2 — a price added after the
    // rows were written.
    const groups: ZeroCostGroup[] = [{ model: 'claude-sonnet-5-5', sourceKey: 'late-source', calls: 2 }];
    assert.deepEqual(modelsToReprice(groups), ['claude-sonnet-5-5']);
    const r = resolvePrices(
      {
        totalsCostUsd: 1,
        byModel: [row('claude-opus-5', 1), row('claude-sonnet-5-5', 0, 2)],
        bySource: [row('early-source', 1), row('late-source', 0, 2)],
        timeSeries: [
          { bucket: T0, costUsd: 1, calls: 1 },
          { bucket: T1, costUsd: 0, calls: 2 },
        ],
      },
      groups,
      [
        call('claude-sonnet-5-5', 'late-source', T1, 500_000),
        call('claude-sonnet-5-5', 'late-source', T1, 500_000),
      ],
    );
    assert.equal(r.totalsCostUsd, 3);
    assert.equal(r.unpricedCalls, 0);
    assert.deepEqual(r.unpricedModels, []);
    assert.deepEqual(
      r.byModel.map((m) => [m.key, m.costUsd, m.unpricedCalls]),
      [
        ['claude-sonnet-5-5', 2, undefined],
        ['claude-opus-5', 1, undefined],
      ],
      'priced rows re-sort by cost',
    );
    assert.equal(r.bySource[0]?.key, 'late-source');
    assert.equal(r.bySource[0]?.costUsd, 2);
    assert.deepEqual(
      r.timeSeries.map((b) => b.costUsd),
      [1, 2],
    );
  });

  it('changes nothing when every row has a price', () => {
    const input = {
      totalsCostUsd: 1,
      byModel: [row('b', 0.5), row('a', 0.5)],
      bySource: [row('s', 1)],
      timeSeries: [{ bucket: T0, costUsd: 1, calls: 1 }],
    };
    const r = resolvePrices(input, [], []);
    assert.equal(r.totalsCostUsd, 1);
    assert.equal(r.unpricedCalls, 0);
    assert.deepEqual(r.byModel, input.byModel, 'keeps the database order');
    assert.deepEqual(r.timeSeries, input.timeSeries);
  });
});

describe('#1389 — capByKey carries unpriced calls into Other', () => {
  it('sums the tail', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      ...row(`s${String(i).padStart(2, '0')}`, 12 - i),
      ...(i >= 10 ? { unpricedCalls: 1 } : {}),
    }));
    const capped = capByKey(rows, 10);
    assert.equal(capped.length, 11);
    assert.equal(capped[10]?.unpricedCalls, 2);
  });
});

describe('#1389 — modelsToReprice', () => {
  it('skips unknown models and models priced at an explicit $0', () => {
    const groups: ZeroCostGroup[] = [
      { model: 'claude-sonnet-5-5', sourceKey: 'a', calls: 1 },
      { model: 'llama3.3:70b', sourceKey: 'a', calls: 1 },
    ];
    assert.deepEqual(modelsToReprice(groups), ['claude-sonnet-5-5']);
  });
});
