/**
 * Provider DESCRIPTOR contract — what a provider plugin's `llm_provider`
 * manifest block (or a bundled built-in) contributes to the runtime catalog.
 * It is purely declarative data: which wire format to speak, where the API
 * lives, vendor quirks for the OpenAI-compatible adapter, compliance hints for
 * the operator UI, and the models served. The runtime catalog + the resolution
 * seam that consume this live in `@omadia/llm-provider`.
 */
import type { ModelClass, ModelInfo } from './models.js';
import type { EffortLevel } from './types.js';

/** The transport an adapter speaks. Most are HTTP wire protocols; the matching
 *  registered `LlmAdapter` (see ./adapter.ts) builds the concrete provider.
 *  `openai-compatible` = OpenAI Chat Completions (most providers); `anthropic` =
 *  Anthropic Messages (Claude, or an Anthropic-compatible gateway); `claude-cli`
 *  = not HTTP at all but the local official `claude` CLI driven as a tool-less
 *  completion endpoint on a subscription (#309 Shape 2, keyless);
 *  `openai-responses` = the OpenAI Responses wire protocol over SSE, as spoken
 *  by the ChatGPT/Codex backend for subscription bearers (#294, experimental). */
export type WireFormat =
  | 'openai-compatible'
  | 'anthropic'
  | 'claude-cli'
  | 'openai-responses';

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
  /** Provider runs on a PERSONAL consumer subscription (e.g. a Claude Pro/Max
   *  CLI login). No data-processing agreement (AVV / DPA) can exist on such a
   *  plan — a STRONGER caveat than the ordinary third-party disclosure, so the
   *  assignment UI shows a dedicated warning instead. Default (omitted) =
   *  false. */
  readonly subscriptionNotice?: boolean;
}

/**
 * One classification rule of a provider's model-discovery policy. Matched in
 * order against every id the vendor's list-models API returns; the first
 * matching rule assigns the class tier and fills in whatever the vendor did
 * not report. A rule names a FAMILY (`^claude-opus-`), never a specific
 * version — that is the whole point: a new generation shows up without a
 * code change.
 */
export interface ModelDiscoveryClassRule {
  /** JS regex source, matched case-insensitively against the bare model id. */
  readonly match: string;
  /** Class of the SELECTED (newest) match of this rule. */
  readonly class: ModelClass;
  /** Class of the rule's OTHER matches (older generations). Absent = same as
   *  `class`. Lets one family rule express "newest plain GPT is frontier, the
   *  previous one is balanced" without naming a version. */
  readonly restClass?: ModelClass;
  /** Aliases granted to the SELECTED (newest) model of this rule, e.g. `opus`. */
  readonly aliases?: ReadonlyArray<string>;
  /** Fallbacks used only when the vendor list omits the capability. */
  readonly maxTokens?: number;
  readonly contextWindow?: number;
  readonly vision?: boolean;
  readonly effortLevels?: ReadonlyArray<EffortLevel>;
  readonly effortDefault?: EffortLevel;
  /** Label template when the vendor reports none; `{id}` is replaced by the
   *  bare model id. Default: the id itself. */
  readonly label?: string;
}

/**
 * How to turn a vendor's live model list into catalog entries. Declared per
 * provider (bundled built-in or plugin manifest `llm_provider.discovery`).
 * When present, the runtime refreshes the provider's models from the API and
 * the static `models` list is only the offline seed used until the first
 * successful discovery (and whenever the API is unreachable).
 */
export interface ModelDiscoveryRules {
  /** Regex sources; an id must match at least one to be considered. Default:
   *  every id. Use it to keep chat models and drop embeddings/audio/etc. */
  readonly include?: ReadonlyArray<string>;
  /** Regex sources; an id matching any of these is dropped (dated snapshots,
   *  previews, non-chat modalities). Applied after `include`. */
  readonly exclude?: ReadonlyArray<string>;
  /** Ordered class rules; the first match wins. Ids matching no rule are
   *  dropped (they still show up in the discovery log). */
  readonly classify: ReadonlyArray<ModelDiscoveryClassRule>;
  /** Which model of a rule (and of a class) becomes the default + alias
   *  holder. `newest` (default): latest `createdAt`, then the highest version
   *  number embedded in the id, then vendor order. `first`: vendor order. */
  readonly select?: 'newest' | 'first';
  /** Drop a dated snapshot id (`…-20251001`, `…-2026-04-23`) when its undated
   *  base id is also listed, so pickers show one entry per model. A dated id
   *  WITHOUT an undated twin is kept. Default: true. */
  readonly collapseDatedSnapshots?: boolean;
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
  /** Declared when the provider connects via an OAuth login instead of (or in
   *  addition to) an API key. `device` = the device-code flow the admin
   *  connect routes drive (#294 "Sign in with ChatGPT", experimental). */
  readonly oauth?: { readonly kind: 'device' };
  /** The models served. With `discovery` declared this is the offline SEED
   *  (used until the first successful live discovery); without it, the
   *  authoritative static list. */
  readonly models: ReadonlyArray<ModelInfo>;
  /** Live model discovery policy. Absent = static `models` only. */
  readonly discovery?: ModelDiscoveryRules;
  /** Provenance of `models`, stamped by the runtime when it re-registers a
   *  provider after a discovery run. Absent = the declared seed. */
  readonly modelsSource?: 'seed' | 'discovered';
  /** ISO timestamp of the discovery run that produced `models`. */
  readonly modelsDiscoveredAt?: string;
}
