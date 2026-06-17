/**
 * Provider DESCRIPTOR contract — what a provider plugin's `llm_provider`
 * manifest block (or a bundled built-in) contributes to the runtime catalog.
 * It is purely declarative data: which wire format to speak, where the API
 * lives, vendor quirks for the OpenAI-compatible adapter, compliance hints for
 * the operator UI, and the models served. The runtime catalog + the resolution
 * seam that consume this live in `@omadia/llm-provider`.
 */
import type { ModelInfo } from './models.js';

/** The HTTP wire protocol an adapter speaks. A provider picks one; the matching
 *  registered `LlmAdapter` (see ./adapter.ts) builds the concrete provider.
 *  `openai-compatible` = OpenAI Chat Completions (most providers); `anthropic` =
 *  Anthropic Messages (Claude, or an Anthropic-compatible gateway). */
export type WireFormat = 'openai-compatible' | 'anthropic';

/** Vendor deviations from plain OpenAI that the OpenAI adapter handles when set. */
export interface ProviderQuirks {
  /** Field carrying the output-token cap (MiniMax → `max_completion_tokens`). */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Omit `tool_choice` / `parallel_tool_calls` (MiniMax doesn't accept them). */
  readonly dropToolChoice?: boolean;
  /** Throw on a non-zero in-body `base_resp.status_code` (MiniMax) even on 200. */
  readonly checkBaseResp?: boolean;
  /** Vendor-only request fields merged into every body (MiniMax `reasoning_split`). */
  readonly extraBody?: Record<string, unknown>;
}

/** Provider data-protection hints for the operator UI. Defaults are the safe
 *  conservative choice: a provider with no policy is treated as a third-party,
 *  non-EU processor (disclosure shown, no EU-hosting note). */
export interface ProviderPolicy {
  /** Show the AVV / Art. 28 DSGVO third-party-processing disclosure before
   *  routing an agent to this provider. Default (omitted) = true. */
  readonly requiresAvvDisclosure?: boolean;
  /** Provider is hosted in the EU (no third-country transfer) — surfaces a note.
   *  Default (omitted) = false. */
  readonly euHosted?: boolean;
  /** Whether this provider needs an API key to be usable. Local / self-hosted
   *  providers (e.g. Ollama) run without credentials — set `false` so the
   *  factory builds the provider with an empty key instead of treating the
   *  missing key as "not connected". Default (omitted) = true. */
  readonly requiresApiKey?: boolean;
}

/** A plugin-contributed (or bundled built-in) provider. `quirks` only apply to
 *  the openai-compatible adapter. */
export interface LlmProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly wireFormat: WireFormat;
  /** Default API base URL (e.g. `https://api.minimax.io/v1`). */
  readonly baseURL: string;
  /** Optional config key an operator can set to override `baseURL` per scope. */
  readonly baseUrlConfigKey?: string;
  readonly quirks?: ProviderQuirks;
  /** Operator-UI compliance hints (not LLM behaviour) surfaced on the admin
   *  providers page so the view stays data-driven instead of hard-coding ids. */
  readonly policy?: ProviderPolicy;
  readonly models: ReadonlyArray<ModelInfo>;
}
