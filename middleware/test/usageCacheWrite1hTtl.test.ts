import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider } from '@omadia/llm-adapter-anthropic';
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  computeCacheSavingsUsd,
  computeCostUsd,
  normalizeUsage,
  usageTokensFromLlm,
} from '@omadia/usage-telemetry';

/**
 * Cache writes bill by TTL (Anthropic pricing): 5-minute writes at 1.25× the
 * input rate, 1-hour writes at 2×. The orchestrator writes its stable prefix
 * with `ttl: '1h'` (#1634), but the ledger priced every write at 1.25× — cost
 * too low, cache saving too high. The split travels from the response's
 * `usage.cache_creation.ephemeral_1h_input_tokens` to the ledger.
 */

const OPUS_55_IN = 4 / 1e6; // $4 / MTok

describe('cache-write TTL multipliers', () => {
  it('are 1.25× (5 minutes) and 2× (1 hour)', () => {
    assert.equal(CACHE_WRITE_MULTIPLIER, 1.25);
    assert.equal(CACHE_WRITE_1H_MULTIPLIER, 2);
  });
});

describe('computeCostUsd — 1-hour writes', () => {
  const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  it('bills 1-hour writes at 2× the input rate', () => {
    const cost = computeCostUsd('claude-opus-5-5', {
      ...base,
      cacheCreationTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
    });
    assert.equal(cost, 8);
  });

  it('bills a mixed call per TTL: the 5-minute rest stays at 1.25×', () => {
    const cost = computeCostUsd('claude-opus-5-5', {
      ...base,
      cacheCreationTokens: 1_000_000,
      cacheCreation1hTokens: 400_000,
    });
    assert.equal(cost, Math.round((600_000 * 1.25 + 400_000 * 2) * OPUS_55_IN * 1e8) / 1e8);
  });

  it('keeps 1.25× when no split is reported', () => {
    assert.equal(computeCostUsd('claude-opus-5-5', { ...base, cacheCreationTokens: 1_000_000 }), 5);
  });

  it('never bills more 1-hour writes than writes were reported', () => {
    const cost = computeCostUsd('claude-opus-5-5', {
      ...base,
      cacheCreationTokens: 100,
      cacheCreation1hTokens: 1_000_000,
    });
    assert.equal(cost, Math.round(100 * 2 * OPUS_55_IN * 1e8) / 1e8);
  });
});

describe('computeCacheSavingsUsd — 1-hour writes', () => {
  it('subtracts the 1-hour premium (1× the input rate, not 0.25×)', () => {
    assert.equal(
      computeCacheSavingsUsd('claude-opus-5-5', {
        cacheReadTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
      }),
      -4,
    );
  });

  it('prices a mixed split per TTL', () => {
    // 1M reads save $3.80; 600k 5-minute writes cost $0.60 premium, 400k 1-hour writes $1.60.
    assert.equal(
      computeCacheSavingsUsd('claude-opus-5-5', {
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheCreation1hTokens: 400_000,
      }),
      1.6,
    );
  });
});

describe('the split reaches the ledger counters', () => {
  it('normalizeUsage reads usage.cache_creation.ephemeral_1h_input_tokens', () => {
    assert.deepEqual(
      normalizeUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 700,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
      }),
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 700, cacheCreation1hTokens: 500 },
    );
    assert.equal(normalizeUsage({ cache_creation_input_tokens: 7 }).cacheCreation1hTokens, 0);
  });

  it('usageTokensFromLlm carries cacheWrite1hTokens', () => {
    assert.deepEqual(
      usageTokensFromLlm({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 30, cacheWrite1hTokens: 20 }),
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 30, cacheCreation1hTokens: 20 },
    );
  });

  it('the Anthropic adapter maps the 1-hour split onto LlmUsage', async () => {
    const response = {
      id: 'msg_1h',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 700,
        cache_read_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
      },
    };
    const client = { messages: { create: async () => response } } as unknown as Anthropic;
    const res = await createAnthropicProvider({ client }).complete({
      model: 'claude-opus-5-5',
      maxTokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });
    assert.deepEqual(res.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheWriteTokens: 700,
      cacheReadTokens: 10,
      cacheWrite1hTokens: 500,
    });
  });
});
