import {
  PINNED_MODEL_TOTAL_BYTES,
  fetchLocalEmbeddingModel,
  type FetchProgress,
} from './fetchModel.js';
import { missingModelFiles } from './localEmbeddingClient.js';

/**
 * `localEmbeddingModelFetcher` — the service that makes the keyless path
 * clickable.
 *
 * WHY A SERVICE AND NOT AN IMPORT IN THE ROUTE
 * `embeddingProviderCatalog.ts` states the rule: the kernel names the embedding
 * adapters by id and reads what they publish structurally, but never imports
 * them — either adapter may be uninstalled, and a build dependency on them
 * would invert that. A download, unlike the dimension previews next door,
 * cannot tolerate a duplicated table either: the pinned revision and the four
 * SHA-256 digests are what stand between a corpus and a silently mixed vector
 * space, so they must live in exactly one place. Publishing a service satisfies
 * both — the plugin keeps the pin, the route keeps its distance.
 *
 * It is published EVEN WHEN THE WEIGHTS ARE MISSING, which is the only moment
 * it is useful. That is also why it is a separate service from
 * `embeddingClient`: that one means "embeddings work", this one means "here is
 * how to make them work", and conflating them would have the admin page ask a
 * capability that does not exist yet whether it can install itself.
 */

export type FetchJobState = 'idle' | 'running' | 'done' | 'failed';

export interface LocalEmbeddingModelStatus {
  /** Cache root the adapter reads — shown so an operator can see WHERE. */
  readonly modelDir: string;
  /** Empty ⇒ the adapter can publish the capability. */
  readonly missingFiles: readonly string[];
  readonly totalBytes: number;
  readonly job: {
    readonly state: FetchJobState;
    readonly downloadedBytes: number;
    readonly totalBytes: number;
    readonly currentFile: string | null;
    /** Set only in `failed`. Kept until the next run so the UI can show it. */
    readonly error: string | null;
  };
}

/** Structural contract the admin route reads. Keep in sync with
 *  `LocalEmbeddingModelFetcher` in `adminEmbeddingProvider.ts`. */
export interface LocalEmbeddingModelFetcher {
  status(): LocalEmbeddingModelStatus;
  /** Single-flight. `false` ⇒ a run was already in progress. */
  start(): boolean;
}

export interface ModelFetcherOptions {
  readonly modelDir: string;
  readonly log: (message: string) => void;
  /** Injectable for tests — no test may reach huggingface.co. */
  readonly fetchImpl?: typeof fetch;
}

export function createLocalEmbeddingModelFetcher(
  options: ModelFetcherOptions,
): LocalEmbeddingModelFetcher {
  let state: FetchJobState = 'idle';
  let progress: FetchProgress = {
    downloadedBytes: 0,
    totalBytes: PINNED_MODEL_TOTAL_BYTES,
  };
  let error: string | null = null;

  return {
    status: () => ({
      modelDir: options.modelDir,
      missingFiles: missingModelFiles(options.modelDir),
      totalBytes: PINNED_MODEL_TOTAL_BYTES,
      job: {
        state,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        currentFile: progress.currentFile ?? null,
        error,
      },
    }),

    start: () => {
      // Single-flight by state, not by a lock: two operators clicking at once
      // would otherwise write the same 135 MB through the same `.partial`
      // paths and race the renames.
      if (state === 'running') return false;
      state = 'running';
      error = null;
      progress = { downloadedBytes: 0, totalBytes: PINNED_MODEL_TOTAL_BYTES };

      // Deliberately NOT awaited. The caller is an HTTP handler and this takes
      // minutes; the route answers 202 and the UI polls `status()`.
      void fetchLocalEmbeddingModel({
        targetDir: options.modelDir,
        onProgress: (next) => {
          progress = next;
        },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
        .then((result) => {
          state = 'done';
          options.log(
            `[embedding-adapter-local] weights ready in ${result.modelDir} ` +
              `(${String(result.fetched)} file(s) fetched). ` +
              'Activate the adapter to publish embeddingClient@1.',
          );
        })
        .catch((err: unknown) => {
          state = 'failed';
          error = err instanceof Error ? err.message : String(err);
          options.log(`[embedding-adapter-local] weight download failed: ${error}`);
        });

      return true;
    },
  };
}
