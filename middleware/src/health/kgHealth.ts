/**
 * KG health snapshot — the capability picture that actually governs recall
 * behaviour, built from the installed registry PLUS the knowledge-graph
 * plugin's embedding-gate outcome.
 *
 * Motivation: the embedding pipeline degrades SILENTLY. A deployment can have a
 * neon backend and an Ollama sidecar yet still run FTS-only (no semantic
 * recall, inert durable tier, no process-reuse) just because
 * `ollama_base_url` never reached the embeddings plugin config. That state was
 * only visible by reading boot logs. This snapshot surfaces it on `/health` so
 * the degradation is observable at a glance instead of diagnosed by archaeology.
 *
 * #440 added a second way to get there, and it is invisible to the registry:
 * the model/dimension gate can REFUSE the active provider (wrong vector width,
 * a corpus embedded with a different model, a stale-vector clear still owed).
 * The plugin then activates with `embeddingClient = undefined` — nothing is
 * ever embedded, `NeonProcessMemoryStore` rejects every write with
 * `embedding-unavailable` — while the registry still says an embeddings plugin
 * is active. A registry-only projection reports that as fully healthy, i.e. it
 * reproduces exactly the lie this file exists to prevent. So the gate publishes
 * its outcome as a service and the snapshot reads it.
 */
import type { InstalledRegistry } from '../plugins/installedRegistry.js';

const KG_NEON_ID = '@omadia/knowledge-graph-neon';
const KG_INMEMORY_ID = '@omadia/knowledge-graph-inmemory';
const EMBEDDINGS_ID = '@omadia/embeddings';
const EMBEDDINGS_OPENAI_ID = '@omadia/embedding-adapter-openai';

/**
 * ServiceRegistry name under which `@omadia/knowledge-graph-neon` publishes
 * its gate outcome. Structural contract — the plugin publishes a plain object,
 * this module only reads it, so neither side needs to import the other.
 */
export const EMBEDDING_GATE_STATUS_SERVICE = 'embeddingModelGateStatus';

/**
 * `reason` the gate publishes once a stale-vector clear has finished but the
 * process that started it is still running without an embedding client on the
 * hot path. Same structural contract as the service name above — the plugin
 * spells it in `gateStatusPublication.ts`; keep the two in sync.
 */
const CLEAR_COMPLETE_REASON = 'stale-vector-clear-complete';

/** What the #440 model/dimension gate decided on the last activation. */
export interface EmbeddingGateStatus {
  /** Did the gate let this boot's knowledge-graph write vectors? */
  vectorWritesAllowed: boolean;
  /** Gate outcome status verbatim: match | recorded | re-embedding | blocked | … */
  status: string;
  /** Block reason, or `stale-vector-clear-pending` while a switch is draining. */
  reason?: string;
  /** Model the active provider reports. */
  activeModelId?: string;
  /** Model the corpus was recorded with, when the two disagree. */
  storedModelId?: string;
  /** Extra operator-facing context, e.g. which columns disagree. */
  detail?: string;
}

export interface KgHealth {
  /** Active knowledge-graph backend. `none` means recall is fully unavailable. */
  backend: 'neon' | 'inmemory' | 'none';
  /** Whether KG state survives a process restart (neon = durable, inmemory = volatile). */
  durable: boolean;
  /** Whether embeddings are actually being written: a provider is configured
   *  AND the #440 model/dimension gate allowed vector writes. */
  embeddings: boolean;
  /** Semantic (vector) recall — requires embeddings. */
  semanticRecall: boolean;
  /** Durable always-surface tier — requires an embedding client to retrieve. */
  durableTier: boolean;
  /** Stored-process reuse — requires neon (only it provides processMemory) + embeddings. */
  processReuse: boolean;
  /** Human-readable degradation notes, empty when fully healthy. */
  warnings: string[];
}

/**
 * Build the KG health snapshot.
 *
 * `gate` is the knowledge-graph plugin's published gate outcome. It is
 * `undefined` when no neon backend is active (nothing to gate) or when the
 * plugin never got as far as evaluating — both read as "no gate opinion", and
 * the registry projection stands alone.
 */
