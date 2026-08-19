import { createHash } from 'node:crypto';

import type { TimingProvenance, Transcript } from '@omadia/transcription-api';

/**
 * #584 — Transcript Artifact: the canonical, proof-ready record of one
 * transcribed recording.
 *
 * Lives HERE, with the ingestion tool, not in `@omadia/transcription-api` —
 * the capability knows nothing of recordings or uploaders (capability
 * `Transcript` ≠ Transcript Artifact, ticket-05 decision). Stored as JSON in
 * the blob store, deliberately UNMASKED: proof must be faithful to the audio,
 * the store's access guard is the privacy boundary, and artifact content
 * never goes to wire or LLM — every recall/LLM-facing path sees only the
 * masked chunk projection.
 *
 * Proof-readiness is invariants, not a hash field: segments are append-only,
 * ids stable, everything plain-JSON serialisable, timing provenance declared
 * honestly. The Speaker Label is canonical and never replaced — a later
 * label→person mapping lands in `resolvedUserId` next to it.
 */

export const TRANSCRIPT_ARTIFACT_KEY_PREFIX = 'transcription-artifacts';

/** Assigned when the provider attributes no speaker (no v1 provider does).
 *  Without diarization the segments are indistinguishable, so they honestly
 *  share ONE unattributed label instead of faking distinct speakers. */
export const DEFAULT_SPEAKER_LABEL = 'speaker_0';

export interface TranscriptArtifactSegment {
  /** Adapter-assigned, stable, immutable (capability invariant). */
  id: string;
  text: string;
  /** Speaker Label — canonical, never replaced. Provider attribution when
   *  present, else {@link DEFAULT_SPEAKER_LABEL}. */
  speaker: string;
  /** Later label→person mapping slot; unset in v1. */
  resolvedUserId?: string;
  startMs?: number;
  endMs?: number;
  detectedLanguages?: string[];
}

export interface TranscriptArtifactUploader {
  /** Raw channel-native turn user id (Teams AAD oid, HTTP header). */
  userId?: string;
  /** Canonical omadia user uuid, when the turn resolved one. */
  omadiaUserId?: string;
}

export interface TranscriptArtifact {
  version: 1;
  recordingId: string;
  /** Blob-store key of the source recording — the recording's identity. */
  storageKey: string;
  /** ISO 8601 — required tool input, default upload time. */
  recordingStart: string;
  /** ISO 8601 ingest time. */
  createdAt: string;
  uploader?: TranscriptArtifactUploader;
  /** Transcript-level timing provenance — segment timestamps are optional
   *  (no v1 provider returns any), the provenance says why. */
  timing: TimingProvenance;
  detectedLanguages?: string[];
  segments: TranscriptArtifactSegment[];
}

/** The recording's stable identity, derived from the storage key (the upload
 *  endpoint mints no separate id — the key IS the recording reference).
 *  Lowercase hex so it survives scope sanitisation byte-identically. */
export function recordingIdFor(storageKey: string): string {
  return createHash('sha256').update(storageKey).digest('hex').slice(0, 16);
}

export function transcriptArtifactKey(recordingId: string): string {
  return `${TRANSCRIPT_ARTIFACT_KEY_PREFIX}/${recordingId}.json`;
}

/** One scope per recording; transcript-turn detection is by this prefix. */
export function transcriptScope(recordingId: string): string {
  return `transcript-${recordingId}`;
}

export function buildTranscriptArtifact(args: {
  recordingId: string;
  storageKey: string;
  recordingStart: Date;
  createdAt: Date;
  uploader?: TranscriptArtifactUploader;
  transcript: Transcript;
}): TranscriptArtifact {
  return {
    version: 1,
    recordingId: args.recordingId,
    storageKey: args.storageKey,
    recordingStart: args.recordingStart.toISOString(),
    createdAt: args.createdAt.toISOString(),
    ...(args.uploader && (args.uploader.userId ?? args.uploader.omadiaUserId)
      ? { uploader: args.uploader }
      : {}),
    timing: args.transcript.timing,
    ...(args.transcript.detectedLanguages
      ? { detectedLanguages: args.transcript.detectedLanguages }
      : {}),
    segments: args.transcript.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      speaker: segment.speaker ?? DEFAULT_SPEAKER_LABEL,
      ...(segment.startMs !== undefined ? { startMs: segment.startMs } : {}),
      ...(segment.endMs !== undefined ? { endMs: segment.endMs } : {}),
      ...(segment.detectedLanguages
        ? { detectedLanguages: segment.detectedLanguages }
        : {}),
    })),
  };
}
