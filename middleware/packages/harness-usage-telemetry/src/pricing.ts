/**
 * Multi-provider model pricing + per-call USD cost computation.
 *
 * Prices are USD per 1,000,000 tokens. Anthropic figures are current as of the
 * Opus 5.5 generation (platform.claude.com/docs/en/about-claude/pricing,
 * reviewed 2026-10-05); OpenAI figures as of the GPT-4.1/4o generation
 * (openai.com/api/pricing, reviewed 2026-06-14).
 *
 * Two cache-cost conventions differ across providers, so the model's price
 * entry carries the relevant flags rather than the math being Anthropic-only:
 *
 *  - Anthropic: `input_tokens` EXCLUDES cached reads. Cache reads bill at ~0.1×
 *    the base input rate (CACHE_READ_MULTIPLIER); 5-minute cache writes
 *    (`cache_creation_input_tokens`) bill at ~1.25× (CACHE_WRITE_MULTIPLIER).
 *    All components sum without double-counting. A model whose read fraction
 *    is not 0.1× carries an absolute `cachedInputPerMTok` instead of a second
 *    multiplier table — see that field for which ones and why.
 *  - OpenAI: `prompt_tokens` INCLUDES the cached portion, and cached input has
 *    its own absolute rate (`cachedInputPerMTok`, ~0.1× of input for GPT-5.x).
 *    Entries set `cacheIncludedInInput: true` so the cached tokens are
 *    subtracted from the full-rate input before being billed at the cached rate
 *    — otherwise the cached portion would be billed twice. OpenAI has no cache
 *    write, so `cacheCreationTokens` is 0 on that path.
 *
 * Model matching is by id first, then by family keyword (fable/opus/sonnet/
 * haiku, gpt-5.x variants, mistral sizes) so dated snapshots (e.g.
 * `claude-opus-5-5-2026…`, `claude-haiku-4-5-20251001`, `gpt-5.4-mini-2026-…`)
 * and future point releases resolve without a code change. Family keywords are
 * ordered most-specific-first because matching is by substring `includes`: a
 * point release that prices differently from its family needs its own keyword
 * ahead of the family's (`opus-5-5` before `opus`, `gpt-5.4-mini` before
 * `gpt-5.4`), or its snapshots silently fall through to the family rate.
 * Unknown models price at 0 and are logged once so the dashboard surfaces a
 * "0 cost" anomaly instead of crashing.
 */

export interface ModelPrice {
  /** USD per 1M input tokens (uncached). */
  readonly inputPerMTok: number;
  /** USD per 1M output tokens. */
  readonly outputPerMTok: number;
  /** USD per 1M cached-input tokens (absolute). When set, overrides the
   *  CACHE_READ_MULTIPLIER fallback. Two kinds of model need it:
   *   - OpenAI, which publishes a distinct cached rate rather than a fixed
   *     fraction of the input rate.
   *   - the Anthropic models whose read fraction is not the global 0.1×:
   *     Opus 5.5 reads at 0.05× (0.05 × $4 = $0.20/MTok) and Fable 5.1 at
   *     0.025× (0.025 × $10 = $0.25/MTok). Expressed absolutely so
   *     CACHE_READ_MULTIPLIER stays one number instead of a per-model table. */
  readonly cachedInputPerMTok?: number;
  /** True when the provider's reported input-token count INCLUDES the cached
   *  reads (OpenAI). The cached tokens are then subtracted from full-rate input
   *  before being billed at the cached rate, preventing double-counting.
   *  Anthropic excludes cached reads from input, so this stays false/undefined. */
  readonly cacheIncludedInInput?: boolean;
}

/** Cache-read tokens bill at this fraction of the base input rate when a model
 *  has no explicit `cachedInputPerMTok` (Anthropic convention). */
export const CACHE_READ_MULTIPLIER = 0.1;
/** 5-minute cache-write tokens bill at this multiple of the base input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Point releases that price below the rest of their family. Each is spelled
 *  once here and used by BOTH tables below: the exact entry prices the bare id,
 *  the family keyword prices its dated snapshots. Dropping either half
 *  re-introduces the fall-through these exist to stop. */
const FABLE_5_1: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50, cachedInputPerMTok: 0.25 };
const OPUS_5_5: ModelPrice = { inputPerMTok: 4, outputPerMTok: 20, cachedInputPerMTok: 0.2 };
const SONNET_5_5: ModelPrice = { inputPerMTok: 2, outputPerMTok: 10 };

