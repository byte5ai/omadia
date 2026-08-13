/**
 * Provider-neutral embedding contract (#440).
 *
 * The interface used to live inside `@omadia/embeddings` — the Ollama
 * adapter — so every alternative provider would have had to depend on the
 * Ollama package just for its types. It now sits next to the other capability
 * contracts (mirrors `LlmProviderDescriptor` in `@omadia/llm-provider-api`),
 * and `@omadia/embeddings` re-exports it for source compatibility with
 * out-of-repo plugins that consume the built `dist/`.
 *
 * The capability name stays `embeddingClient@1`: this is a relocation plus a
 * metadata extension, not a new capability.
 */

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

/**
 * What a provider must say about itself so a consumer can tell whether the
 * vectors it is about to write belong in the same space as the ones already
 * stored. Cosine similarity across two models is silent garbage — this is the
 * only thing standing between a provider swap and weeks of degraded recall.
 */
export interface EmbeddingProviderMetadata {
  /** Provider-qualified model identity, e.g. `ollama:nomic-embed-text`. */
  readonly modelId: string;
  /** Vector length the model emits. Must match the KG's vector column. */
  readonly dimensions: number;
}

/** The shape every `embeddingClient@1` adapter publishes. */
export interface EmbeddingProvider
  extends EmbeddingClient,
    EmbeddingProviderMetadata {}

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

/**
 * Wrap an EmbeddingClient so at most `max` concurrent `embed()` calls reach
 * the underlying transport. Extra callers queue (FIFO) until a slot frees.
 *
 * Why: a local Ollama serialises CPU-bound inference per request, and a hosted
 * API answers a burst with 429s — firing 30 embeds in parallel (boot replay +
 * backfill sweep + live ingest + fact extractor) produces widespread failures
 * rather than 30x throughput. This cap turns bursts into an orderly queue.
 * Every adapter uses it, which is why it sits on the contract package.
 *
 * A non-positive `max` disables the limit and returns the input unchanged,
 * so callers can switch behaviour via config without a branch at the call
 * site. Generic over the client type so provider metadata survives the
 * wrapper — the KG gate reads it off the wrapped instance.
 */
export function withConcurrencyLimit<T extends EmbeddingClient>(
  client: T,
  max: number,
): T {
  if (max <= 0) return client;
  const waiters: Array<() => void> = [];
  let active = 0;
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };
  // Adapters return plain object literals, so the spread carries `modelId` /
  // `dimensions` through; TS cannot prove a literal satisfies an open
  // generic, hence the assertion.
  return {
    ...client,
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
  } as T;
}

/**
 * Narrow a resolved `embeddingClient` service to its provider metadata.
 *
 * Returns `undefined` for clients that carry none — test doubles and
 * pre-#440 out-of-repo adapters are plain `{ embed }` objects. Consumers
 * treat that as "provider identity unknown" rather than as a mismatch, so an
 * old adapter keeps working instead of being blocked by the safety gate.
 */
export function readEmbeddingProviderMetadata(
  client: EmbeddingClient | undefined,
): EmbeddingProviderMetadata | undefined {
  if (!client) return undefined;
  const candidate = client as Partial<EmbeddingProviderMetadata>;
  const { modelId, dimensions } = candidate;
  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    return undefined;
  }
  if (!Number.isInteger(dimensions) || (dimensions ?? 0) <= 0) {
    return undefined;
  }
  return { modelId: modelId.trim(), dimensions: dimensions as number };
}
