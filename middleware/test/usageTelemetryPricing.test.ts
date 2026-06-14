import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  computeCostUsd,
  priceForModel,
  type UsageTokens,
} from '@omadia/usage-telemetry';

/**
 * Guards multi-provider pricing (S5). The two regressions this prevents:
 *  - OpenAI usage priced at $0 because the model wasn't in the table.
 *  - OpenAI cached tokens double-billed: OpenAI `prompt_tokens` INCLUDES the
 *    cached portion, so billing full input + cached separately over-charges.
 *    Anthropic excludes cached from input and must stay byte-identical.
 */

const noUsage = (p: Partial<UsageTokens>): UsageTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...p,
});

describe('pricing — OpenAI table', () => {
  it('prices every registry OpenAI model exactly', () => {
    assert.deepEqual(priceForModel('gpt-4.1'), {
      inputPerMTok: 2,
      outputPerMTok: 8,
      cachedInputPerMTok: 0.5,
      cacheIncludedInInput: true,
    });
    assert.equal(priceForModel('gpt-4.1-mini').inputPerMTok, 0.4);
    assert.equal(priceForModel('gpt-4.1-nano').inputPerMTok, 0.1);
    assert.equal(priceForModel('gpt-4o').outputPerMTok, 10);
    assert.equal(priceForModel('gpt-4o-mini').outputPerMTok, 0.6);
  });

  it('family fallback resolves dated snapshots, most-specific-first', () => {
    // mini/nano must not be shadowed by the broader gpt-4.1 / gpt-4o keys.
    assert.equal(priceForModel('gpt-4.1-nano-2025-04-14').inputPerMTok, 0.1);
    assert.equal(priceForModel('gpt-4.1-mini-2025-04-14').inputPerMTok, 0.4);
    assert.equal(priceForModel('gpt-4.1-2025-04-14').inputPerMTok, 2);
    assert.equal(priceForModel('gpt-4o-mini-2024-07-18').inputPerMTok, 0.15);
    assert.equal(priceForModel('gpt-4o-2024-08-06').inputPerMTok, 2.5);
  });

  it('unknown model prices at zero', () => {
    assert.deepEqual(priceForModel('totally-unknown-model'), {
      inputPerMTok: 0,
      outputPerMTok: 0,
    });
    assert.equal(computeCostUsd('totally-unknown-model', noUsage({ inputTokens: 1000 })), 0);
  });
});

describe('computeCostUsd — OpenAI cache semantics (no double-count)', () => {
  it('subtracts cached tokens from full-rate input, bills them at cached rate', () => {
    // gpt-4.1: input $2/Mtok, output $8/Mtok, cached $0.5/Mtok.
    // 1000 prompt tokens of which 400 cached → 600 @ $2 + 400 @ $0.5, + 500 out @ $8.
    const usage = noUsage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 400 });
    const expected =
      (600 * 2) / 1e6 + (500 * 8) / 1e6 + (400 * 0.5) / 1e6;
    assert.equal(computeCostUsd('gpt-4.1', usage), Math.round(expected * 1e8) / 1e8);
  });

  it('all-cached prompt bills zero full-rate input', () => {
    // 1000 prompt all cached → 0 @ full + 1000 @ cached.
    const usage = noUsage({ inputTokens: 1000, cacheReadTokens: 1000 });
    assert.equal(computeCostUsd('gpt-4o', usage), Math.round((1000 * 1.25) / 1e6 * 1e8) / 1e8);
  });

  it('never goes negative if cached exceeds reported input', () => {
    const usage = noUsage({ inputTokens: 100, cacheReadTokens: 500 });
    assert.ok(computeCostUsd('gpt-4.1', usage) >= 0);
  });
});

describe('computeCostUsd — Anthropic regression (unchanged)', () => {
  it('bills input fully + cache read at 0.1x + cache write at 1.25x', () => {
    // claude-sonnet-4-6: input $3, output $15. input EXCLUDES cached.
    const usage = noUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 800,
    });
    const inRate = 3 / 1e6;
    const expected =
      1000 * inRate +
      (500 * 15) / 1e6 +
      2000 * inRate * CACHE_READ_MULTIPLIER +
      800 * inRate * CACHE_WRITE_MULTIPLIER;
    assert.equal(computeCostUsd('claude-sonnet-4-6', usage), Math.round(expected * 1e8) / 1e8);
  });

  it('family fallback keeps Anthropic dated snapshots priced', () => {
    assert.equal(priceForModel('claude-haiku-4-5-20251001').inputPerMTok, 1);
  });
});
