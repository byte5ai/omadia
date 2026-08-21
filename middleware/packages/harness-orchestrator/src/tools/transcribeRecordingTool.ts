import {
  TranscriptionQuotaExceededError,
  TranscriptionRealtimeDisabledError,
  type TranscriptionService,
} from '@omadia/plugin-api';
import { z } from 'zod';

import type { SessionLogger } from '../sessionLogger.js';
import type { AttachmentReader } from './readAttachmentTool.js';
import { turnContext } from '../turnContext.js';

export const TRANSCRIBE_RECORDING_TOOL_NAME = 'transcribe_recording';

/**
 * `transcribe_recording` — #584 Workstream I (batch ingestion of recorded
 * audio).
 *
 * Reads an uploaded audio attachment, transcribes it via the `transcription@1`
 * capability (async/batch path), and ingests the result into the SAME
 * artifact substrate a live chat session produces: speaker-attributed
 * session-log entries → markdown transcript + KG turns + briefing
 * availability. Live and batch paths converge in memory by construction.
 *
 * PRIVACY. The transcript this tool returns is a tool result, so it rides the
 * orchestrator's per-turn privacy handle (the choke point wrapped around
 * every LLM call site) before any model reads it — the same treatment every
 * untrusted external input gets. Producing the transcript sends the raw audio
 * to the configured external provider; that egress is the provider plugin's
 * operator-consented integration, declared in its manifest and admin panel.
 *
 * Degrades gracefully: no `transcription@1` provider installed → a clear,
 * model-readable error string, never a throw.
 */

const TranscribeRecordingInputSchema = z.object({
  storage_key: z.string().min(1).max(1024),
  language_hints: z.array(z.string().min(1).max(16)).max(8).optional(),
  keyword_hints: z.array(z.string().min(1).max(120)).max(64).optional(),
  context: z.string().max(2000).optional(),
});

export const transcribeRecordingToolSpec = {
  name: TRANSCRIBE_RECORDING_TOOL_NAME,
  description:
    'Transkribiert eine vom User hochgeladene AUDIO-Datei (Meeting-Mitschnitt, Anruf, Sprachnotiz) über ihren `storage_key` und legt das Transkript als Session-Protokoll ab (durchsuchbar, mit Sprecher-Attribution soweit verfügbar). ' +
    'Die `storage_key`-Werte stehen im `[attachments-info]`-Block am Ende der User-Nachricht. ' +
    'Optional: `language_hints` (erwartete Sprachen, z.B. ["de","en"]), `keyword_hints` (Namen/Fachbegriffe, die im Audio vorkommen können) und `context` (Freitext zum Setting) verbessern die Genauigkeit deutlich — nutze sie, wenn Teilnehmer oder Thema bekannt sind.',
  input_schema: {
    type: 'object' as const,
    properties: {
      storage_key: {
        type: 'string',
        description:
          'Der `storage_key` der Audio-Datei aus dem `[attachments-info]`-Block.',
      },
      language_hints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Erwartete Sprachen als ISO-Codes, z.B. ["de", "en"].',
      },
      keyword_hints: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Begriffe, die im Audio vorkommen können (Teilnehmernamen, Produktnamen, Fachjargon).',
      },
      context: {
        type: 'string',
        description:
          'Freitext-Kontext zur Aufnahme (Thema, Anlass, Teilnehmer).',
      },
    },
    required: ['storage_key'],
  },
};

/** How much transcript text the tool result may carry back to the model. */
const RESULT_TEXT_MAX = 12_000;

export interface TranscribeRecordingToolDeps {
  readonly reader: AttachmentReader;
  /** Late-bound: the provider plugin may (de)activate any time. */
  readonly getTranscription: () => TranscriptionService | undefined;
  /**
   * Per-call logger factory keyed by the CURRENT turn's agent slug, so
   * transcript turns land in the same per-agent graph partition the chat
   * turns of that agent use. `undefined` slug = legacy unqualified scope.
   */
  readonly makeSessionLogger: (
    agentSlug: string | undefined,
  ) => SessionLogger | undefined;
}

export class TranscribeRecordingTool {
  constructor(private readonly deps: TranscribeRecordingToolDeps) {}

