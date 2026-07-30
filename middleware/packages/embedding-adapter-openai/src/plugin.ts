import {
  withConcurrencyLimit,
  type EmbeddingProvider,
  type PluginContext,
} from '@omadia/plugin-api';

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  createOpenAiEmbeddingClient,
  defaultDimensionsForModel,
} from './openaiEmbeddingClient.js';

/**
 * @omadia/embedding-adapter-openai — second `embeddingClient@1` provider (#440).
 *
 * Same capability, different transport: where `@omadia/embeddings` talks to
 * Ollama's `/api/embeddings`, this one talks to the OpenAI `/v1/embeddings`
 * wire format (OpenAI, Azure via gateway, vLLM, LM Studio, LiteLLM, …).
 *
 * Exactly one provider may be active. `ctx.services.provide` throws on a
 * duplicate registration, so two-active is structurally impossible; on top of
 * that the manifest declares a `secret`-typed field, which makes the built-in
 * catch-all bootstrap skip auto-install (same mechanism the opt-in
 * memoryStore/KG siblings rely on). Installing this adapter is therefore an
 * explicit operator act, and the operator must uninstall or blank out the
 * Ollama adapter first.
 *
 * Config (`ctx.config`, from manifest `setup.fields`):
 *   - `base_url`   default https://api.openai.com
 *   - `model`      default text-embedding-3-small
 *   - `dimensions` NO default — derived from the known-model table, and only
 *     required for a model we do not know. See below.
 *   - `timeout_ms` default 30000
 *   - `max_concurrent` default 4 (0 disables the limiter)
 * Secret (`ctx.secrets`, Vault-backed — never plugin config):
 *   - `api_key`
 *
 * Without an api_key the plugin activates but publishes nothing, mirroring
 * the Ollama adapter's empty-base-url path: consumers degrade to their
 * no-embedding paths instead of the boot failing.
 *
 * Dimensions are never guessed. `dimensions` carries no manifest default on
 * purpose: bootstrap seeds non-secret manifest defaults into install config,
 * so a default would have followed the operator into every install and
 * silently contradicted whatever model they picked — the exact "publishes a
 * number nobody confirmed" failure the KG gate cannot defend against. The
 * resolution is: known model → its width; unknown model → the operator must
 * fill the field; both present and disagreeing → refuse to publish.
 */

const EMBEDDING_CLIENT_SERVICE = 'embeddingClient';
const DEFAULT_BASE_URL = 'https://api.openai.com';

export interface OpenAiEmbeddingsPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<OpenAiEmbeddingsPluginHandle> {
  const apiKey = (await ctx.secrets.get('api_key'))?.trim() ?? '';
  const baseUrl =
    (ctx.config.get<string>('base_url') ?? '').trim() || DEFAULT_BASE_URL;
  const model =
    (ctx.config.get<string>('model') ?? '').trim() ||
    DEFAULT_OPENAI_EMBEDDING_MODEL;
  const timeoutMs = parsePositiveInt(
    ctx.config.get<unknown>('timeout_ms'),
    30_000,
  );
  const maxConcurrent = parseIntOrDefault(
    ctx.config.get<unknown>('max_concurrent'),
    4,
  );
  const configuredDimensions = parseOptionalPositiveInt(
    ctx.config.get<unknown>('dimensions'),
  );
  const knownDimensions = defaultDimensionsForModel(model);

  if (!apiKey) {
    ctx.log(
      '[embedding-adapter-openai] no api_key in the vault — plugin active but capability not published; consumers degrade to no-embedding paths',
    );
    return { close: closeNoop(ctx) };
  }
  if (
    configuredDimensions !== undefined &&
    knownDimensions !== undefined &&
    configuredDimensions !== knownDimensions
  ) {
    // The configured model and the declared width contradict each other. One
    // of them is wrong and we cannot tell which, so publishing either would
    // be publishing an unconfirmed number.
    ctx.log(
      `[embedding-adapter-openai] '${model}' emits ${String(knownDimensions)}-dimensional vectors but 'dimensions' is set to ${String(configuredDimensions)} — refusing to publish a vector size that contradicts the model; fix one of the two`,
    );
    return { close: closeNoop(ctx) };
  }
  const dimensions = knownDimensions ?? configuredDimensions;
  if (dimensions === undefined) {
    // Refusing here beats publishing a client with unknown dimensions: the KG
    // gate would have nothing to compare and could not protect the corpus.
    ctx.log(
      `[embedding-adapter-openai] model '${model}' has no known vector size — set the 'dimensions' field; capability not published`,
    );
    return { close: closeNoop(ctx) };
  }

  const raw: EmbeddingProvider = createOpenAiEmbeddingClient({
    baseUrl,
    apiKey,
    model,
    dimensions,
    timeoutMs,
  });
  // Same FIFO limiter as the Ollama adapter — here it protects against
  // provider rate limits and runaway spend rather than sidecar CPU.
  const client: EmbeddingProvider = withConcurrencyLimit(raw, maxConcurrent);

  const dispose = ctx.services.provide(EMBEDDING_CLIENT_SERVICE, client);
  ctx.log(
    `[embedding-adapter-openai] ready (baseUrl=${baseUrl}, modelId=${client.modelId}, dimensions=${String(dimensions)}, timeoutMs=${String(timeoutMs)}, maxConcurrent=${String(maxConcurrent)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[embedding-adapter-openai] deactivating');
      dispose();
    },
  };
}

function closeNoop(ctx: PluginContext): () => Promise<void> {
  return async (): Promise<void> => {
    ctx.log('[embedding-adapter-openai] deactivating (no client was built)');
  };
}

/** `undefined` when the field is absent or not a positive integer — the
 *  caller must not substitute a guess. */
function parseOptionalPositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function parseIntOrDefault(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
