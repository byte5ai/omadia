import type { PluginContext } from '@omadia/plugin-api';

import {
  createEmbeddingClient,
  withConcurrencyLimit,
  type EmbeddingClient,
} from './embeddingClient.js';

/**
 * @omadia/embeddings — plugin entry point.
 *
 * **S+9.1 Sub-Commit 2b: capability lifetime flipped.** activate() now
 * constructs the Ollama-wrapped EmbeddingClient (with a concurrency
 * limiter on top) and publishes it via
 * `ctx.services.provide('embeddingClient', client)`. Consumers that
 * declared `requires: ["embeddingClient@^1"]` in their manifest pick it
 * up via the regular `ctx.services.get` path. The Pre-S+8.5 kernel-side
 * bridge in `src/index.ts` is gone.
 *
 * Config (via ctx.config, seeded by `bootstrapEmbeddingsFromEnv` from
 * the legacy OLLAMA_BASE_URL / OLLAMA_EMBEDDING_MODEL etc. .env vars):
 *   - `ollama_base_url`     required for activation; empty → no client
 *   - `ollama_model`        default 'nomic-embed-text'
 *   - `ollama_timeout_ms`   default 30000
 *   - `max_concurrent`      default 4 (0 disables the limiter)
 *
 * Empty `ollama_base_url` → plugin activates without publishing a
 * client. The capability-resolver still sees `provides: embeddingClient@1`
 * in the manifest, so consumers pass the install-time gate; at runtime
 * `ctx.services.get` returns undefined and the consumers fall back to
 * their no-embedding paths (in-memory KG, FTS-only retrieval, no topic
 * detection). This preserves the pre-S+9 graceful-degradation behaviour
 * for dev / CI runs without an Ollama sidecar.
 */

const EMBEDDING_CLIENT_SERVICE = 'embeddingClient';

export interface EmbeddingsPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<EmbeddingsPluginHandle> {
  const baseUrl = (ctx.config.get<string>('ollama_base_url') ?? '').trim();
  const model =
    (ctx.config.get<string>('ollama_model') ?? '').trim() || 'nomic-embed-text';
  const timeoutMs = parsePositiveInt(
    ctx.config.get<unknown>('ollama_timeout_ms'),
    30_000,
  );
  const maxConcurrent = parseIntOrDefault(
    ctx.config.get<unknown>('max_concurrent'),
    4,
  );

  if (!baseUrl) {
    ctx.log(
      '[harness-embeddings] no ollama_base_url configured — plugin active but capability not published; consumers will degrade to no-embedding paths',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-embeddings] deactivating (no client was built)');
      },
    };
  }

  const raw: EmbeddingClient = createEmbeddingClient({
    baseUrl,
    model,
    timeoutMs,
  });
  const client: EmbeddingClient = withConcurrencyLimit(raw, maxConcurrent);

  const dispose = ctx.services.provide(EMBEDDING_CLIENT_SERVICE, client);
  ctx.log(
    `[harness-embeddings] ready (baseUrl=${baseUrl}, model=${model}, timeoutMs=${String(timeoutMs)}, maxConcurrent=${String(maxConcurrent)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-embeddings] deactivating');
      dispose();
    },
  };
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