  async handle(input: unknown): Promise<string> {
    const parsed = TranscribeRecordingInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid transcribe_recording input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const service = this.deps.getTranscription();
    if (!service) {
      return 'Error: kein Transkriptions-Provider installiert — der Operator muss ein transcription@1-Plugin (z.B. "Transkription (OpenAI)") installieren und konfigurieren.';
    }

    const key = parsed.data.storage_key;
    let transcript;
    try {
      const found = await this.deps.reader.readByStorageKey(key);
      if (!found) {
        return `Error: attachment \`${key}\` not found (storage unconfigured or key unknown).`;
      }
      transcript = await service.transcribeFile(
        {
          bytes: found.bytes,
          ...(found.fileName !== undefined ? { fileName: found.fileName } : {}),
          ...(found.contentType !== undefined
            ? { contentType: found.contentType }
            : {}),
        },
        {
          ...(parsed.data.language_hints !== undefined
            ? { languageHints: parsed.data.language_hints }
            : {}),
          ...(parsed.data.keyword_hints !== undefined
            ? { keywordHints: parsed.data.keyword_hints }
            : {}),
          ...(parsed.data.context !== undefined
            ? { context: parsed.data.context }
            : {}),
        },
      );
    } catch (err) {
      if (err instanceof TranscriptionQuotaExceededError) {
        return `Error: ${err.message}`;
      }
      if (err instanceof TranscriptionRealtimeDisabledError) {
        return `Error: ${err.message}`;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: failed to transcribe attachment \`${key}\` — ${msg}.`;
    }

    // Ingest failures must NOT discard the transcript: the provider call is
    // billed and the text exists, so a broken store answers with the
    // transcript plus an honest "not persisted" note instead of an error.
    let logged = 0;
    let ingestFailure: string | undefined;
    try {
      logged = await this.ingest(key, transcript.segments, transcript);
    } catch (err) {
      ingestFailure = err instanceof Error ? err.message : String(err);
    }
    return renderResult(key, transcript, logged, ingestFailure);
  }

  /** One session-log entry per attributed utterance (single-segment
   *  transcripts land as one entry) — the artifact-shape convergence the
   *  acceptance criterion demands. Returns how many entries were written. */
  private async ingest(
    storageKey: string,
    segments: ReadonlyArray<{ text: string; speaker?: string; startMs?: number }>,
    transcript: { provider: string },
  ): Promise<number> {
    const turn = turnContext.current();
    const logger = this.deps.makeSessionLogger(turn?.agentSlug);
    if (!logger) return 0;
    const scope = turn?.sessionScope ?? `transcript-${sanitizeKey(storageKey)}`;
    const userId = turn?.resolvedOmadiaUserId ?? turn?.userId;

    // Per-utterance timestamps: ingest time + the utterance's offset into the
    // recording. `turnNodeId` is millisecond-keyed, so same-ms entries would
    // silently merge into one graph turn — the strictly-monotonic guard also
    // covers identical offsets (overlapping speech from a diarizing provider)
    // and offset-less segments, while keeping the meeting's ordering readable.
    const baseMs = Date.now();
    let lastMs = -1;
    let written = 0;
    for (const segment of segments) {
      if (segment.text.trim() === '') continue;
      const candidateMs = baseMs + (segment.startMs ?? 0);
      const entryMs = Math.max(candidateMs, lastMs + 1);
      lastMs = entryMs;
      const time = new Date(entryMs).toISOString();
      await logger.log({
        scope,
        time,
        userMessage: segment.text,
        assistantAnswer: `_(Transkript-Ingest via ${transcript.provider}, Quelle: ${storageKey})_`,
        ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
        ...(userId !== undefined ? { userId } : {}),
      });
      written += 1;
    }
    return written;
  }
}

function renderResult(
  key: string,
  transcript: {
    text: string;
    segments: readonly unknown[];
    language?: string;
    durationMs?: number;
    provider: string;
  },
  loggedEntries: number,
  ingestFailure?: string,
): string {
  const meta = [
    `Provider: ${transcript.provider}`,
    ...(transcript.language !== undefined
      ? [`Sprache: ${transcript.language}`]
      : []),
    ...(transcript.durationMs !== undefined
      ? [`Dauer: ${(transcript.durationMs / 60_000).toFixed(1)} min`]
      : []),
    `Segmente: ${String(transcript.segments.length)}`,
    ingestFailure !== undefined
      ? `Session-Protokoll: NICHT abgelegt (${ingestFailure})`
      : loggedEntries > 0
        ? `Session-Protokoll: ${String(loggedEntries)} Einträge abgelegt`
        : 'Session-Protokoll: nicht abgelegt (kein Logger verfügbar)',
  ].join(' · ');
  const text =
    transcript.text.length <= RESULT_TEXT_MAX
      ? transcript.text
      : `${transcript.text.slice(0, RESULT_TEXT_MAX)}\n\n…[gekürzt, Original ${String(transcript.text.length)} Zeichen — vollständig im Session-Protokoll]`;
  return `Transkript von \`${key}\`\n${meta}\n\n${text}`;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
}
