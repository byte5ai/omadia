import type { NativeToolSpec } from '@omadia/plugin-api';
import type { SessionLogEntry } from '@omadia/orchestrator';
import {
  createBaselineDetector,
  maskPrompt,
  type PseudonymMap,
} from '@omadia/plugin-privacy-guard';
import {
  TranscriptionError,
  type Transcript,
  type TranscriptionService,
} from '@omadia/transcription-api';

import { projectTranscriptChunks } from './chunkProjection.js';
import { uploadTimeFromKey } from './uploadRouter.js';
import {
  DEFAULT_SPEAKER_LABEL,
  buildTranscriptArtifact,
  recordingIdFor,
  transcriptArtifactKey,
  transcriptScope,
  type TranscriptArtifactUploader,
} from './transcriptArtifact.js';

/**
 * #584 — `transcribe_recording`: the ONLY byte path from a stored audio
 * recording into agent knowledge (no auto-transcription anywhere).
 *
 * One call produces two artifacts:
 * 1. the canonical, UNMASKED Transcript Artifact in the blob store
 *    (`transcriptArtifact.ts` — never goes to wire/LLM), and
 * 2. the derived recall projection: chunk turns through the shared
 *    `SessionLogger.log()` path, MASKED via `maskPrompt` before logging
 *    (dataset-import precedent) — markdown, knowledge graph and every
 *    LLM-facing surface see masked text only.
 *
 * Idempotence: the artifact's existence is the ingest marker — re-ingesting
 * a `recordingId` is a no-op. The artifact is therefore written only AFTER
 * every projection dependency resolved, but BEFORE the chunks are logged
 * (canonical truth first; the projection is derived and disposable).
 *
 * Duration cap + metering land in the follow-up metering commit (#584).
 */

export interface TranscriptArtifactStore {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}

/** Structural slice of the orchestrator's `AttachmentReader`. */
export interface RecordingReader {
  readByStorageKey(
    storageKey: string,
  ): Promise<{ bytes: Buffer; contentType?: string; fileName?: string } | undefined>;
}

/** Structural slice of the orchestrator's `SessionLogger`. */
export interface TranscriptTurnLogger {
  log(entry: SessionLogEntry): Promise<{ turnExternalId: string }>;
}

export interface TranscribeRecordingToolDeps {
  /** All services resolve LAZILY (per tool call) — activation order is not
   *  guaranteed and providers may (de)register at runtime. */
  getTranscription(): TranscriptionService | undefined;
  getArtifactStore(): TranscriptArtifactStore | undefined;
  getRecordingReader(): RecordingReader | undefined;
  getSessionLogger(): TranscriptTurnLogger | undefined;
  currentUploader(): TranscriptArtifactUploader | undefined;
  log?(msg: string): void;
}

export const transcribeRecordingToolSpec: NativeToolSpec = {
  name: 'transcribe_recording',
  description:
    'Transkribiert eine im Blob-Store liegende Audio-Aufnahme (Meeting, Sprachnotiz) über den konfigurierten Transcription-Provider und macht den Inhalt als Session-Wissen recallbar. Input ist der storage_key aus dem [attachments-info]-Block. Idempotent: eine bereits ingestierte Aufnahme wird nicht erneut transkribiert.',
  input_schema: {
    type: 'object',
    properties: {
      storage_key: {
        type: 'string',
        description:
          'Storage-Key der Aufnahme im Blob-Store (aus dem [attachments-info]-Block des Turns, z. B. transcription-uploads/…).',
      },
      recording_start: {
        type: 'string',
        description:
          'Beginn der Aufnahme als ISO-8601-Zeitstempel (z. B. "2026-08-19T09:00:00Z"). Optional — Default ist der Upload-Zeitpunkt.',
      },
    },
    required: ['storage_key'],
  },
};

interface ParsedInput {
  storageKey: string;
  recordingStart?: Date;
}

function parseInput(input: unknown): ParsedInput | string {
  if (typeof input !== 'object' || input === null) {
    return 'Fehler: Tool-Input muss ein Objekt mit storage_key sein.';
  }
  const record = input as Record<string, unknown>;
  const storageKey = record['storage_key'];
  if (typeof storageKey !== 'string' || storageKey.trim().length === 0) {
    return "Fehler: 'storage_key' fehlt oder ist leer.";
  }
  const rawStart = record['recording_start'];
  if (rawStart === undefined || rawStart === null || rawStart === '') {
    return { storageKey: storageKey.trim() };
  }
  if (typeof rawStart !== 'string' || Number.isNaN(Date.parse(rawStart))) {
    return "Fehler: 'recording_start' ist kein gültiger ISO-8601-Zeitstempel.";
  }
  return { storageKey: storageKey.trim(), recordingStart: new Date(rawStart) };
}

