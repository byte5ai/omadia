import { existsSync } from 'node:fs';
import path from 'node:path';

import { EmbeddingError, type EmbeddingProvider } from '@omadia/plugin-api';

/**
 * The keyless transport: a quantized sentence-transformer executed in this
 * process by onnxruntime, via `@huggingface/transformers`.
 *
 * WHY THIS ADAPTER EXISTS (OM-84, byte5ai/omadia#1003)
 * ---------------------------------------------------
 * omadia has two embedding providers and BOTH have an entry fee. The Ollama
 * adapter needs a local Ollama installation; the OpenAI-compatible adapter
 * needs an API key. A user on the subscription path has neither — they signed
 * in with a Claude subscription precisely so they would not have to hold a
 * key — so process memory, semantic search and dedup were simply off for them,
 * and #1003 only fixed the part where the dashboard claimed otherwise. This is
 * the other half: a provider with no key, no server and no account.
 *
 * MODEL CHOICE — MEASURED, NOT ASSUMED
 * ------------------------------------
 * `paraphrase-multilingual-MiniLM-L12-v2`, int8-quantized, 384 dimensions.
 * Three 384-d candidates were compared on German sentence pairs (3 paraphrase
 * pairs vs 3 unrelated pairs, mean cosine):
 *
 *   model                                  same    diff    margin
 *   paraphrase-multilingual-MiniLM-L12-v2  0.727   0.112   +0.344  ← chosen
 *   bge-small-en-v1.5                      0.782   0.589   +0.071
 *   multilingual-e5-small (query: prefix)   0.948   0.814   +0.100
 *
 * `margin` is the gap between the WORST same-pair and the BEST unrelated pair —
 * the only number that says whether a single threshold can separate them at
 * all. The chosen model is the only one where that gap is wide (0.580 vs
 * 0.236); the other two overlap so tightly that any threshold either merges
 * unrelated notes or splits genuine duplicates. The English-only model also
 * collapses on cross-lingual pairs (0.365), which matters for a German product
 * whose logs, tickets and invoices carry English terms.
 *
 * CONSEQUENCE FOR DEDUP — READ THIS BEFORE CHANGING THE MODEL
 * -----------------------------------------------------------
 * This model's cosine scale is NOT the scale the knowledge graph defaults to.
 * German paraphrases land at 0.58-0.73 here, while `process_dedup_threshold`
 * defaults to 0.90 — so with the default, dedup would never fire and would do
 * it silently, which is the exact failure class #1003 was about. The plugin
 * therefore names {@link RECOMMENDED_DEDUP_THRESHOLD} in its activation log
 * and its manifest help, and the provider catalog carries it to the admin UI.
 */

/** Pinned model repository. A revision pin lives in `scripts/fetch-model.mjs`;
 *  changing either without the other is how a corpus silently ends up mixing
 *  two vector spaces. */
export const LOCAL_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

/** Vector width this model emits. Asserted against the live model at
 *  activation — never trusted from this constant alone. */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/** `modelId` prefix, mirroring `ollama:` / `openai:` in the sibling adapters. */
export const LOCAL_MODEL_ID_PREFIX = 'local:';

/**
 * What `process_dedup_threshold` should be set to when this provider is
 * active. Derived from the measurement in the header: worst same-pair 0.580,
 * best unrelated pair 0.236 — 0.45 sits inside that gap with room on both
 * sides rather than hugging either edge.
 */
export const RECOMMENDED_DEDUP_THRESHOLD = 0.45;

/** Files `@huggingface/transformers` needs on disk to run fully offline. */
export const REQUIRED_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
] as const;

export interface LocalEmbeddingClientOptions {
  /**
   * Directory that holds the model cache — the parent of
   * `<org>/<model>/`, i.e. what transformers.js calls its `cacheDir`.
   */
  readonly modelDir: string;
  /** Hard cap on input length in characters, applied before tokenization. */
  readonly maxInputChars: number;
  /** Injectable loader so tests never touch onnxruntime or the filesystem. */
  readonly loadPipeline?: PipelineLoader;
}

/** The single call this adapter makes into transformers.js. */
export type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

export type PipelineLoader = (
  modelDir: string,
) => Promise<FeatureExtractor>;

