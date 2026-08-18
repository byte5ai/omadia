/**
 * OpenAI implementation of the `transcription@1` capability
 * (`@omadia/transcription-api`).
 *
 * Batch (`transcribeFile`): `client.audio.transcriptions.create` with model
 * `gpt-transcribe`. The provider returns a single text blob (no word/segment
 * timestamps on this model), so the adapter reports **one segment per file**
 * (`id: 'seg-0'`) with `timing: 'none'` — it invents no structure the provider
 * did not attribute. Hint mapping is intent → wire param:
 * `languageHints` → `languages`, `keywordHints` → `keywords`,
 * `context` → `prompt`. No `speaker` is ever set — `gpt-transcribe` does not
 * diarize; the default Speaker Label is the ingestion tool's job.
 *
 * Metering: `TranscriptionUsage.attempts` counts provider calls actually sent,
 * INCLUDING SDK-internal retries. The SDK exposes no retry hook, so each
 * `transcribeFile` call builds its own client around a counting fetch wrapper
 * (client construction is a plain object allocation — no connection setup).
 * On failure the thrown `TranscriptionError` carries the partial usage, so
 * every paid attempt is bookable even on the error path.
 *
 * Realtime (`transcribeStream`): not-implemented stub. The manifest declares
 * only the batch model's `file` surface, so no caller can legally reach it;
 * the realtime follow-up PR (gpt-live-transcribe via `OpenAIRealtimeWS`)
 * replaces the stub and adds the `stream` surface entry. The `'session-limit'`
 * error code is therefore never produced here — it is realtime-only.
 */
import {
  TranscriptionError,
  type AudioFile,
  type Transcript,
  type TranscriptDelta,
  type TranscribeOptions,
  type TranscriptionErrorCode,
  type TranscriptionService,
  type TranscriptionUsage,
} from '@omadia/transcription-api';
import { APIUserAbortError, toFile } from 'openai';

import {
  createOpenAiTranscriptionClient,
  type OpenAiTranscriptionClientOptions,
} from './openaiClient.js';

/** The provider-side model name for the batch surface. */
export const OPENAI_BATCH_TRANSCRIPTION_MODEL = 'gpt-transcribe';

/** Same knobs as the client factory minus `fetch` — the service owns fetch:
 *  each call wraps it with the attempt counter. */
export type OpenAiTranscriptionServiceOptions = Omit<
  OpenAiTranscriptionClientOptions,
  'fetch'
>;

export function createOpenAiTranscriptionService(
  options: OpenAiTranscriptionServiceOptions,
): TranscriptionService {
  return {
    async transcribeFile(
      audio: AudioFile,
      opts?: TranscribeOptions,
    ): Promise<Transcript> {
      let attempts = 0;
      const countingFetch: typeof globalThis.fetch = (input, init) => {
        // The SDK also routes `data:` URLs through fetch while encoding the
        // multipart form (blob conversion) — those are not provider calls.
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!url.startsWith('data:')) attempts += 1;
        return globalThis.fetch(input, init);
      };
      const client = createOpenAiTranscriptionClient({
        ...options,
        fetch: countingFetch,
      });
      try {
        const file = await toFile(
          audio.data,
          audio.filename,
          audio.mimeType !== undefined ? { type: audio.mimeType } : undefined,
        );
        const response = await client.audio.transcriptions.create(
          {
            file,
            model: OPENAI_BATCH_TRANSCRIPTION_MODEL,
            ...(opts?.languageHints !== undefined
              ? { languages: [...opts.languageHints] }
              : {}),
            ...(opts?.keywordHints !== undefined
              ? { keywords: [...opts.keywordHints] }
              : {}),
            ...(opts?.context !== undefined ? { prompt: opts.context } : {}),
          },
          opts?.signal !== undefined ? { signal: opts.signal } : undefined,
        );
        // Empty `languages` means "nothing reliably detected" — same
        // information as an omitted optional field, so omit.
        const detected = response.languages?.map((l) => l.code);
        const detectedLanguages =
          detected !== undefined && detected.length > 0
            ? { detectedLanguages: detected }
            : {};
        return {
          segments: [{ id: 'seg-0', text: response.text, ...detectedLanguages }],
          timing: 'none',
          ...detectedLanguages,
          usage: { attempts },
        };
      } catch (err) {
        throw toTranscriptionError(err, { attempts });
      }
    },

    transcribeStream(): AsyncIterable<TranscriptDelta> {
      throw new TranscriptionError(
        'provider',
        "transcribeStream is not implemented: the realtime surface (gpt-live-transcribe) lands in the follow-up PR. The manifest declares no 'stream' surface, so reaching this stub means a caller bypassed the model registry.",
      );
    },
  };
}

/** Wrap a provider/transport failure into the contract's error class, carrying
 *  the partial usage so paid attempts stay bookable on the error path. */
function toTranscriptionError(
  err: unknown,
  usage: TranscriptionUsage,
): TranscriptionError {
  if (err instanceof TranscriptionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TranscriptionError(
    classifyOpenAiTranscriptionError(err),
    `OpenAI transcription failed: ${message}`,
    { usage, cause: err },
  );
}

/**
 * Map an OpenAI SDK error onto the `TranscriptionErrorCode` union.
 * Status-first (the reliable signal), then the machine-readable `code`, then
 * message heuristics for the 400s where OpenAI encodes the reason only in
 * prose. Everything unclassifiable is `'provider'`; `'session-limit'` is
 * realtime-only and never produced on the batch path.
 */
export function classifyOpenAiTranscriptionError(
  err: unknown,
): TranscriptionErrorCode {
  if (err instanceof APIUserAbortError) return 'aborted';
  const status = extractStatus(err);
  const code = extractCode(err);
  if (
    status === 401 ||
    status === 403 ||
    code === 'invalid_api_key' ||
    code === 'authentication_error' ||
    code === 'permission_denied'
  ) {
    return 'auth';
  }
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported-format';
  if (status === 400) {
    const message = err instanceof Error ? err.message : '';
    if (/format|codec|decod/i.test(message)) return 'unsupported-format';
    if (/too large|content size|exceed/i.test(message)) return 'too-large';
  }
  return 'provider';
}

// Duplicated from llm-adapter-openai's classifier helpers deliberately — this
// package must not depend on the LLM adapter, and the six lines below are the
// whole overlap.

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as Record<string, unknown>)['status'];
  return typeof status === 'number' ? status : undefined;
}

/** OpenAI's machine-readable identifier is `err.code`, mirrored at
 *  `err.error.code` on the raw body. `type` is a coarse category, ignored. */
function extractCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e['code'] === 'string') return e['code'];
  const nested = e['error'];
  if (typeof nested === 'object' && nested !== null) {
    const v = (nested as Record<string, unknown>)['code'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