export async function handleTranscribeRecording(
  input: unknown,
  deps: TranscribeRecordingToolDeps,
): Promise<string> {
  const log = deps.log ?? ((): void => undefined);
  const parsed = parseInput(input);
  if (typeof parsed === 'string') return parsed;

  const recordingId = recordingIdFor(parsed.storageKey);
  const artifactKey = transcriptArtifactKey(recordingId);
  const scope = transcriptScope(recordingId);

  // Resolve EVERY dependency before any side effect: a half-ingest (artifact
  // written, projection impossible) would turn the idempotence no-op into
  // permanent chunk loss on retry.
  const store = deps.getArtifactStore();
  if (!store) {
    return 'Fehler: Blob-Store (tigrisStore) nicht konfiguriert — Transkription nicht möglich.';
  }
  const reader = deps.getRecordingReader();
  if (!reader) {
    return 'Fehler: Attachment-Reader nicht verfügbar — Transkription nicht möglich.';
  }
  const service = deps.getTranscription();
  if (!service) {
    return 'Fehler: Kein Transcription-Provider aktiv. Ein Operator muss unter Admin → Transcription-Provider einen Provider auswählen und einen API-Key hinterlegen.';
  }
  const logger = deps.getSessionLogger();
  if (!logger) {
    return 'Fehler: Session-Logger nicht verfügbar — Transkription nicht möglich.';
  }

  if (await store.exists(artifactKey)) {
    return `Aufnahme bereits ingestiert (recordingId=${recordingId}) — keine erneute Transkription. Transcript-Artifact: ${artifactKey}; Recall-Scope '${scope}'.`;
  }

  const recording = await reader.readByStorageKey(parsed.storageKey);
  if (!recording) {
    return `Fehler: Aufnahme unter storage_key '${parsed.storageKey}' nicht gefunden.`;
  }

  const recordingStart =
    parsed.recordingStart ?? uploadTimeFromKey(parsed.storageKey) ?? new Date();

  let transcript: Transcript;
  try {
    transcript = await service.transcribeFile({
      data: recording.bytes,
      filename: recording.fileName ?? parsed.storageKey.split('/').pop() ?? 'recording',
      ...(recording.contentType ? { mimeType: recording.contentType } : {}),
    });
  } catch (err) {
    if (err instanceof TranscriptionError) {
      return `Fehler bei der Transkription (${err.code}): ${err.message}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Fehler bei der Transkription: ${message}`;
  }

  const uploader = deps.currentUploader();
  const artifact = buildTranscriptArtifact({
    recordingId,
    storageKey: parsed.storageKey,
    recordingStart,
    createdAt: new Date(),
    ...(uploader ? { uploader } : {}),
    transcript,
  });
  await store.put(
    artifactKey,
    Buffer.from(JSON.stringify(artifact, null, 2), 'utf8'),
    'application/json',
  );
  log(
    `[transcription] artifact written (recordingId=${recordingId}, segments=${String(artifact.segments.length)}, timing=${artifact.timing})`,
  );

  // v1 resolves no label→person mapping, so the line label IS the Speaker
  // Label (display-name-or-label rule, ticket 02).
  const chunks = projectTranscriptChunks(
    artifact.segments.map((segment) => ({
      label: segment.speaker,
      text: segment.text,
      ...(segment.startMs !== undefined ? { startMs: segment.startMs } : {}),
    })),
  );

  // Mask BEFORE logging (dataset-import precedent): markdown, graph and all
  // LLM-facing paths see masked text only. The pseudonym map threads through
  // the chunks so one real value keeps one surrogate across the recording.
  // (Surrogates can differ in length from the real values, so a masked chunk
  // may drift slightly past the char budget — accepted: the budget guards
  // against wholesale amputation, not single-surrogate jitter.)
  const detectors = [createBaselineDetector()];
  let pseudonyms: PseudonymMap | undefined;
  let logged = 0;
  try {
    for (const chunk of chunks) {
      const masked = await maskPrompt(chunk.text, detectors, pseudonyms);
      pseudonyms = masked.map;
      await logger.log({
        scope,
        userMessage: masked.maskedText,
        assistantAnswer: '',
        time: new Date(recordingStart.getTime() + chunk.offsetMs),
        losslessUserMessage: true,
      });
      logged += 1;
    }
  } catch (err) {
    // The artifact (canonical truth) is already durable, and its existence is
    // the idempotence marker — a retry will no-op, so a swallowed failure
    // here would silently lose the remaining chunks forever. Say so.
    const message = err instanceof Error ? err.message : String(err);
    log(
      `[transcription] projection FAILED after ${String(logged)}/${String(chunks.length)} chunks (recordingId=${recordingId}) — ${message}`,
    );
    return `Fehler: Transcript-Artifact wurde geschrieben (${artifactKey}), aber die Recall-Projektion brach nach ${String(logged)} von ${String(chunks.length)} Chunks ab: ${message}. Ein erneuter Aufruf ist ein No-op (Idempotenz) — die fehlenden Chunks müssen manuell nachgezogen werden.`;
  }
  log(
    `[transcription] projection logged (scope=${scope}, chunks=${String(chunks.length)})`,
  );

  const speakers = [...new Set(artifact.segments.map((s) => s.speaker))];
  return [
    `Aufnahme transkribiert (recordingId=${recordingId}).`,
    `- Transcript-Artifact: ${artifactKey} (kanonisch, unmaskiert im Blob-Store)`,
    `- Segmente: ${String(artifact.segments.length)}, Sprecher: ${speakers.join(', ') || DEFAULT_SPEAKER_LABEL}, timing=${artifact.timing}${artifact.detectedLanguages ? `, Sprachen: ${artifact.detectedLanguages.join(', ')}` : ''}`,
    `- Recall-Projektion: ${String(chunks.length)} Chunk-Turn(s) in Scope '${scope}' (maskiert), Zeitbasis ${artifact.recordingStart}`,
  ].join('\n');
}