/** Absolute path of the model directory inside a cache root. */
export function modelPath(modelDir: string): string {
  return path.join(modelDir, ...LOCAL_EMBEDDING_MODEL.split('/'));
}

/**
 * Which of the required files are missing from `modelDir`.
 *
 * Presence is checked file by file rather than by testing the directory: a
 * download interrupted halfway leaves the directory there, and transformers.js
 * would then fail deep inside onnxruntime with a message about a protobuf
 * parse. Naming the missing file is the difference between a user who knows
 * to re-run the fetch and a user who files a bug.
 */
export function missingModelFiles(modelDir: string): string[] {
  const root = modelPath(modelDir);
  return REQUIRED_MODEL_FILES.filter(
    (file) => !existsSync(path.join(root, ...file.split('/'))),
  );
}

/**
 * Load the model from `modelDir` with remote fetching switched OFF.
 *
 * Offline is the point, not an optimisation. transformers.js will otherwise
 * reach for the Hugging Face CDN on a cache miss, which would turn a missing
 * file into a silent multi-hundred-megabyte download on the first user turn —
 * inside a request, on a machine that may have no egress at all. The fetch is
 * an explicit, separate step (`npm run fetch-model`), and this path either
 * finds the weights or fails.
 */
async function loadFromDisk(modelDir: string): Promise<FeatureExtractor> {
  const transformers = (await import('@huggingface/transformers')) as {
    pipeline: (
      task: string,
      model: string,
      options: Record<string, unknown>,
    ) => Promise<FeatureExtractor>;
    env: { cacheDir?: string; allowRemoteModels?: boolean; localModelPath?: string };
  };
  transformers.env.cacheDir = modelDir;
  transformers.env.allowRemoteModels = false;
  return transformers.pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL, {
    dtype: 'q8',
    local_files_only: true,
  });
}

/**
 * An `EmbeddingProvider` backed by the on-disk model.
 *
 * The pipeline is built LAZILY and memoised: constructing it costs a few
 * seconds of onnxruntime session setup plus a 128 MB read, which must not
 * happen during `activate()` — a plugin that blocks boot for that long is
 * worse than one that pays the cost on the first embed. Concurrent first
 * callers share one in-flight load rather than racing two sessions into
 * memory.
 */
export function createLocalEmbeddingClient(
  options: LocalEmbeddingClientOptions,
): EmbeddingProvider {
  const load = options.loadPipeline ?? loadFromDisk;
  let pending: Promise<FeatureExtractor> | undefined;

  const extractor = async (): Promise<FeatureExtractor> => {
    if (!pending) {
      pending = load(options.modelDir).catch((err: unknown) => {
        // Drop the rejected promise so a transient failure (a half-written
        // file replaced since, a temporarily unreadable mount) can be retried
        // instead of being cached as permanent.
        pending = undefined;
        throw new EmbeddingError(
          `local embedding model could not be loaded from ${modelPath(options.modelDir)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    return pending;
  };

  return {
    modelId: `${LOCAL_MODEL_ID_PREFIX}${LOCAL_EMBEDDING_MODEL.split('/').pop() ?? LOCAL_EMBEDDING_MODEL}`,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    async embed(text: string): Promise<number[]> {
      const input = text.slice(0, options.maxInputChars);
      if (input.trim().length === 0) {
        // An all-whitespace input yields a vector of the padding token, which
        // is a real point in the space and would cluster every blank note
        // together at cosine 1.0. Refusing is the honest answer.
        throw new EmbeddingError('refusing to embed empty text');
      }
      const fe = await extractor();
      const out = await fe(input, { pooling: 'mean', normalize: true });
      const vector = Array.from(out.data, Number);
      if (vector.length !== LOCAL_EMBEDDING_DIMENSIONS) {
        // The model on disk is not the model this adapter promises. Publishing
        // its vectors would mix two spaces in one column, which cosine
        // similarity cannot detect and no later check can repair.
        throw new EmbeddingError(
          `local model emitted ${String(vector.length)} dimensions, expected ${String(
            LOCAL_EMBEDDING_DIMENSIONS,
          )} — the model directory does not hold ${LOCAL_EMBEDDING_MODEL}`,
        );
      }
      return vector;
    },
  };
}
