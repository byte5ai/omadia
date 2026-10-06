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

/** Asserts a call's cost, applying the same 8-decimal rounding computeCostUsd
 *  does so each test states the unrounded arithmetic it means. */
const expectCost = (model: string, usage: UsageTokens, expected: number): void => {
  assert.equal(computeCostUsd(model, usage), Math.round(expected * 1e8) / 1e8);
};

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

describe('pricing — Mistral table', () => {
  it('prices every registry Mistral model exactly (live mistral.ai/pricing, no cache fields)', () => {
    // Mistral prices Medium 3.5 ABOVE Large 3 — the table must preserve that
    // rank (a regression once shipped them inverted).
    assert.deepEqual(priceForModel('mistral-large-latest'), {
      inputPerMTok: 0.5,
      outputPerMTok: 1.5,
    });
    assert.deepEqual(priceForModel('mistral-medium-latest'), {
      inputPerMTok: 1.5,
      outputPerMTok: 7.5,
    });
    assert.deepEqual(priceForModel('mistral-small-latest'), {
      inputPerMTok: 0.2,
      outputPerMTok: 0.6,
    });
    assert.ok(
      priceForModel('mistral-medium-latest').outputPerMTok >
        priceForModel('mistral-large-latest').outputPerMTok,
      'Medium 3.5 must price above Large 3',
    );
  });

  it('family fallback resolves Mistral dated snapshots', () => {
    assert.equal(priceForModel('mistral-large-3-25-12').outputPerMTok, 1.5);
    assert.equal(priceForModel('mistral-medium-3-5-26-04').inputPerMTok, 1.5);
    assert.equal(priceForModel('mistral-small-4-0-26-03').inputPerMTok, 0.2);
  });

  it('computes a non-zero cost (plain in*rate + out*rate, no cached billing)', () => {
    // mistral-small: 1000 in @ $0.2/Mtok + 500 out @ $0.6/Mtok.
    const usage = noUsage({ inputTokens: 1000, outputTokens: 500 });
    expectCost('mistral-small-latest', usage, (1000 * 0.2) / 1e6 + (500 * 0.6) / 1e6);
    assert.ok(computeCostUsd('mistral-small-latest', usage) > 0);
  });
});

describe('computeCostUsd — OpenAI cache semantics (no double-count)', () => {
  it('subtracts cached tokens from full-rate input, bills them at cached rate', () => {
    // gpt-5.5: input $5/Mtok, output $30/Mtok, cached $0.5/Mtok.
    // 1000 prompt tokens of which 400 cached → 600 @ $5 + 400 @ $0.5, + 500 out @ $30.
    const usage = noUsage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 400 });
    expectCost('gpt-5.5', usage, (600 * 5) / 1e6 + (500 * 30) / 1e6 + (400 * 0.5) / 1e6);
  });

  it('all-cached prompt bills zero full-rate input', () => {
    // 1000 prompt all cached → 0 @ full + 1000 @ cached ($0.5/Mtok for gpt-5.5).
    const usage = noUsage({ inputTokens: 1000, cacheReadTokens: 1000 });
    expectCost('gpt-5.5', usage, (1000 * 0.5) / 1e6);
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
    expectCost(
      'claude-sonnet-4-6',
      usage,
      1000 * inRate +
        (500 * 15) / 1e6 +
        2000 * inRate * CACHE_READ_MULTIPLIER +
        800 * inRate * CACHE_WRITE_MULTIPLIER,
    );
  });

  it('family fallback keeps Anthropic dated snapshots priced', () => {
    assert.equal(priceForModel('claude-haiku-4-5-20251001').inputPerMTok, 1);
  });

  it('prices claude-opus-5-5 exactly — cheaper than the opus family, 0.05x reads', () => {
    // The 'opus' fallback is $5/$25 with 0.1x reads; Opus 5.5 is $4/$20 with
    // reads at 0.05x ($0.20/MTok). Falling through over-reported cost ~25%.
    assert.deepEqual(priceForModel('claude-opus-5-5'), {
      inputPerMTok: 4,
      outputPerMTok: 20,
      cachedInputPerMTok: 0.2,
    });
    const inRate = 4 / 1e6;
    expectCost(
      'claude-opus-5-5',
      noUsage({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 800,
      }),
      1000 * inRate +
        (500 * 20) / 1e6 +
        (2000 * 0.2) / 1e6 +
        800 * inRate * CACHE_WRITE_MULTIPLIER,
    );
  });

  it('prices claude-sonnet-5-5 exactly — cheaper than the sonnet family', () => {
    // The 'sonnet' fallback is $3/$15; Sonnet 5.5 is $2/$10. Reads stay at the
    // standard 0.1x ($0.20/MTok), so no absolute cached rate.
    assert.deepEqual(priceForModel('claude-sonnet-5-5'), {
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expectCost('claude-sonnet-5-5', noUsage({ cacheReadTokens: 1000 }), (1000 * 0.2) / 1e6);
  });

  it('prices the Fable family instead of recording it at $0', () => {
    // Fable matched no keyword at all before, so every Fable call recorded as
    // free. 5.1 reads at 0.025x ($0.25/MTok); Fable 5 reads at the usual 0.1x.
    assert.deepEqual(priceForModel('claude-fable-5-1'), {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cachedInputPerMTok: 0.25,
    });
    expectCost('claude-fable-5-1', noUsage({ cacheReadTokens: 1000 }), (1000 * 0.25) / 1e6);
    assert.deepEqual(priceForModel('claude-fable-5'), {
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
    // Fable 5 reads at the standard 0.1x — $1/MTok, not 5.1's $0.25.
    expectCost('claude-fable-5', noUsage({ cacheReadTokens: 1000 }), (1000 * 1) / 1e6);
  });

  it('family keywords price the point releases dated snapshots too', () => {
    // A snapshot misses the exact table, so each point release that prices
    // below its family needs its own keyword AHEAD of the family keyword —
    // otherwise these three fall through to $5/$25, $3/$15 and $10/$50-with-
    // 0.1x-reads, which is the bug the exact entries were added to fix.
    assert.deepEqual(priceForModel('claude-opus-5-5-20260922'), {
      inputPerMTok: 4,
      outputPerMTok: 20,
      cachedInputPerMTok: 0.2,
    });
    assert.deepEqual(priceForModel('claude-sonnet-5-5-20260928'), {
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    assert.deepEqual(priceForModel('claude-fable-5-1-20260901'), {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cachedInputPerMTok: 0.25,
    });
    // The broader family keywords still answer for their own snapshots.
    assert.equal(priceForModel('claude-opus-4-8-20260101').inputPerMTok, 5);
    assert.equal(priceForModel('claude-sonnet-4-6-20260101').inputPerMTok, 3);
    assert.equal(priceForModel('claude-fable-5-20260101').cachedInputPerMTok, undefined);
  });
});
