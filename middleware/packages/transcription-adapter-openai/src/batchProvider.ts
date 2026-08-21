import type {
  TranscribeFileRef,
  TranscribeOpts,
  Transcript,
  TranscriptSegment,
} from '@omadia/plugin-api';
import { fetch as undiciFetch, FormData } from 'undici';

/**
 * Batch transcription over `POST {base}/v1/audio/transcriptions` (#584 WS T).
 *
 * Wire format (developers.openai.com, file-transcription guide, 2026-08):
 * multipart form with `file`, `model` (default `gpt-transcribe`), plus the
 * three context inputs the new transcribe models accept — free-form `prompt`,
 * literal `keywords[]`, and `languages[]` (PLURAL: the new models take a
 * language list; the singular `language` field belongs to the legacy
 * whisper-era models). Array fields use the `name[]` repeated-entry multipart
 * convention the endpoint documents for `known_speaker_names[]`.
 *
 * We hand-roll the request with undici instead of the `openai` SDK for the
 * same reason `embedding-adapter-openai` does: the ESLint
 * `no-restricted-imports` rule confines that SDK to `packages/llm-provider`,
 * and a single multipart POST does not justify widening it.
 */

export const DEFAULT_BATCH_MODEL = 'gpt-transcribe';

export class TranscriptionRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`transcription request failed (HTTP ${String(status)}): ${detail}`);
  }
}

export interface OpenAiBatchTranscriberOptions {
  /** API base; `https://api.openai.com` and `…/v1` both work. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Hard-cancel per call. */
  readonly timeoutMs: number;
  /** Injectable transport for tests. */
  readonly fetchImpl?: typeof undiciFetch;
}

/** Strip trailing slashes and an explicit `/v1` so we can always append it. */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/, '');
}

export interface OpenAiBatchTranscriber {
  transcribeFile(
    ref: TranscribeFileRef,
    opts?: TranscribeOpts,
  ): Promise<Transcript>;
}

export function createOpenAiBatchTranscriber(
  options: OpenAiBatchTranscriberOptions,
): OpenAiBatchTranscriber {
  const doFetch = options.fetchImpl ?? undiciFetch;
  const endpoint = `${normaliseBaseUrl(options.baseUrl)}/v1/audio/transcriptions`;
  const providerId = `openai:${options.model}`;

  return {
    async transcribeFile(
      ref: TranscribeFileRef,
      opts?: TranscribeOpts,
    ): Promise<Transcript> {
      const form = new FormData();
      form.append(
        'file',
        new Blob([toArrayBufferView(ref.bytes)], {
          type: ref.contentType ?? 'application/octet-stream',
        }),
        ref.fileName ?? 'audio',
      );
      form.append('model', options.model);
      if (opts?.context !== undefined && opts.context.trim() !== '') {
        form.append('prompt', opts.context);
      }
      for (const keyword of opts?.keywordHints ?? []) {
        form.append('keywords[]', keyword);
      }
      for (const language of opts?.languageHints ?? []) {
        form.append('languages[]', language);
      }

      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal =
        opts?.signal === undefined
          ? timeout
          : AbortSignal.any([opts.signal, timeout]);

      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal,
      });
      if (!response.ok) {
        const detail = truncate(await response.text().catch(() => ''), 500);
        throw new TranscriptionRequestError(response.status, detail);
      }
      const body: unknown = await response.json();
      return parseTranscriptionResponse(body, providerId);
    },
  };
}

/**
 * Parse the JSON response defensively. The default `json` format is `{text}`;
 * richer formats add `segments` (with `start`/`end` seconds and optionally a
 * `speaker` label) plus `duration` and `language`. Anything absent stays
 * absent on the neutral shape — no invented timestamps.
 */
export function parseTranscriptionResponse(
  body: unknown,
  providerId: string,
): Transcript {
  if (typeof body !== 'object' || body === null) {
    throw new TranscriptionRequestError(200, 'unexpected non-object response');
  }
  const record = body as Record<string, unknown>;
  const text = typeof record['text'] === 'string' ? record['text'] : '';

  const segments = parseSegments(record['segments']);
  const durationSeconds = record['duration'];
  const language = record['language'];

  return {
    text,
    segments: segments.length > 0 ? segments : text === '' ? [] : [{ text }],
    ...(typeof language === 'string' ? { language } : {}),
    ...(typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
      ? { durationMs: Math.round(durationSeconds * 1000) }
      : {}),
    provider: providerId,
  };
}

function parseSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const seg = entry as Record<string, unknown>;
    const text = seg['text'];
    if (typeof text !== 'string' || text === '') continue;
    const start = seg['start'];
    const end = seg['end'];
    const speaker = seg['speaker'];
    out.push({
      text,
      ...(typeof start === 'number' && Number.isFinite(start)
        ? { startMs: Math.round(start * 1000) }
        : {}),
      ...(typeof end === 'number' && Number.isFinite(end)
        ? { endMs: Math.round(end * 1000) }
        : {}),
      ...(typeof speaker === 'string' && speaker !== ''
        ? { speaker }
        : {}),
    });
  }
  return out;
}

/** Undici's Blob wants a plain ArrayBuffer-backed view; re-wrap defensively so
 *  a Uint8Array over a SharedArrayBuffer or an offset view still uploads the
 *  right bytes. */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
