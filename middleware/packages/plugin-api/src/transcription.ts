/**
 * `transcription@1` — capability contract for speech-to-text (#584 WS T).
 *
 * Speech-to-text is a first-class, provider-swappable middleware capability
 * (ADR-0003): adapter plugins publish ONE implementation of
 * {@link TranscriptionService} under the bare registry key
 * {@link TRANSCRIPTION_SERVICE_NAME}; consumers resolve it lazily per call and
 * degrade gracefully when no provider is installed. Exactly one provider may
 * be active — `ctx.services.provide` throws on a duplicate registration, the
 * same structural guarantee the `embeddingClient` seam relies on.
 *
 * The two-constant split mirrors `sessionBriefing.ts`: the bare name is the
 * SERVICE-REGISTRY key, the `@1`-suffixed form is the MANIFEST capability ref
 * (`provides` / `requires` / `optional_requires`). Never use the versioned
 * form as a registry key — `declaredServiceNames()` strips the version before
 * grant classification, so a `'transcription@1'` registration would hand every
 * consuming plugin a `ServiceNotDeclaredError` at runtime.
 *
 * PRIVACY. A transcript is untrusted external input, exactly like a channel
 * message: producing it sends raw audio to an external provider, and consuming
 * it must ride the existing privacy-masking choke points (the per-turn privacy
 * handle around every LLM call site) before any model sees the text. The
 * operator-facing consent surface for that egress is the transcription
 * provider admin panel, the same place the LLM/embedding providers declare
 * theirs.
 *
 * PROOF-READINESS (#584, requirement only). Persisted transcript segments are
 * timestamped and speaker-attributed, and transcript session-log entries are
 * append-only (turns are only ever added). That makes each segment hashable
 * after the fact; no attestation code lives here.
 *
 * This interface deliberately leaks no OpenAI Realtime-API types: ElevenLabs,
 * Google, Mistral or a local Whisper can register later without touching it.
 */

/** Service-registry key (bare, unversioned — see module doc). */
export const TRANSCRIPTION_SERVICE_NAME = 'transcription';
/** Manifest capability ref (`provides:` / `requires:` form). */
export const TRANSCRIPTION_CAPABILITY = 'transcription@1';

/**
 * Context hints a caller can hand the provider to improve accuracy. The
 * Facilitator's hint synergy (#584): roster names, goal and domain terms are
 * exactly the tokens a generic model mis-transcribes, so callers that know
 * them pass them here.
 */
export interface TranscribeOpts {
  /** Expected input languages (BCP-47 / ISO-639 codes, e.g. `['de', 'en']`). */
  readonly languageHints?: readonly string[];
  /** Literal terms that may appear in the audio (names, products, jargon).
   *  Hints, not required output. */
  readonly keywordHints?: readonly string[];
  /** Free-form context about the recording (topic, setting, participants). */
  readonly context?: string;
  /**
   * Cap on billable audio duration for THIS call, in milliseconds. Guardrail
   * wrappers may tighten it. Enforcement strength is path-dependent and
   * honest: streams are HARD-cut at the cap (the guardrail's wall-clock
   * backstop guarantees it even against a provider that ignores the field);
   * batch providers cannot know a file's duration before transcribing it, so
   * for them the cap is advisory — the actual billed duration is still
   * metered against the quota afterwards.
   */
  readonly maxDurationMs?: number;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/** One attributed, timestamped slice of a transcript. */
export interface TranscriptSegment {
  readonly text: string;
  /** Offset from the start of the audio, when the provider reports one. */
  readonly startMs?: number;
  readonly endMs?: number;
  /**
   * Speaker attribution. For #584 this comes from the CHANNEL (or a
   * diarizing provider), never from caller-supplied self-attribution.
   * Absent when the provider cannot attribute.
   */
  readonly speaker?: string;
}

/** Completed transcript of a bounded piece of audio. */
export interface Transcript {
  /** Full transcript text (segments joined in order). */
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
  /** Detected/declared dominant language, when known. */
  readonly language?: string;
  /** Billable audio duration, when the provider reports one. */
  readonly durationMs?: number;
  /** Provider-chosen identity, e.g. `openai:gpt-transcribe`. */
  readonly provider: string;
}

/**
 * Streamed transcription progress. `partial` deltas refine the utterance
 * identified by `itemId`; a `segment` finalises it. Consumers order and
 * reconcile by `itemId` — partial text may be revised by later deltas.
 */
export type TranscriptDelta =
  | { readonly kind: 'partial'; readonly itemId: string; readonly text: string }
  | {
      readonly kind: 'segment';
      readonly itemId: string;
      readonly segment: TranscriptSegment;
    };

/** A completed recording handed to `transcribeFile`. Callers resolve storage
 *  keys/URLs to bytes themselves — the capability stays storage-agnostic. */
export interface TranscribeFileRef {
  readonly bytes: Uint8Array;
  readonly fileName?: string;
  /** MIME type, e.g. `audio/mpeg`, `audio/wav`. */
  readonly contentType?: string;
}

/**
 * The capability surface. Both entry points accept the same hint carrier;
 * providers translate hints into whatever their wire format calls them.
 */
export interface TranscriptionService {
  /** Provider identity for display/metering, e.g. `openai:gpt-transcribe`. */
  readonly providerId: string;
  /** Async/batch: a completed audio file in, a finished transcript out. */
  transcribeFile(
    ref: TranscribeFileRef,
    opts?: TranscribeOpts,
  ): Promise<Transcript>;
  /**
   * Realtime: live audio chunks in, transcript deltas out. Providers that do
   * not support streaming (or have it disabled) throw
   * {@link TranscriptionRealtimeDisabledError} — synchronously at call time
   * or on first iteration; consumers must be ready for either.
   */
  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    opts?: TranscribeOpts,
  ): AsyncIterable<TranscriptDelta>;
}

/** Thrown by guardrail wrappers when a per-agent minute quota is exhausted.
 *  Mirrors the conductor's `EphemeralQuotaExceededError` naming (#818). */
export class TranscriptionQuotaExceededError extends Error {
  constructor(
    readonly agentKey: string,
    readonly quotaMinutes: number,
    readonly usedMinutes: number,
  ) {
    super(
      `transcription minute quota exhausted for '${agentKey}' — ` +
        `${usedMinutes.toFixed(1)} of ${String(quotaMinutes)} minutes used ` +
        `(in-memory tally, resets on restart)`,
    );
  }
}

/** Thrown when the realtime path is not enabled on this install (e.g. the
 *  provider ships it behind an experimental gate). */
export class TranscriptionRealtimeDisabledError extends Error {
  constructor(detail: string) {
    super(`realtime transcription is not enabled — ${detail}`);
  }
}
