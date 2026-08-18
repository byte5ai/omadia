/**
 * `@omadia/transcription-api` — the versioned, SDK-free transcription contract.
 *
 * This is the entire public surface a transcription adapter compiles against:
 * the `transcription@1` capability constant, the `TranscriptionService`
 * interface, the neutral audio/option DTOs, the result types, and the
 * `TranscriptionError` class. It has zero runtime dependencies and never
 * imports a vendor SDK. The concrete adapters live in
 * `@omadia/transcription-adapter-*`; manifest/YAML concerns stay with the
 * registry, and the proof-ready Transcript Artifact lives with the ingestion
 * tool — the capability knows nothing of recordings or uploaders.
 */

export type {
  AudioFile,
  AudioFormat,
  TimingProvenance,
  TranscribeOptions,
  TranscribeStreamOptions,
  Transcript,
  TranscriptDelta,
  TranscriptSegment,
  TranscriptionService,
  TranscriptionUsage,
} from './types.js';
export { TRANSCRIPTION_CAPABILITY } from './types.js';

export type { TranscriptionErrorCode } from './errors.js';
export { TranscriptionError } from './errors.js';

export {
  TRANSCRIPTION_AUDIO_EXTENSIONS,
  TRANSCRIPTION_AUDIO_MIME_TYPES,
  TRANSCRIPTION_EXTENSION_TO_MIME,
  TRANSCRIPTION_MAX_UPLOAD_BYTES,
  fileExtension,
  normalizeContentType,
} from './formats.js';
