/**
 * Slice 4a — Palaia-Excerpt-Extractor capability contract.
 *
 * One Haiku-backed call per assistant turn produces a structured
 * promotion suggestion: a kind enum + a short summary + an optional
 * rationale + 0-5 verbatim spans pulled from the cleaned assistant
 * answer. The contract is intentionally minimal so that:
 *
 *   - The orchestrator can stream it inside the `done` event without
 *     blowing up the stream shape (one optional field, easy to spread).
 *   - The chat UI can pre-fill the save-as-memory modal directly with
 *     no further inference round-trips.
 *   - The auto-promotion pipeline (Slice 4b) can hand the same payload
 *     to `createMemorableKnowledge` so manual + auto paths produce
 *     comparable shapes.
 *
 * The extractor is allowed to return `undefined` when extraction was
 * intentionally skipped (capture-level=off, empty turn, LLM failure).
 * Callers must treat this as "no enrichment available" and fall back
 * to whatever default they had before — the modal keeps its naive
 * 240-char prefill, the auto-promotion pipeline does nothing.
 */

import type { EntryType, MemorableKind } from './knowledgeGraph.js';

/**
 * What the extractor produces per turn. All copies are post-privacy-strip
 * + post-hint-parse (the same `cleaned*` inputs the capture-filter uses)
 * so PII or `<palaia-hint>` markup never leaks through.
 */
export interface PalaiaExcerpt {
  /**
   * Pre-classified MemorableKind. Either:
   *   - derived from an explicit `<palaia-hint type=…>` (when present,
   *     bypasses the LLM call), or
   *   - chosen by the LLM, validated against the {@link MemorableKind}
   *     enum, falling back to `'insight'` on invalid output.
   */
  suggestedKind: MemorableKind;

  /**
   * 1-3 sentences, ≤500 characters. Hand-shaped to fit the chat-side
   * save-as-memory modal's summary field without overflowing.
   */
  suggestedSummary: string;

  /**
   * Optional context — caveats, "why this is memorable", external
   * preconditions. ≤2000 characters. Omitted when the LLM did not
   * surface a separable rationale.
   */
  suggestedRationale?: string;

  /**
   * 0-5 verbatim spans from the cleaned assistant answer. The UI can
   * render these as quote chips that, when clicked, insert the span
   * into the summary textarea. The chat side never mutates them; what
   * the extractor returns is what the user sees.
   *
   * Each excerpt is ≤300 characters. Order matches document order in
   * the source answer (top-to-bottom).
   */
  excerpts: readonly string[];

  /**
   * Provenance for the modal's badge:
   *   - 'hint'     — derived from `<palaia-hint type=…>`; user
   *                  intentionally marked this turn. Modal should
   *                  show "hint" badge so the user knows their tag
   *                  was respected.
   *   - 'llm'      — produced by the Haiku extractor. Editable; user
   *                  expected to refine before saving.
   *   - 'fallback' — extractor explicitly returned a degraded shape
   *                  (e.g. parse failure, empty assistant answer).
   *                  Should usually not be emitted — callers may
   *                  prefer returning `undefined` instead.
   */
  source: 'llm' | 'hint' | 'fallback';
}

/**
 * Inputs the extractor needs to make a useful classification. Mirrors
 * the fields the capture-filter already computes so the orchestrator
 * can hand them over without a second privacy-strip pass.
 */
export interface PalaiaExcerptExtractInput {
  /** Cleaned user message — `cleanedUserMessage` from capture-filter. */
  cleanedUserMessage: string;

  /** Cleaned assistant answer — `cleanedAssistantAnswer` from capture-filter. */
  cleanedAssistantAnswer: string;

  /**
   * Palaia-significance score in [0, 1] when scoring ran. The extractor
   * uses it as a soft signal (high score → richer summary). Undefined
   * when scoring was disabled or failed; the extractor must still work.
   */
  significance?: number | null;

  /**
   * EntryType from `<palaia-hint type=…>` if the user annotated the
   * turn. When present, the extractor short-circuits the LLM call and
   * derives `suggestedKind` deterministically from this value.
   */
  entryTypeHint?: EntryType;
}

/**
 * Capability contract published by the extractor provider (lives in
 * `harness-orchestrator-extras/src/excerptExtractor.ts`). The
 * orchestrator holds an optional reference; absence means "no
 * enrichment", not an error.
 */
export interface PalaiaExcerptExtractor {
  /**
   * Run extraction. MUST resolve in bounded time (≤ a few seconds);
   * the chat `done` event is gated on this. Errors are caught by the
   * caller — implementations should log + return `undefined` rather
   * than throw, but throws are tolerated (the orchestrator wraps the
   * call in try/catch and degrades gracefully).
   *
   * Returns `undefined` to signal "no enrichment available" so the
   * downstream paths (modal, auto-promotion) keep working without it.
   */
  extract(input: PalaiaExcerptExtractInput): Promise<PalaiaExcerpt | undefined>;
}

/** Capability-name constant for the service-registry lookup, matching
 *  the `processMemory@1` / `responseGuard@1` naming convention. */
export const PALAIA_EXCERPT_SERVICE_NAME = 'palaiaExcerpt';
export const PALAIA_EXCERPT_CAPABILITY = 'palaiaExcerpt@1';