export function buildKgHealth(
  registry: InstalledRegistry,
  gate?: EmbeddingGateStatus,
): KgHealth {
  const isActive = (id: string): boolean => registry.get(id)?.status === 'active';

  const neon = isActive(KG_NEON_ID);
  const inmemory = isActive(KG_INMEMORY_ID);
  const backend: KgHealth['backend'] = neon
    ? 'neon'
    : inmemory
      ? 'inmemory'
      : 'none';

  // Must match the embeddings plugin's OWN activation gate exactly: it
  // publishes the client iff `(ollama_base_url ?? '').trim()` is non-empty
  // (harness-embeddings/src/plugin.ts). A whitespace-only URL (settable via the
  // unvalidated UI config PATCH) publishes nothing, so .trim() here avoids a
  // false-healthy reading — the very lie this snapshot exists to prevent.
  const embUrl = registry.get(EMBEDDINGS_ID)?.config?.['ollama_base_url'];
  const ollamaEmbeddings =
    isActive(EMBEDDINGS_ID) &&
    typeof embUrl === 'string' &&
    embUrl.trim().length > 0;
  // #440: the Ollama plugin is one adapter among several. The OpenAI-compatible
  // adapter gates on a VAULT-stored api_key, which this registry-only projection
  // cannot read — installing it already requires filling that secret in the
  // setup flow, so "active" is the closest honest signal available here.
  const providerConfigured = ollamaEmbeddings || isActive(EMBEDDINGS_OPENAI_ID);
  // A configured provider whose vectors the gate refuses writes NOTHING. That
  // is not "embeddings on with a caveat", it is embeddings off.
  const gateBlocked = gate !== undefined && !gate.vectorWritesAllowed;
  const embeddings = providerConfigured && !gateBlocked;

  const durable = backend === 'neon';
  // Both semantic recall and the durable tier need an embedding client to query.
  const semanticRecall = backend !== 'none' && embeddings;
  const durableTier = backend !== 'none' && embeddings;
  // processMemory is provided only by the neon backend and needs embeddings to
  // write/query stored processes.
  const processReuse = backend === 'neon' && embeddings;

  const warnings: string[] = [];
  if (backend === 'none') {
    warnings.push('no knowledge-graph backend active — recall is unavailable');
  }
  if (backend === 'inmemory') {
    warnings.push(
      'inmemory KG backend: state is lost on restart (set DATABASE_URL + install the neon backend for durability)',
    );
  }
  if (backend !== 'none' && !embeddings) {
    warnings.push(
      providerConfigured && gateBlocked
        ? describeGateBlock(gate)
        : 'embeddings disabled: semantic recall, the durable tier and process-reuse are all inactive (FTS-only) — set OLLAMA_BASE_URL / enable the embeddings overlay, or install an alternative embeddingClient provider',
    );
  }
  if (backend === 'inmemory' && embeddings) {
    warnings.push(
      'process-reuse unavailable on the inmemory backend (only neon provides processMemory)',
    );
  }

  return {
    backend,
    durable,
    embeddings,
    semanticRecall,
    durableTier,
    processReuse,
    warnings,
  };
}

/**
 * Name the two models explicitly. "Embeddings are off" is not actionable when
 * an operator can see an active embeddings plugin in the install UI; "active
 * openai:text-embedding-3-small (1536d) vs stored ollama:nomic-embed-text" is.
 */
function describeGateBlock(gate: EmbeddingGateStatus | undefined): string {
  if (gate?.reason === CLEAR_COMPLETE_REASON) {
    // Vectors ARE being written again — by the backfill sweep. Only the hot
    // path is still off, and only until this process restarts. The generic
    // "no vectors are being written" wording below would be wrong here.
    return (
      `embedding-model switch finished: the stale-vector clear has drained and the backfill sweep is ` +
      `re-embedding the corpus, but this middleware process still has hot-path vector writes disabled ` +
      `(new turns store no vector and process-reuse writes are rejected) — restart it to re-enable them`
    );
  }
  const active = gate?.activeModelId ?? '(unknown)';
  const stored = gate?.storedModelId;
  const reason = gate?.reason ?? gate?.status ?? 'blocked';
  const models =
    stored !== undefined && stored !== active
      ? `active provider '${active}' vs corpus recorded as '${stored}'`
      : `active provider '${active}'`;
  const detail =
    gate?.detail !== undefined && gate.detail.length > 0 ? ` (${gate.detail})` : '';
  return (
    `embeddings disabled by the model/dimension gate [${reason}]: ${models}${detail} — ` +
    'no vectors are being written, so semantic recall, the durable tier and ' +
    'process-reuse are all inactive (FTS-only)'
  );
}
