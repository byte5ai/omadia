import {
  withConcurrencyLimit,
  type EmbeddingProvider,
  type PluginContext,
} from '@omadia/plugin-api';

import { createLocalEmbeddingModelFetcher } from './modelFetcherService.js';
import {
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  RECOMMENDED_DEDUP_THRESHOLD,
  createLocalEmbeddingClient,
  missingModelFiles,
  modelPath,
  type PipelineLoader,
} from './localEmbeddingClient.js';

/**
 * @omadia/embedding-adapter-local — the keyless `embeddingClient@1` provider
 * (OM-84 / byte5ai/omadia#1003, second half).
 *
 * Same capability as `@omadia/embeddings` (Ollama) and
 * `@omadia/embedding-adapter-openai`, with neither of their entry fees: no
 * server to install, no key to hold, no account. Inference runs in this
 * process on the CPU.
 *
 * Exactly one provider may be active. `ctx.services.provide` throws on a
 * duplicate registration, so two-active is structurally impossible; the
 * operator switches by uninstalling or blanking the other adapter.
 *
 * Config (`ctx.config`, from manifest `setup.fields`):
 *   - `model_dir`       where the weights live. Empty → the default below.
 *   - `max_input_chars` default 8000 — cut before tokenization.
 *   - `max_concurrent`  default 1. Local inference is CPU-bound and
 *     serialises anyway; a limiter above 1 buys nothing and competes with the
 *     kernel's own event loop.
 *
 * No secrets. That is the entire point of this adapter.
 *
 * WEIGHTS ARE NOT BUNDLED, AND THAT IS DELIBERATE
 * -----------------------------------------------
 * The quantized model plus its multilingual tokenizer is ~144 MB. omadia
 * stages the middleware's full `node_modules` into every desktop installer
 * (`desktop/scripts/stage-runtime.mjs`), so bundling the weights would add
 * that to macOS arm64, macOS x64, Windows and Linux alike — on top of an
 * installer already near 300 MB — for a provider most operators with a key or
 * an Ollama box will never activate. The weights are fetched once, on demand
 * (`npm run fetch-model --workspace @omadia/embedding-adapter-local`), and
 * until they are present this plugin activates and publishes NOTHING, exactly
 * as the Ollama adapter does without a base URL and the OpenAI adapter does
 * without a key. Consumers then degrade to their no-embedding paths instead of
 * boot failing — and, since #1003, the dashboard says so out loud.
 */

const EMBEDDING_CLIENT_SERVICE = 'embeddingClient';
/** Published even without weights — see `modelFetcherService.ts`. */
const MODEL_FETCHER_SERVICE = 'localEmbeddingModelFetcher';
/** Under the middleware's own tree, so a container bind-mount or a desktop
 *  data dir can redirect it with one config field. */
const DEFAULT_MODEL_DIR = 'var/embedding-models';
const DEFAULT_MAX_INPUT_CHARS = 8_000;
const DEFAULT_MAX_CONCURRENT = 1;

export interface LocalEmbeddingsPluginHandle {
  close(): Promise<void>;
}

/** Test seam: lets a test drive `activate` without onnxruntime on disk. */
export interface LocalEmbeddingsActivateOverrides {
  readonly loadPipeline?: PipelineLoader;
  readonly missingFiles?: (modelDir: string) => string[];
}

