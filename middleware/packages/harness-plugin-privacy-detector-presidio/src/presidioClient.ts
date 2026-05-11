/**
 * Thin HTTP client for the Presidio sidecar (FastAPI + presidio-analyzer).
 *
 * Two endpoints — same surface as the Ollama client from Slice 3.2:
 *   - `analyze({ text, language, scoreThreshold, timeoutMs })` runs
 *     POST /analyze and returns the parsed hit list.
 *   - `health(timeoutMs?)` runs GET /health, returns true on 2xx.
 *
 * Errors propagate as `PresidioTransportError` so the detector layer
 * can discriminate timeout vs. transport vs. body-parse failures and
 * surface the right `PrivacyDetectorStatus` in the receipt.
 */

import { fetch as undiciFetch } from 'undici';

export interface PresidioAnalyzeRequest {
  readonly text: string;
  readonly language: string;
  readonly scoreThreshold: number;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof undiciFetch;
}

export interface PresidioRawHit {
  readonly entity_type: string;
  readonly start: number;
  readonly end: number;
  readonly score: number;
}

export interface PresidioAnalyzeResponse {
  readonly hits: ReadonlyArray<PresidioRawHit>;
}

export interface PresidioClient {
  analyze(req: PresidioAnalyzeRequest): Promise<PresidioAnalyzeResponse>;
  health(timeoutMs?: number): Promise<boolean>;
}

export class PresidioTransportError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly bodyExcerpt?: string,
  ) {
    super(message);
    this.name = 'PresidioTransportError';
  }
}

export interface PresidioClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof undiciFetch;
  readonly healthTimeoutMs?: number;
}

export function createPresidioClient(options: PresidioClientOptions): PresidioClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const defaultFetch = options.fetchImpl ?? undiciFetch;
  const defaultHealthTimeoutMs = options.healthTimeoutMs ?? 1500;

  return {
    async analyze(req: PresidioAnalyzeRequest): Promise<PresidioAnalyzeResponse> {
      const fetchImpl = req.fetchImpl ?? defaultFetch;
      let response;
      try {
        response = await fetchImpl(`${base}/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: req.text,
            language: req.language,
            score_threshold: req.scoreThreshold,
          }),
          signal: AbortSignal.timeout(req.timeoutMs),
        });
      } catch (err) {
        throw new PresidioTransportError(
          `Presidio /analyze request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new PresidioTransportError(
          `Presidio /analyze responded ${String(response.status)}`,
          response.status,
          body.slice(0, 500),
        );
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new PresidioTransportError(
          `Presidio /analyze returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = parseAnalyzeBody(json);
      if (parsed === undefined) {
        throw new PresidioTransportError('Presidio /analyze body shape did not match expected schema');
      }
      return parsed;
    },

    async health(timeoutMs?: number): Promise<boolean> {
      try {
        const response = await defaultFetch(`${base}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs ?? defaultHealthTimeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

function parseAnalyzeBody(envelope: unknown): PresidioAnalyzeResponse | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const hitsRaw = (envelope as { hits?: unknown }).hits;
  if (!Array.isArray(hitsRaw)) return undefined;
  const hits: PresidioRawHit[] = [];
  for (const h of hitsRaw) {
    if (typeof h !== 'object' || h === null) continue;
    const obj = h as Record<string, unknown>;
    const entity_type = obj['entity_type'];
    const start = obj['start'];
    const end = obj['end'];
    const score = obj['score'];
    if (
      typeof entity_type !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      typeof score !== 'number'
    ) {
      continue;
    }
    hits.push({ entity_type, start, end, score });
  }
  return { hits };
}
