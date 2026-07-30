import {
  EmbeddingError,
  type EmbeddingProvider,
} from '@omadia/plugin-api';
import { fetch as undiciFetch } from 'undici';

/**
 * OpenAI-compatible embedding transport (#440).
 *
 * `POST {base}/v1/embeddings` with `{ model, input }` and a bearer token is
 * the de-facto wire format: api.openai.com, Azure OpenAI behind a gateway,
 * vLLM, LM Studio, llama.cpp's server, LiteLLM, and most hosted clones all
 * speak it. That is the whole reason this adapter exists — one implementation
 * covers everything except Ollama's native `/api/embeddings` shape, which
 * `@omadia/embeddings` already handles.
 *
 * We hand-roll the request with undici instead of using the `openai` SDK: the
 * ESLint `no-restricted-imports` rule confines that SDK to
 * `packages/llm-provider`, and a single POST does not justify widening it.
 */

export const OPENAI_MODEL_ID_PREFIX = 'openai:';

/**
 * Vector length per model, for models where we know it. Used only as the
 * default for the operator-facing `dimensions` setting — an unknown model
 * simply requires the operator to fill the field in.
 */
const KNOWN_MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

export function defaultDimensionsForModel(model: string): number | undefined {
  return KNOWN_MODEL_DIMENSIONS[model];
}

export interface OpenAiEmbeddingClientOptions {
  /** API base. `https://api.openai.com/v1` and `https://host` both work — a
   *  trailing `/v1` is not duplicated. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Vector length the model emits. Published as provider metadata AND
   *  enforced on every response — a server that silently switches model
   *  would otherwise poison the vector column one row at a time. */
  dimensions: number;
  /** Hard-cancel per embed() call. Default 30 s, matching the Ollama adapter. */
  timeoutMs?: number;
}

/** Strip trailing slashes and an explicit `/v1` so we can always append it. */
function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/, '');
}

export function createOpenAiEmbeddingClient(
  options: OpenAiEmbeddingClientOptions,
): EmbeddingProvider {
  const endpoint = `${normaliseBaseUrl(options.baseUrl)}/v1/embeddings`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { model, dimensions } = options;

  return {
    modelId: `${OPENAI_MODEL_ID_PREFIX}${model}`,
    dimensions,
    async embed(text: string): Promise<number[]> {
      let response;
      try {
        response = await undiciFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model, input: text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new EmbeddingError(
          `OpenAI-compatible embeddings request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new EmbeddingError(
          `OpenAI-compatible /v1/embeddings responded ${String(response.status)}`,
          response.status,
          body.slice(0, 500),
        );
      }
      const json = (await response.json()) as {
        data?: { embedding?: unknown }[];
      };
      const first = Array.isArray(json.data) ? json.data[0] : undefined;
      const raw = first?.embedding;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new EmbeddingError(
          'OpenAI-compatible endpoint returned no embedding vector',
        );
      }
      // Defensive, same reasoning as the Ollama adapter: some clones return
      // numeric strings, and a NaN slipping into pgvector is unrecoverable.
      const vec = (raw as unknown[]).map((v) => {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) {
          throw new EmbeddingError(
            'OpenAI-compatible endpoint returned a non-numeric embedding entry',
          );
        }
        return n;
      });
      if (vec.length !== dimensions) {
        throw new EmbeddingError(
          `embedding dimension mismatch: configured ${String(dimensions)}, endpoint returned ${String(vec.length)} for model '${model}'`,
        );
      }
      return vec;
    },
  };
}
