/**
 * Anthropic model pricing + per-call USD cost computation.
 *
 * Prices are USD per 1,000,000 tokens, current as of the Opus 4.8 generation
 * (see platform.claude.com/docs/en/pricing). Cache reads bill at ~0.1× the
 * base input rate; 5-minute cache writes (`cache_creation_input_tokens`) bill
 * at ~1.25×. Anthropic's `input_tokens` already EXCLUDES the cached portions,
 * so total cost is the sum of all four components — never double-counted.
 *
 * Model matching is by id first, then by family keyword (opus/sonnet/haiku)
 * so newer dated snapshots (e.g. `claude-haiku-4-5-20251001`) and future point
 * releases resolve without a code change. Unknown models price at 0 and are
 * logged once so the dashboard surfaces a "0 cost" anomaly instead of crashing.
 */

export interface ModelPrice {
  /** USD per 1M input tokens (uncached). */
  readonly inputPerMTok: number;
  /** USD per 1M output tokens. */
  readonly outputPerMTok: number;
}

/** Cache-read tokens bill at this fraction of the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** 5-minute cache-write tokens bill at this multiple of the base input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Exact-id price table. Falls through to family matching for anything else. */
const EXACT_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Family-keyword fallback for dated snapshots / future point releases. */
const FAMILY_PRICES: ReadonlyArray<readonly [keyword: string, price: ModelPrice]> = [
  ['opus', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['sonnet', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['haiku', { inputPerMTok: 1, outputPerMTok: 5 }],
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

/** The four token counters Anthropic returns on `message.usage`. */
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
  const cost =
    usage.inputTokens * inRate +
    usage.outputTokens * outRate +
    usage.cacheReadTokens * inRate * CACHE_READ_MULTIPLIER +
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
