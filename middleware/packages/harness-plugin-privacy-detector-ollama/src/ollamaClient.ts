/**
 * Thin HTTP client for the Ollama chat + tags endpoints.
 *
 * Surface is intentionally small — only what the NER detector needs:
 *   - `chat()` does a single POST to `/api/chat` with `format: "json"`
 *     and `stream: false`, returning the model's `message.content` string.
 *   - `health()` does a GET to `/api/tags`, returning `true` on 2xx.
 *
 * Errors do NOT leak as exceptions on `chat()` — instead the caller
 * (nerDetector) catches and logs. We export a `OllamaTransportError`
 * so tests can assert a specific failure shape.
 *
 * No retries. The detector layer fails open per call (returns zero
 * hits); a stuck Ollama would amplify into latency stacking if we
 * retried inside the client.
 */

import { fetch as undiciFetch } from 'undici';

import type { ChatMessage } from './nerPrompt.js';

export interface OllamaChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly timeoutMs: number;
  /** Override for tests. Default: undici's `fetch`. */
  readonly fetchImpl?: typeof undiciFetch;
}

export interface OllamaChatClient {
  /**
   * Returns the assistant `message.content` string from Ollama's
   * `/api/chat` JSON response. Caller is responsible for parsing the
   * content against the NER schema (it's still a JSON string-in-string
   * because `format: "json"` is enforced via the request, not the
   * transport).
   */
  chat(req: OllamaChatRequest): Promise<string>;
  /** GET /api/tags — used at boot to surface a clear log line if the
   *  sidecar is unreachable. Returns true iff the response is 2xx. */
  health(timeoutMs?: number): Promise<boolean>;
}

export class OllamaTransportError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly bodyExcerpt?: string,
  ) {
    super(message);
    this.name = 'OllamaTransportError';
  }
}

export interface OllamaChatClientOptions {
  /** Base URL of the Ollama daemon. Trailing slashes are normalised. */
  readonly baseUrl: string;
  /** Override for tests. Default: undici's `fetch`. */
  readonly fetchImpl?: typeof undiciFetch;
  /** Default timeout for `health()` in ms. Default 1500ms. */
  readonly healthTimeoutMs?: number;
}

export function createOllamaChatClient(
  options: OllamaChatClientOptions,
): OllamaChatClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const defaultFetch = options.fetchImpl ?? undiciFetch;
  const defaultHealthTimeoutMs = options.healthTimeoutMs ?? 1500;

  return {
    async chat(req: OllamaChatRequest): Promise<string> {
      const fetchImpl = req.fetchImpl ?? defaultFetch;
      let response;
      try {
        response = await fetchImpl(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            stream: false,
            format: 'json',
            options: {
              // Lower temperature → more JSON-faithful output on small
              // models. Not zero so the model can still find names it
              // hasn't seen verbatim.
              temperature: 0.1,
            },
          }),
          signal: AbortSignal.timeout(req.timeoutMs),
        });
      } catch (err) {
        throw new OllamaTransportError(
          `Ollama /api/chat request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new OllamaTransportError(
          `Ollama /api/chat responded ${String(response.status)}`,
          response.status,
          body.slice(0, 500),
        );
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new OllamaTransportError(
          `Ollama /api/chat returned non-JSON envelope: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const content = extractContent(json);
      if (content === undefined) {
        throw new OllamaTransportError(
          'Ollama /api/chat envelope missing message.content',
        );
      }
      return content;
    },

    async health(timeoutMs?: number): Promise<boolean> {
      try {
        const response = await defaultFetch(`${base}/api/tags`, {
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

function extractContent(envelope: unknown): string | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const message = (envelope as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string') return undefined;
  return content;
}
