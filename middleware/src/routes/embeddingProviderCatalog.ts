/**
 * #440 follow-up — what the kernel needs to know about the shipped
 * `embeddingClient@1` adapters, and nothing more.
 *
 * WHY A LOCAL TABLE RATHER THAN AN IMPORT. `src/health/kgHealth.ts` already
 * sets the precedent: the kernel names the embedding adapters by id and reads
 * what they publish structurally, but never imports them. Importing
 * `@omadia/embeddings` / `@omadia/embedding-adapter-openai` here just to reach
 * their dimension resolvers would invert that — the kernel would take a hard
 * build dependency on the two mutually-exclusive adapters, either of which the
 * operator may uninstall. (The knowledge-graph package IS imported by the
 * router next door, but for a different reason: it owns the governed vector
 * columns, so its catalog probes are the single source of truth for which
 * columns a switch touches.)
 *
 * The numbers below are therefore a PREVIEW mirror of each adapter's own
 * resolver (`resolveOllamaDimensions`, `defaultDimensionsForModel`), used only
 * to tell the operator, before they commit, whether a switch is going to change
 * the vector-column width. The authoritative width is whatever the adapter
 * publishes as provider metadata at activation, and the authoritative verdict
 * is the gate outcome the switch returns afterwards — a stale entry here costs
 * a slightly vaguer preview, never a wrong migration.
 */

export const EMBEDDING_CLIENT_CAPABILITY = 'embeddingClient@1';
export const KG_NEON_ID = '@omadia/knowledge-graph-neon';
export const OLLAMA_PROVIDER_ID = '@omadia/embeddings';
export const OPENAI_PROVIDER_ID = '@omadia/embedding-adapter-openai';
/** OM-84 (#1003) — the keyless adapter: no server, no key, no account. */
export const LOCAL_PROVIDER_ID = '@omadia/embedding-adapter-local';
/** KG setup field wired to `EmbeddingModelGateOptions.autoMigrateVectorColumns`. */
export const AUTO_MIGRATE_CONFIG_KEY = 'auto_migrate_vector_columns';
/**
 * KG setup field that decides which tenant the plugin's stores, gate and
 * backfill operate on. Operator-settable in the KG setup form, which is why
 * anything pricing that corpus has to read it rather than assuming the env
 * var — see `resolveGraphTenantId` in `adminEmbeddingProvider.ts`.
 */
export const GRAPH_TENANT_ID_CONFIG_KEY = 'graph_tenant_id';

/** Structural view of `PluginCatalog` — only what this router reads, so tests
 *  can pass a two-entry stub instead of loading manifests off disk. */
export interface EmbeddingProviderCatalog {
  list(): ReadonlyArray<{
    plugin: { id: string; name: string; provides: readonly string[] };
  }>;
  get(id: string): { plugin: { id: string; name: string } } | undefined;
}

/** Preview mirror of the two adapters' known-model tables. */
const KNOWN_MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  // @omadia/embeddings (Ollama)
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'bge-m3': 1024,
  'all-minilm': 384,
  // @omadia/embedding-adapter-openai
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  // @omadia/embedding-adapter-local — the model is pinned in the adapter, so
  // this entry is the whole table for it rather than a menu.
  'paraphrase-multilingual-MiniLM-L12-v2': 384,
};

interface ProviderConfigKeys {
  readonly modelKey: string;
  readonly defaultModel: string;
  readonly dimensionsKey: string;
}

const PROVIDER_CONFIG_KEYS: Readonly<Record<string, ProviderConfigKeys>> = {
  [OLLAMA_PROVIDER_ID]: {
    modelKey: 'ollama_model',
    defaultModel: 'nomic-embed-text',
    dimensionsKey: 'embedding_dimensions',
  },
  [OPENAI_PROVIDER_ID]: {
    modelKey: 'model',
    defaultModel: 'text-embedding-3-small',
    dimensionsKey: 'dimensions',
  },
  // The local adapter exposes no model field: its model is pinned in code
  // together with the digests its fetch script verifies, because a corpus that
  // silently mixes two vector spaces cannot be repaired afterwards. `modelKey`
  // therefore names a field that does not exist in its manifest, which reads
  // back as "unset" and lands on `defaultModel` — the pinned one — every time.
  [LOCAL_PROVIDER_ID]: {
    modelKey: 'model',
    defaultModel: 'paraphrase-multilingual-MiniLM-L12-v2',
    dimensionsKey: 'dimensions',
  },
};

export interface ProviderConfigDescription {
  /** Model name as configured, or null for an adapter we know nothing about. */
  readonly modelId: string | null;
  /** Vector width the switch would land on, or null when it cannot be told
   *  ahead of activation (unknown model with no operator-supplied width, or a
   *  width that contradicts the known model — the adapter refuses that too). */
  readonly dimensions: number | null;
}

/** Ollama tags (`nomic-embed-text:v1.5`) are not part of the lookup key. */
function baseModelName(model: string): string {
  const colon = model.indexOf(':');
  return colon === -1 ? model : model.slice(0, colon);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  const asString = readString(value);
  if (asString === undefined) return undefined;
  const parsed = Number.parseInt(asString, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Model + width a provider would come up with, given its stored config.
 *
 * Mirrors both adapters' rule exactly: the known model wins, an unknown model
 * needs the operator's number, and a contradiction resolves to `null` rather
 * than to a preference — the adapters refuse to publish a contradictory width,
 * so predicting one here would be predicting a state that cannot happen.
 */
export function describeProviderConfig(
  pluginId: string,
  config: Record<string, unknown>,
): ProviderConfigDescription {
  const keys = PROVIDER_CONFIG_KEYS[pluginId];
  if (!keys) return { modelId: null, dimensions: null };
  const model = readString(config[keys.modelKey]) ?? keys.defaultModel;
  const configured = readPositiveInt(config[keys.dimensionsKey]);
  const known = KNOWN_MODEL_DIMENSIONS[baseModelName(model)];
  if (known !== undefined && configured !== undefined && known !== configured) {
    return { modelId: model, dimensions: null };
  }
  return { modelId: model, dimensions: known ?? configured ?? null };
}
