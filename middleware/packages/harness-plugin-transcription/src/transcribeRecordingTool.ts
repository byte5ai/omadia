import type { NativeToolSpec } from '@omadia/plugin-api';
import type { SessionLogEntry } from '@omadia/orchestrator';
import {
  createBaselineDetector,
  maskPrompt,
  type PseudonymMap,
} from '@omadia/plugin-privacy-guard';
import {
  DEFAULT_MAX_SOURCE_MINUTES,
  TranscriptionError,
  type Transcript,
  type TranscriptionMeteringConfig,
  type TranscriptionService,
} from '@omadia/transcription-api';

import { projectTranscriptChunks } from './chunkProjection.js';
import {
  deriveBilledMinutes,
  formatMinutes,
  probeSourceMinutes as probeSourceMinutesDefault,
  type MeteredMinutes,
  type TranscriptionUsageMeter,
} from './metering.js';
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
 * Metering (#584, see `metering.ts`): pre-flight header probe → duration
 * cap (Source Minutes, FAIL-CLOSED on unprobeable duration) → per-agent
 * monthly quota (Billed Minutes, LEVEL-triggered: calls run while the
 * month's committed sum is under the limit, the crossing call completes, the
 * next blocks; FAIL-OPEN with an audit warning on a metering-DB error) →
 * provider call → one ledger row per provider call (success AND error path —
 * a retried-then-failed call has still been billed) + Source/Billed Minutes
 * onto the run trace (visibility only; the table is truth).
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
  /** #584 — duration cap + model id, published live by the active adapter.
   *  Absent ⇒ cap falls back fail-safe to DEFAULT_MAX_SOURCE_MINUTES. */
  getMeteringConfig(): TranscriptionMeteringConfig | undefined;
  /** #584 — usage ledger seam. Absent ⇒ nothing books, quota unenforced. */
  getUsageMeter(): TranscriptionUsageMeter | undefined;
  /** #584 — the agent's `_transcription_minutes_quota`. `undefined` =
   *  unlimited (empty field); an explicit 0 blocks every call. */
  getQuotaMinutes(): number | undefined;
  /** #584 — header probe override for tests; default is the real
   *  `music-metadata` probe. `undefined` result = fail-closed rejection. */
  probeSourceMinutes?(bytes: Buffer): Promise<number | undefined>;
  /** #584 — hands Source/Billed Minutes to the run trace (`toolUsageSink`).
   *  Visibility only — never load-bearing for billing or quota. */
  reportUsage?(usage: MeteredMinutes): void;
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

  // #584 — duration cap (Source Minutes), pre-flight, FAIL-CLOSED: the
  // upload endpoint deliberately probes nothing (#584), and the size
  // cap is no duration ceiling. Unprobeable duration ⇒ rejection.
  const probe = deps.probeSourceMinutes ?? probeSourceMinutesDefault;
  const sourceMinutes = await probe(recording.bytes);
  if (sourceMinutes === undefined) {
    return 'Fehler: Die Dauer der Aufnahme konnte nicht aus dem Datei-Header ermittelt werden — Transkription abgelehnt (Duration-Cap prüft fail-closed).';
  }
  const metering = deps.getMeteringConfig();
  const capMinutes = metering?.maxSourceMinutes() ?? DEFAULT_MAX_SOURCE_MINUTES;
  if (sourceMinutes > capMinutes) {
    return `Fehler: Aufnahme ist ${formatMinutes(sourceMinutes)} Minuten lang und überschreitet die maximale Aufnahmedauer von ${String(capMinutes)} Minuten (max_source_minutes).`;
  }

  // #584 — per-agent monthly quota (Billed Minutes), LEVEL-triggered like
  // the dev-job budget: every call whose committed month sum is at/over the
  // limit blocks; the call that crosses still completes (overshoot bounded
  // by one duration-cap length, no mid-run abort). FAIL-OPEN with an audit
  // warning on a metering-DB error — a broken meter must not 402 legitimate
  // work; the loss is surfaced, not swallowed. A missing metering store
  // (in-memory KG) makes the quota structurally unenforceable — the sum
  // comes back `undefined` and the call proceeds (documented on the
  // recorder).
  const meter = deps.getUsageMeter();
  const quotaMinutes = deps.getQuotaMinutes();
  if (quotaMinutes !== undefined && meter) {
    try {
      const monthSum = await meter.sumBilledMinutesThisMonth();
      if (monthSum !== undefined && monthSum >= quotaMinutes) {
        return `Fehler: Die monatliche Transkriptions-Quota dieses Agents ist erreicht (${formatMinutes(monthSum)} von ${String(quotaMinutes)} Minuten verbraucht). Weitere Transkriptionen sind ab dem nächsten Kalendermonat wieder möglich; ein Operator kann die Quota unter _transcription_minutes_quota anpassen.`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[transcription] WARNING: Quota-Prüfung fehlgeschlagen — fail-open, Aufruf läuft weiter (agent-quota=${String(quotaMinutes)} min): ${message}`,
      );
    }
  }

  const model = metering?.model('file') ?? 'unknown';
  const bookUsage = (usage: { attempts: number; attemptDurationsMs?: number[] }): MeteredMinutes => {
    const minutes: MeteredMinutes = {
      sourceMinutes,
      billedMinutes: deriveBilledMinutes(usage, sourceMinutes),
    };
    // Ledger row (truth) — fire-and-forget; trace field (visibility).
    meter?.record({ ...minutes, model, recordingId });
    deps.reportUsage?.(minutes);
    return minutes;
  };

  let transcript: Transcript;
  try {
    transcript = await service.transcribeFile({
      data: recording.bytes,
      filename: recording.fileName ?? parsed.storageKey.split('/').pop() ?? 'recording',
      ...(recording.contentType ? { mimeType: recording.contentType } : {}),
    });
  } catch (err) {
    if (err instanceof TranscriptionError) {
      // #584 — the error path books too: a retried-then-failed batch call
      // has still been billed per attempt (`TranscriptionError.usage`).
      if (err.usage) bookUsage(err.usage);
      return `Fehler bei der Transkription (${err.code}): ${err.message}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Fehler bei der Transkription: ${message}`;
  }
  const metered = bookUsage(transcript.usage);

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
  // Label (display-name-or-label rule, #584).
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
    `- Metering: ${formatMinutes(metered.sourceMinutes)} Source-Minuten, ${formatMinutes(metered.billedMinutes)} Billed-Minuten (geschätzt, Modell ${model})`,
  ].join('\n');
}
