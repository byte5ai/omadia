/**
 * OM-102 — what the dashboard's "memory / embeddings" card is allowed to say
 * about the three LLM-backed memory features.
 *
 * Two of the three (FactExtractor, TopicDetector) are published services, so a
 * reader could infer their state from the registry. The scratch-promotion
 * reaper is a background job and publishes nothing — its state is only known
 * inside `activate()`. Rather than have the card infer two states and guess
 * the third, this plugin states all three plus the WHY, and the kernel route
 * reads it structurally (no import from the kernel into this package, same
 * contract style as `embeddingModelGateStatus`).
 *
 * WHY THE REASON IS A CODE, NOT A SENTENCE
 * ----------------------------------------
 * The first cut shipped `reason` as free English text and the dashboard
 * interpolated it straight into a German string ("Aus: Faktenextraktion — no
 * usable LLM provider"). `web-ui/CLAUDE.md` forbids exactly that: a backend
 * message must never be the primary UI text. So the cause travels as a closed
 * enum the UI owns translations for, and the free text survives only as
 * `detail` — diagnostics, rendered secondary, never as the sentence itself.
 *
 * The reason is per-feature because the three fail for genuinely different
 * causes: an in-memory knowledge graph disables only the reaper, a missing
 * embedding provider only the topic detector.
 */
export const MEMORY_FEATURE_STATUS_SERVICE = 'memoryFeatureStatus';

export type MemoryFeatureState = 'active' | 'disabled';

export type MemoryFeature =
  | 'factExtractor'
  | 'topicDetector'
  | 'scratchReaper';

export const MEMORY_FEATURES: readonly MemoryFeature[] = Object.freeze([
  'factExtractor',
  'topicDetector',
  'scratchReaper',
]);

/**
 * Why one feature is off. Closed set — the UI carries a translated label per
 * code, so a new code must ship with its de/en strings.
 *
 *  - `no_llm_provider`      nothing in the OM-102 candidate chain could be
 *                           built. THE actionable one: assign a provider.
 *  - `no_embedding_provider` topic detection needs vectors as well as an LLM.
 *  - `no_graph_pool`        no Postgres knowledge graph — normal on the
 *                           in-memory backend, not a fault.
 *  - `disabled_by_config`   the operator turned it off on purpose.
 *  - `plugin_inactive`      the extras plugin published no status at all.
 */
export type MemoryFeatureReasonCode =
  | 'no_llm_provider'
  | 'no_embedding_provider'
  | 'no_graph_pool'
  | 'disabled_by_config'
  | 'plugin_inactive';

export interface MemoryFeatureStatus {
  readonly factExtractor: MemoryFeatureState;
  readonly topicDetector: MemoryFeatureState;
  readonly scratchReaper: MemoryFeatureState;
  /** The provider the features actually resolved to, when any did. */
  readonly providerId?: string;
  /** Cause per disabled feature. A feature that is `active` has no entry. */
  readonly reasons?: Readonly<
    Partial<Record<MemoryFeature, MemoryFeatureReasonCode>>
  >;
  /** Free-text diagnostics (e.g. the candidate chain that was tried).
   *  English, secondary — never the primary UI sentence. */
  readonly detail?: string;
}
