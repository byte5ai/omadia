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
    assert.deepEqual(priceForModel('gpt-5.5'), {
      inputPerMTok: 5,
      outputPerMTok: 30,
      cachedInputPerMTok: 0.5,
      cacheIncludedInInput: true,
    });
    assert.equal(priceForModel('gpt-5.4').inputPerMTok, 2.5);
    assert.equal(priceForModel('gpt-5.4-mini').inputPerMTok, 0.75);
    assert.equal(priceForModel('gpt-5.4-nano').inputPerMTok, 0.2);
    assert.equal(priceForModel('gpt-5.4-nano').outputPerMTok, 1.25);
  });

  it('family fallback resolves dated snapshots, most-specific-first', () => {
    // mini/nano must not be shadowed by the broader gpt-5.4 / gpt-5.5 keys.
    assert.equal(priceForModel('gpt-5.4-nano-2026-01-01').inputPerMTok, 0.2);
    assert.equal(priceForModel('gpt-5.4-mini-2026-01-01').inputPerMTok, 0.75);
    assert.equal(priceForModel('gpt-5.4-2026-01-01').inputPerMTok, 2.5);
    assert.equal(priceForModel('gpt-5.5-2026-01-01').inputPerMTok, 5);
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
    // gpt-5.5: input $5/Mtok, output $30/Mtok, cached $0.5/Mtok.
    // 1000 prompt tokens of which 400 cached → 600 @ $5 + 400 @ $0.5, + 500 out @ $30.
    const usage = noUsage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 400 });
    const expected =
      (600 * 5) / 1e6 + (500 * 30) / 1e6 + (400 * 0.5) / 1e6;
    assert.equal(computeCostUsd('gpt-5.5', usage), Math.round(expected * 1e8) / 1e8);
  });

  it('all-cached prompt bills zero full-rate input', () => {
    // 1000 prompt all cached → 0 @ full + 1000 @ cached ($0.5/Mtok for gpt-5.5).
    const usage = noUsage({ inputTokens: 1000, cacheReadTokens: 1000 });
    assert.equal(computeCostUsd('gpt-5.5', usage), Math.round((1000 * 0.5) / 1e6 * 1e8) / 1e8);
  });

  it('never goes negative if cached exceeds reported input', () => {
    const usage = noUsage({ inputTokens: 100, cacheReadTokens: 500 });
    assert.ok(computeCostUsd('gpt-5.5', usage) >= 0);
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