/** Exact-id price table. Falls through to family matching for anything else. */
const EXACT_PRICES: Readonly<Record<string, ModelPrice>> = {
  // --- Anthropic (input_tokens excludes cached; multiplier-based cache) ------
  // Mythos shares Fable's rates and has no row: `builtinLlmProviders.ts`
  // excludes it from model discovery, so it never reaches the recorder.
  'claude-fable-5-1': FABLE_5_1,
  // Cache writes need no entry of their own: CACHE_WRITE_MULTIPLIER × $4 is
  // the published $5/MTok 5-minute write rate.
  'claude-opus-5-5': OPUS_5_5,
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  // Load-bearing, both of them: the `sonnet` family fallback is $3/$15.
  'claude-sonnet-5-5': SONNET_5_5,
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  // --- OpenAI (current GPT-5.x; prompt_tokens includes cached, ~0.1x cached) -
  'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, cacheIncludedInInput: true },
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, cacheIncludedInInput: true },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, cachedInputPerMTok: 0.075, cacheIncludedInInput: true },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25, cachedInputPerMTok: 0.02, cacheIncludedInInput: true },
  // --- Mistral (OpenAI-compatible API; per the live mistral.ai/pricing page,
  //     reviewed 2026-06-14). `-latest` maps large→Large 3, medium→Medium 3.5,
  //     small→Small 4. `usage` reports prompt/completion tokens with no
  //     separate cached-read billing, so no cachedInputPerMTok /
  //     cacheIncludedInInput (cached reads resolve to 0). Note Mistral prices
  //     Medium 3.5 ABOVE Large 3 — not a typo. -----------------------------
  'mistral-large-latest': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'mistral-medium-latest': { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  'mistral-small-latest': { inputPerMTok: 0.2, outputPerMTok: 0.6 },
};

/** Family-keyword fallback for dated snapshots / future point releases.
 *  Ordered most-specific-first (substring match): a point release that prices
 *  below its family comes before the family, and nano/mini before base. */
const FAMILY_PRICES: ReadonlyArray<readonly [keyword: string, price: ModelPrice]> = [
  ['fable-5-1', FABLE_5_1],
  // Fable 5 / Mythos 5 snapshots: same $10/$50, but reads at the standard 0.1×.
  ['fable', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['opus-5-5', OPUS_5_5],
  ['opus', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['sonnet-5-5', SONNET_5_5],
  ['sonnet', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['haiku', { inputPerMTok: 1, outputPerMTok: 5 }],
  ['gpt-5.4-nano', { inputPerMTok: 0.2, outputPerMTok: 1.25, cachedInputPerMTok: 0.02, cacheIncludedInInput: true }],
  ['gpt-5.4-mini', { inputPerMTok: 0.75, outputPerMTok: 4.5, cachedInputPerMTok: 0.075, cacheIncludedInInput: true }],
  ['gpt-5.4', { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, cacheIncludedInInput: true }],
  ['gpt-5.5', { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, cacheIncludedInInput: true }],
  // Mistral dated snapshots / non-`-latest` variants (e.g. mistral-large-3-25-12).
  ['mistral-large', { inputPerMTok: 0.5, outputPerMTok: 1.5 }],
  ['mistral-medium', { inputPerMTok: 1.5, outputPerMTok: 7.5 }],
  ['mistral-small', { inputPerMTok: 0.2, outputPerMTok: 0.6 }],
];

const UNKNOWN_PRICE: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 };

const warnedUnknownModels = new Set<string>();

/**
 * Resolves the price for a model id. Exact match wins; otherwise the first
 * matching family keyword. Unknown models return a zero price (logged once).
 */
export function priceForModel(model: string): ModelPrice {
  const id = model.trim().toLowerCase();
  const exact = EXACT_PRICES[id];
  if (exact) return exact;

  for (const [keyword, price] of FAMILY_PRICES) {
    if (id.includes(keyword)) return price;
  }

  if (!warnedUnknownModels.has(id)) {
    warnedUnknownModels.add(id);
    console.warn(
      `[usage-telemetry] no price for model "${model}" — recording at $0. Add it to EXACT_PRICES.`,
    );
  }
  return UNKNOWN_PRICE;
}

/** The four token counters cost is computed from. Fed either by the neutral
 *  `LlmUsage` shape (via withProviderUsageTracking, both providers) or by
 *  {@link normalizeUsage} for the raw Anthropic `message.usage` path. Note the
 *  cross-provider semantics of `inputTokens` re: cached reads — see the cost
 *  conventions in this module's header. */
export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * Computes the USD cost of a single call from its model + token usage.
 * Rounds to 8 decimals (sub-micro-cent) so summing many rows stays exact.
 */
export function computeCostUsd(model: string, usage: UsageTokens): number {
  const price = priceForModel(model);
  const inRate = price.inputPerMTok / 1_000_000;
  const outRate = price.outputPerMTok / 1_000_000;
  // Cached reads bill at the model's absolute cached rate when published
  // (OpenAI), else at the multiplier fraction of the input rate (Anthropic).
  const cacheReadRate =
    price.cachedInputPerMTok !== undefined
      ? price.cachedInputPerMTok / 1_000_000
      : inRate * CACHE_READ_MULTIPLIER;
  // When the provider's input count includes the cached portion (OpenAI),
  // bill only the non-cached remainder at the full input rate — the cached
  // tokens are billed separately below. Anthropic excludes them already.
  const fullRateInput = price.cacheIncludedInInput
    ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    : usage.inputTokens;
  const cost =
    fullRateInput * inRate +
    usage.outputTokens * outRate +
    usage.cacheReadTokens * cacheReadRate +
    usage.cacheCreationTokens * inRate * CACHE_WRITE_MULTIPLIER;
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * Normalises a raw Anthropic `message.usage` object (snake_case, nullable
 * fields) into the {@link UsageTokens} shape. Missing fields default to 0.
 */
export function normalizeUsage(usage: unknown): UsageTokens {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheCreationTokens: num(u['cache_creation_input_tokens']),
  };
}
