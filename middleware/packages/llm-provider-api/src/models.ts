/**
 * Model-registry CONTRACT types (the data shape; the runtime registry that
 * validates/indexes/resolves these lives in `@omadia/llm-provider`).
 *
 * A provider descriptor (manifest `llm_provider` block, or a bundled built-in)
 * contributes a list of `ModelInfo`; the runtime overlay merges them. Keeping
 * the type here lets a provider plugin declare its models against the versioned
 * contract without importing the runtime registry.
 */

import type { EffortLevel } from './types.js';

/** Capability/quality tier. Maps a capability request to a concrete model per
 *  provider. Builder slugs `haiku|sonnet|opus` are legacy aliases onto these. */
export type ModelClass = 'fast' | 'balanced' | 'frontier';

/** A functional role the host assigns a model to. Each role has a default
 *  class (see ROLE_DEFAULT_CLASS); the registry resolves role → class → model. */
export type ModelRole =
  | 'orchestrator'
  | 'subagent'
  | 'classifier'
  | 'verifier'
  | 'codegen'
  | 'preview';

/** Provider id — matches the `LlmProvider.id` of the adapter that serves it. */
export type ProviderId = 'anthropic' | 'openai' | 'openai-compatible' | string;

/**
 * A model as reported LIVE by a provider's own list-models API (Anthropic
 * `GET /v1/models`, OpenAI-compatible `GET /v1/models`, …). This is what an
 * adapter's `listModels()` returns; the runtime turns it into `ModelInfo` by
 * applying the provider's `ModelDiscoveryRules` (class tier, aliases, caps the
 * vendor does not report). Every field except `modelId` is optional because
 * vendors differ wildly in what their list endpoint exposes — OpenAI returns
 * little more than the id, Anthropic reports context/output caps and a
 * capability tree.
 */
export interface DiscoveredModel {
  /** Bare vendor id exactly as the API accepts it (`claude-opus-5`, `gpt-5.5`). */
  readonly modelId: string;
  /** Vendor display name when reported (Anthropic `display_name`). */
  readonly label?: string;
  /** Context window (input) in tokens when reported. */
  readonly contextWindow?: number;
  /** Max output tokens when reported. */
  readonly maxTokens?: number;
  /** Image input support when the vendor reports it. */
  readonly vision?: boolean;
  /** Effort levels the vendor reports, already intersected with `EFFORT_LEVELS`. */
  readonly effortLevels?: ReadonlyArray<EffortLevel>;
  /** Vendor creation timestamp (ISO 8601) when reported. Drives the
   *  "newest model of a family wins" default/alias selection. */
  readonly createdAt?: string;
  /** Vendor-announced retirement date (ISO 8601) when reported (OpenAI
   *  `shutdown_date`). A discovered model with a past shutdown date is dropped. */
  readonly shutdownAt?: string;
}

export interface ModelInfo {
  /** Provider-qualified id, the registry's primary key: `anthropic:claude-opus-4-8`. */
  readonly id: string;
  readonly provider: ProviderId;
  /** Bare vendor id the adapter receives: `claude-opus-4-8`, `gpt-4.1`. */
  readonly modelId: string;
  readonly label: string;
  readonly class: ModelClass;
  /** Default max OUTPUT tokens (the model's capability ceiling; callers may
   *  request fewer). Distinct from a per-feature output budget. */
  readonly maxTokens: number;
  /** Total context window (input + output) in tokens. */
  readonly contextWindow: number;
  readonly vision: boolean;
  /** Legacy/alternate references that resolve to this model (e.g. builder
   *  slugs `opus`/`sonnet`/`haiku`). Aliases must be globally unique. */
  readonly aliases?: ReadonlyArray<string>;
  /** Marks the canonical model for its `(provider, class)` pair. REQUIRED to be
   *  set on exactly one model when a provider has >1 model of a class, so
   *  `class:`/role resolution never depends on array order. */
  readonly classDefault?: boolean;
  /**
   * Effort levels this model honours (#1033), in the contract's normalized
   * vocabulary. Absent = the model has no effort knob; an operator UI offers
   * effort only where this is declared, and a policy naming an undeclared
   * level is rejected at write time rather than silently dropped at run time.
   */
  readonly effortLevels?: ReadonlyArray<EffortLevel>;
  /** The level the vendor applies when none is sent; informational for the UI. */
  readonly effortDefault?: EffortLevel;
}
