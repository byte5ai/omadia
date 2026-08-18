/**
 * Neutral DTOs and the service interface for the `transcription@1` capability.
 *
 * Provider-neutrality is an acceptance criterion of this contract: option
 * names describe intent (`languageHints`, `keywordHints`, `context`), never a
 * vendor wire param. No vendor SDK type may appear here.
 *
 * Proof-readiness is expressed as invariants, not a hash field: segments are
 * append-only, a segment never mutates after it is emitted, segment ids are
 * stable, all fields are plain-JSON serialisable, and timing provenance is
 * declared honestly. That keeps per-segment hashing deterministic for a later
 * Proof implementation without speculative contract surface now.
 */

/** The capability name a transcription service registers under. */
export const TRANSCRIPTION_CAPABILITY = 'transcription@1';

/**
 * The `transcription@1` service. One registered service object implements
 * BOTH methods; which provider model serves which surface is an adapter
 * concern the contract does not see.
 */
export interface TranscriptionService {
  /** Transcribe a complete audio file. Rejects with {@link TranscriptionError}. */
  transcribeFile(audio: AudioFile, opts?: TranscribeOptions): Promise<Transcript>;
  /**
   * Transcribe a live audio byte stream. The iterable yields
   * {@link TranscriptDelta} events and closes with a `kind: 'end'` delta;
   * failures surface as a thrown {@link TranscriptionError} (an
   * AsyncIterable cannot yield after it throws, so partial usage rides on
   * the error itself).
   */
  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    opts: TranscribeStreamOptions,
  ): AsyncIterable<TranscriptDelta>;
}

/**
 * Bytes + format metadata — the capability is blob-store-agnostic; the caller
 * reads the blob (e.g. via AttachmentReader) and passes bytes (the 25 MB
 * provider cap makes in-memory fine). The extension-bearing filename plus the
 * mime type drive provider format detection.
 */
export interface AudioFile {
  data: Uint8Array;
  filename: string;
  mimeType?: string;
}

/** Streaming audio format is never implicit. */
export interface AudioFormat {
  encoding: 'pcm16';
  sampleRateHz: number;
  channels: number;
}

export interface TranscribeOptions {
  /** ISO 639-1 hints for the audio's language(s). */
  languageHints?: string[];
  /** Literal terms to bias recognition (names, IDs, jargon). */
  keywordHints?: string[];
  /** Free-text context about the recording (topic, setting). */
  context?: string;
  /** Abort surfaces as a {@link TranscriptionError} with `code: 'aborted'`. */
  signal?: AbortSignal;
}

export interface TranscribeStreamOptions extends TranscribeOptions {
  format: AudioFormat;
}

/**
 * One recognised span of speech. Immutable once emitted: after a segment has
 * appeared in a `segmentCompleted` delta (or a returned {@link Transcript}),
 * neither its id nor any other field may change — the append-only invariant
 * later per-segment hashing depends on.
 */
export interface TranscriptSegment {
  /** Adapter-assigned, stable (realtime: from the provider item id; batch: 'seg-0'). */
  id: string;
  text: string;
  /**
   * Diarization label slot — no v1 provider fills it; reserved for future
   * diarizing providers. Default speaker labels are assigned by the caller
   * writing the Transcript Artifact, never by the capability.
   */
  speaker?: string;
  startMs?: number;
  endMs?: number;
  detectedLanguages?: string[];
}

/**
 * Where timestamps come from. `provider` = the provider returned them;
 * `estimated` = the adapter derived them from its own audio-feed offset
 * (serves recall, not proof); `none` = no timestamps at all. Provenance is
 * declared, never faked.
 */
export type TimingProvenance = 'provider' | 'estimated' | 'none';

export interface Transcript {
  /** Append-only; see {@link TranscriptSegment} for the immutability invariant. */
  segments: TranscriptSegment[];
  timing: TimingProvenance;
  detectedLanguages?: string[];
  /** Required — metering derives Billed Minutes from it. */
  usage: TranscriptionUsage;
}

/**
 * Streaming events. `partial` is an ephemeral UI feed and carries no
 * contract guarantees; `segmentCompleted` is authoritative and append-only;
 * `end` closes the stream and delivers the final usage.
 */
export type TranscriptDelta =
  | { kind: 'partial'; segmentId: string; textDelta: string }
  | { kind: 'segmentCompleted'; segment: TranscriptSegment }
  | { kind: 'end'; usage: TranscriptionUsage };

/**
 * Metering contract: Billed Minutes are derived by the CAPABILITY layer, not
 * per-adapter. Batch: billed = probed source duration × attempts. Realtime:
 * billed = the sum of client-measured per-attempt stream durations (a
 * reconnect = a new attempt). Source duration is deliberately NOT returned
 * here — the caller probes it pre-flight for the duration cap.
 */
export interface TranscriptionUsage {
  /** Provider calls actually sent, including SDK-internal retries. */
  attempts: number;
  /** Realtime only: measured stream duration per attempt, in milliseconds. */
  attemptDurationsMs?: number[];
}