export async function activate(
  ctx: PluginContext,
  overrides: LocalEmbeddingsActivateOverrides = {},
): Promise<LocalEmbeddingsPluginHandle> {
  const modelDir =
    (ctx.config.get<string>('model_dir') ?? '').trim() || DEFAULT_MODEL_DIR;
  const maxInputChars = parsePositiveInt(
    ctx.config.get<unknown>('max_input_chars'),
    DEFAULT_MAX_INPUT_CHARS,
  );
  const maxConcurrent = parseIntOrDefault(
    ctx.config.get<unknown>('max_concurrent'),
    DEFAULT_MAX_CONCURRENT,
  );

  // Published on BOTH paths, and on the missing-weights path it is the whole
  // point: the admin page needs something to ask "can I install this?" exactly
  // when the capability does not exist yet. `provide` is wrapped because this
  // plugin may activate beside a sibling adapter (see the note further down)
  // and a duplicate name throws.
  const fetcher = createLocalEmbeddingModelFetcher({
    modelDir,
    log: (message) => ctx.log(message),
  });
  let disposeFetcher: (() => void) | undefined;
  try {
    disposeFetcher = ctx.services.provide(MODEL_FETCHER_SERVICE, fetcher);
  } catch (err) {
    ctx.log(
      `[embedding-adapter-local] ${MODEL_FETCHER_SERVICE} already provided ` +
        `(${err instanceof Error ? err.message : String(err)}) — not re-publishing`,
    );
  }
  const releaseFetcher = (): void => {
    disposeFetcher?.();
  };

  const missing = (overrides.missingFiles ?? missingModelFiles)(modelDir);
  if (missing.length > 0) {
    // Naming the first missing file rather than "model not found": the two
    // realistic causes — never fetched, and fetch interrupted — need
    // different reactions, and only the file list distinguishes them.
    ctx.log(
      `[embedding-adapter-local] model weights incomplete in ${modelPath(modelDir)} ` +
        `(missing: ${missing.join(', ')}) — plugin active but capability not published. ` +
        `Fetch them with: npm run fetch-model --workspace @omadia/embedding-adapter-local, ` +
        'or from ADMIN → LLM-Zugang → Embeddings, which drives the same download.',
    );
    return { close: closeNoop(ctx, releaseFetcher) };
  }

  const raw: EmbeddingProvider = createLocalEmbeddingClient({
    modelDir,
    maxInputChars,
    ...(overrides.loadPipeline ? { loadPipeline: overrides.loadPipeline } : {}),
  });
  const client: EmbeddingProvider = withConcurrencyLimit(raw, maxConcurrent);

  // STANDING DOWN BEATS THROWING.
  //
  // This adapter is an extension-kind built-in with no secret field, which is
  // exactly the shape `bootstrapBuiltInPackages` auto-installs — so on a normal
  // install it lands next to `@omadia/embeddings`, which is auto-installed too.
  // Only one `embeddingClient` may exist: a second `ctx.services.provide` under
  // the same name THROWS. That never fires on a default install, because the
  // weights are absent and we returned above — but an operator who fetches the
  // weights while Ollama is still configured would turn a two-provider config
  // into a failing `activate()`, and a plugin whose activate throws does not
  // come up at all.
  //
  // A pre-flight `services.get` would still race (both plugins activate in the
  // same boot) and would have to resolve a capability this plugin does not
  // declare, which the grant check refuses. Catching the duplicate is the only
  // form that is both race-free and honest about who won.
  let dispose: () => void;
  try {
    dispose = ctx.services.provide(EMBEDDING_CLIENT_SERVICE, client);
  } catch (err) {
    ctx.log(
      `[embedding-adapter-local] another ${EMBEDDING_CLIENT_SERVICE} provider is already active ` +
        `(${err instanceof Error ? err.message : String(err)}) — standing down, capability not published. ` +
        'Uninstall or blank out the Ollama / OpenAI-compatible adapter to switch to the keyless one.',
    );
    return { close: closeNoop(ctx, releaseFetcher) };
  }
  ctx.log(
    `[embedding-adapter-local] ${client.modelId} ready ` +
      `(${String(LOCAL_EMBEDDING_DIMENSIONS)}d, keyless, in-process, max_concurrent=${String(maxConcurrent)}). ` +
      `This model's cosine scale differs from the knowledge graph default: set ` +
      `process_dedup_threshold=${RECOMMENDED_DEDUP_THRESHOLD.toFixed(2)} — at the 0.90 default dedup never fires.`,
  );

  return {
    close: async () => {
      dispose();
      releaseFetcher();
      ctx.log('[embedding-adapter-local] capability withdrawn');
    },
  };
}

function closeNoop(
  ctx: PluginContext,
  release?: () => void,
): () => Promise<void> {
  return async () => {
    release?.();
    ctx.log(
      '[embedding-adapter-local] deactivated (embeddingClient was never published)',
    );
  };
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Unlike {@link parsePositiveInt} this admits 0, which
 *  `withConcurrencyLimit` reads as "no limit". */
function parseIntOrDefault(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export { LOCAL_EMBEDDING_MODEL };
