import {
  EmbeddingError,
  type EmbeddingClient,
} from '@omadia/plugin-api';
import { fetch as undiciFetch } from 'undici';

/**
 * Thin client for Ollama's `/api/embeddings` endpoint. We keep the surface
 * minimal because the only caller is TopicDetector. Larger Ollama features
 * (chat completions, generation) stay out — Anthropic handles LLM calls.
 *
 * Ollama response shape: `{ "embedding": number[] }` on success, or a JSON
 * error object. We normalise to either a vector or a thrown error.
 *
 * #440: the `EmbeddingClient` contract itself moved to `@omadia/plugin-api`
 * so a second adapter does not have to depend on this package for its types.
 * This file is now one adapter among several, and re-exports the contract for
 * source compatibility.
 */

export const OLLAMA_MODEL_ID_PREFIX = 'ollama:';

/** nomic-embed-text — the model the compose/Fly sidecar pulls by default. */
export const DEFAULT_OLLAMA_EMBEDDING_DIMENSIONS = 768;

/**
 * Vector length per Ollama model, for the models we have actually verified.
 * Used to derive the published `dimensions` so the declared width and the
 * configured model cannot silently disagree (#440). An unknown model is not
 * guessed — see `resolveOllamaDimensions`.
 */
const KNOWN_OLLAMA_MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  'nomic-embed-text': DEFAULT_OLLAMA_EMBEDDING_DIMENSIONS,
  'mxbai-embed-large': 1024,
  'bge-m3': 1024,
  'all-minilm': 384,
};

/** Strip an Ollama tag (`nomic-embed-text:v1.5`) before the table lookup. */
function baseModelName(model: string): string {
  const colon = model.indexOf(':');
  return colon === -1 ? model : model.slice(0, colon);
}

export type OllamaDimensionsResolution =
  /** Verified width — safe to publish as provider metadata. */
  | { kind: 'resolved'; dimensions: number }
  /** No known width and no operator-supplied one. */
  | { kind: 'unknown' }
  /** Operator-supplied width contradicts the model's known width. */
  | { kind: 'conflict'; configured: number; known: number };

/**
 * Decide which vector length to publish, or refuse to publish one.
 *
 * The rule mirrors the OpenAI adapter: known model wins, unknown model needs
 * the operator, and a contradiction is an error rather than a preference —
 * a `dimensions` value nobody confirmed is exactly what the KG gate cannot
 * protect against.
 */
export function resolveOllamaDimensions(
  model: string,
  configured: number | undefined,
): OllamaDimensionsResolution {
  const known = KNOWN_OLLAMA_MODEL_DIMENSIONS[baseModelName(model)];
  if (configured !== undefined && known !== undefined && configured !== known) {
    return { kind: 'conflict', configured, known };
  }
  const dimensions = known ?? configured;
  return dimensions === undefined
    ? { kind: 'unknown' }
    : { kind: 'resolved', dimensions };
}

export interface EmbeddingClientOptions {
  baseUrl: string;
  /** Model name served by the sidecar. Default matches our compose/Fly pull. */
  model?: string;
  /** Abort after this many ms if Ollama is slow. Default 30 s — generous
   * enough to survive a cold-start model-load (nomic-embed-text takes 2-5 s
   * on a fresh Fly machine). Topic-detection is still cheap because after
   * the first call `OLLAMA_KEEP_ALIVE` keeps the model warm. */
  timeoutMs?: number;
  /** VERIFIED vector length the model emits — published as provider metadata
   *  so the KG dimension gate can compare it against the stored corpus. Leave
   *  `undefined` when it is not verified: the client is then published without
   *  metadata and the gate treats the provider as "identity unknown", exactly
   *  as it did before #440. Never pass a guess. */
  dimensions?: number;
}

export function createEmbeddingClient(
  options: EmbeddingClientOptions,
): EmbeddingClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const model = options.model ?? 'nomic-embed-text';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { dimensions } = options;

  return {
    ...(dimensions === undefined
      ? {}
      : { modelId: `${OLLAMA_MODEL_ID_PREFIX}${model}`, dimensions }),
    async embed(text: string): Promise<number[]> {
      let response;
      try {
        response = await undiciFetch(`${base}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new EmbeddingError(
          `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new EmbeddingError(
          `Ollama /api/embeddings responded ${String(response.status)}`,
          response.status,
          body.slice(0, 500),
        );
      }
      const json = (await response.json()) as { embedding?: unknown };
      if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
        throw new EmbeddingError('Ollama returned no embedding vector');
      }
      // Defensive — Ollama sometimes returns numeric strings in edge cases.
      const vec = (json.embedding as unknown[]).map((v) => {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) {
          throw new EmbeddingError('Ollama returned a non-numeric embedding entry');
        }
        return n;
      });
      return vec;
    },
  };
}

/**
 * Cosine similarity between two vectors. Returns NaN for zero-length inputs
 * so callers can guard against "the embedding returned garbage" rather than
 * silently treating it as 0 (which would look like "totally different").
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return Number.NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
