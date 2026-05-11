import { fetch as undiciFetch } from 'undici';

/**
 * Thin client for Ollama's `/api/embeddings` endpoint. We keep the surface
 * minimal because the only caller is TopicDetector. Larger Ollama features
 * (chat completions, generation) stay out — Anthropic handles LLM calls.
 *
 * Ollama response shape: `{ "embedding": number[] }` on success, or a JSON
 * error object. We normalise to either a vector or a thrown error.
 */

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
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
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export function createEmbeddingClient(
  options: EmbeddingClientOptions,
): EmbeddingClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const model = options.model ?? 'nomic-embed-text';
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
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
 * Wrap an EmbeddingClient so at most `max` concurrent `embed()` calls reach
 * the underlying transport. Extra callers queue (FIFO) until a slot frees.
 *
 * Why: `nomic-embed-text` in Ollama serialises CPU-bound inference per
 * request; firing 30 embeds in parallel (boot replay + backfill sweep +
 * live ingest + fact extractor) produces widespread timeouts rather than
 * 30× faster throughput. This cap turns bursts into an orderly queue.
 *
 * A non-positive `max` disables the limit and returns the input unchanged,
 * so callers can switch behaviour via config without a branch at the call
 * site.
 */
export function withConcurrencyLimit(
  client: EmbeddingClient,
  max: number,
): EmbeddingClient {
  if (max <= 0) return client;
  const waiters: Array<() => void> = [];
  let active = 0;
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };
  return {
    async embed(text: string): Promise<number[]> {
      if (active >= max) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      active++;
      try {
        return await client.embed(text);
      } finally {
        release();
      }
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
