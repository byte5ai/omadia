/**
 * `responseGuard@1` — capability contract for response-quality plugins.
 *
 * Phase-1 of the Kemia integration. The host orchestrator looks up the
 * service once per turn (`ctx.services.get<ResponseGuardService>('responseGuard')`)
 * and splices the returned `prependRules` into the system prompt as its
 * own cache-eligible block, ahead of the body prose. Plugins not installed
 * return undefined from `services.get` and the hook is skipped — opt-in
 * by install.
 *
 * The shape is deliberately neutral so a later persona/style plugin
 * (Phase 4) can publish the same capability without breaking the seam:
 * any module that can convert a `ResponseGuardRequest` into a rules block
 * is a valid provider.
 */

export const RESPONSE_GUARD_SERVICE_NAME = 'responseGuard';
export const RESPONSE_GUARD_CAPABILITY = 'responseGuard@1';

/** Sycophancy escalation. Higher levels emit progressively stronger
 *  devil's-advocate / no-flattery rules into the prompt. */
export type SycophancyLevel = 'off' | 'low' | 'medium' | 'high';

/** Boundary preset id. The provider plugin owns the canonical mapping
 *  (id → human-readable rule string). Unknown ids are dropped silently
 *  by the provider — this keeps profile configs forward-compatible when
 *  the preset library grows. */
export type BoundaryPresetId = string;

/**
 * Per-profile quality configuration. Sourced from a profile's frontmatter
 * (AGENT.md `quality:` block — Phase 2.1) or, for legacy installs without
 * frontmatter yet, set per-agent via the provider plugin's own setup.
 *
 * All fields optional — missing fields fall back to the provider plugin's
 * configured defaults.
 */
export interface ProfileQualityConfig {
  readonly sycophancy?: SycophancyLevel;
  readonly boundaries?: {
    readonly presets?: readonly BoundaryPresetId[];
    readonly custom?: readonly string[];
  };
}

/** Per-turn input the orchestrator hands the provider. The host pre-builds
 *  the stable system prompt and passes it for cache-shape stability — v1
 *  providers do not edit it, but a later revision could. */
export interface ResponseGuardRequest {
  /** Stable host system prompt (without the prependRules block). */
  readonly systemPrompt: string;
  /** Recent message history in chronological order. v1 providers MAY
   *  ignore — kept for forward-compat with context-aware guards. */
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant' | 'system';
    readonly content: string;
  }>;
  /** Optional per-profile override; when omitted, the provider uses its
   *  own configured defaults. */
  readonly profileQuality?: ProfileQualityConfig;
  /** Optional active agent id — providers MAY route per-agent overrides
   *  via this when no frontmatter parser is wired yet. */
  readonly agentId?: string;
}

export interface ResponseGuardResult {
  /** Rules block spliced into the system prompt by the orchestrator,
   *  ahead of the body prose. Empty string when no rules apply
   *  (sycophancy=off + no boundaries). The orchestrator skips the splice
   *  for an empty-string result so cache shape stays stable. */
  readonly prependRules: string;
}

/**
 * Service surface published by a `responseGuard@1` provider plugin.
 *
 * Async by contract so a later provider can read from a backing store
 * (e.g. shared memory plugin); v1 providers compute synchronously and
 * just resolve.
 */
export interface ResponseGuardService {
  getRules(input: ResponseGuardRequest): Promise<ResponseGuardResult>;
}
