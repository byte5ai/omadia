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
 * `reason` the gate publishes once a stale-vector clear has finished.
 *
 * It normally arrives together with `vectorWritesAllowed: true` — the stores
 * resolve their embedding client live, so the plugin re-enables the hot path
 * in-process the moment the clear drains, with no restart. This branch
 * therefore only fires for a knowledge-graph build that publishes the reason
 * while still refusing writes, i.e. one from before that change.
 *
 * Same structural contract as the service name above — the plugin spells the
 * literal in `gateStatusPublication.ts`; keep the two in sync.
 */
const CLEAR_COMPLETE_REASON = 'stale-vector-clear-complete';

/**
 * `reason` the gate publishes when it rewrote the vector columns at the active
 * provider's width. Vector writes are ALLOWED in this state, so it never
 * reaches `describeGateBlock` — but every stored embedding was destroyed and
 * the backfill is still re-earning them, which is a real, temporary recall
 * degradation an operator should not have to find in the boot log.
 */
const VECTOR_COLUMNS_MIGRATED_REASON = 'vector-columns-migrated';

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
  /** Liveness of the shared pg pool behind the neon backend (#665).
   *  `skipped` when there is no neon backend to probe — that is not a fault. */
  pool: 'live' | 'dead' | 'skipped';
  /** Human-readable degradation notes, empty when fully healthy. */
  warnings: string[];
}

/** Outcome of {@link probeGraphPool}. Kept separate from KgHealth so the
 *  snapshot builder stays synchronous and pure — the I/O happens in the route,
 *  the projection is still a function of its inputs. */
export interface PoolProbe {
  state: 'live' | 'dead' | 'skipped';
  /** Failure text, for the warning line. Never surfaced when `live`. */
  error?: string;
}

/** Minimal structural view of a pg Pool — avoids a `pg` type import here. */
interface QueryablePool {
  query(sql: string): Promise<unknown>;
}

/**
 * Ask the shared pg pool whether it is still usable (#665).
 *
 * WHY THIS EXISTS: every other field in this file is a projection of the
 * REGISTRY — what the operator installed and what the gate decided. None of it
 * touches the database, so the outage in #665 was structurally invisible: the
 * knowledge-graph plugin ended the process-wide pool, every query in the
 * process began failing with `Cannot use a pool after calling end on the pool`,
 * and `/health` kept answering `ok` because a registry entry still said
 * `active`. That is precisely the lie the header of this file claims to
 * prevent, in a dimension the file did not yet cover.
 *
 * `SELECT 1` is the cheapest question that distinguishes "the object still
 * works" from "someone called end() on it" — an ended pool rejects it
 * immediately, without I/O, so the common failure costs nothing. The timeout
 * bounds the other case (a genuinely unreachable database) so a health probe
 * can never hang the endpoint that is supposed to report the hang.
 *
 * Never throws: a health endpoint that 500s tells a load balancer far less
 * than one that answers `degraded`.
 */
export async function probeGraphPool(
  pool: unknown,
  timeoutMs = 1000,
): Promise<PoolProbe> {
  if (!pool || typeof (pool as QueryablePool).query !== 'function') {
    return { state: 'skipped' };
  }
  // The timer is cleared in `finally` rather than unref'd. Unref'ing looks
  // tidier but takes the timer out of the event loop, so if the query never
  // settles there is nothing left holding the process and the race is decided
  // by whatever else happens to be running — which is exactly the case this
  // timeout exists for.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (pool as QueryablePool).query('SELECT 1'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`pool probe timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
    return { state: 'live' };
  } catch (err) {
    return {
      state: 'dead',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  poolProbe?: PoolProbe,
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
  // Writes are on, so none of the flags above went false — but the corpus was
  // deliberately thrown away and is being rebuilt. Reported as a warning
  // because "healthy with no vectors yet" and "healthy" are different states.
  if (embeddings && gate?.reason === VECTOR_COLUMNS_MIGRATED_REASON) {
    warnings.push(describeColumnMigration(gate));
  }

  // #665. Only meaningful for neon — the inmemory backend has no pool, and
  // `none` has nothing to probe. Reported before the other warnings because a
  // dead pool makes every capability above it academic: they describe what the
  // deployment is CONFIGURED to do, this says whether it can do anything.
  const pool: KgHealth['pool'] =
    backend === 'neon' ? (poolProbe?.state ?? 'skipped') : 'skipped';
  if (pool === 'dead') {
    warnings.unshift(
      `knowledge-graph pg pool is not usable${
        poolProbe?.error ? ` (${poolProbe.error})` : ''
      } — the process shares one pool across ~40 subsystems, so this is an outage, not a degradation; restart the instance`,
    );
  }

  return {
    backend,
    durable,
    embeddings,
    semanticRecall,
    durableTier,
    processReuse,
    pool,
    warnings,
  };
}

/**
 * Name the two models explicitly. "Embeddings are off" is not actionable when
 * an operator can see an active embeddings plugin in the install UI; "active
 * openai:text-embedding-3-small (1536d) vs stored ollama:nomic-embed-text" is.
 */
/**
 * A migration is good news with a caveat, so it gets its own sentence rather
 * than being folded into the block wording — nothing is disabled here.
 */
function describeColumnMigration(gate: EmbeddingGateStatus): string {
  const active = gate.activeModelId ?? '(unknown)';
  const stored = gate.storedModelId;
  const from = stored !== undefined ? ` (was '${stored}')` : '';
  const detail =
    gate.detail !== undefined && gate.detail.length > 0 ? ` — ${gate.detail}` : '';
  return (
    `the knowledge-graph vector columns were rewritten to fit '${active}'${from}${detail}. ` +
    'Vector writes are ENABLED, but semantic recall, the durable tier and process-reuse stay degraded ' +
    'until the embedding backfill has re-embedded the corpus. This only ever follows a confirmed ' +
    'provider switch under Admin → Embedding provider; set auto_migrate_vector_columns=false to ' +
    'forbid the rewrite even there and require a hand-written column migration instead.'
  );
}

function describeGateBlock(gate: EmbeddingGateStatus | undefined): string {
  if (gate?.reason === CLEAR_COMPLETE_REASON) {
    // Vectors ARE being written again — by the backfill sweep. Reaching this
    // branch means the plugin published a finished clear while still refusing
    // hot-path writes, which a current knowledge-graph build no longer does
    // (its stores resolve the embedding client live and it flips writes back
    // on in-process). So: an older plugin against a newer kernel.
    return (
      `embedding-model switch finished: the stale-vector clear has drained and the backfill sweep is ` +
      `re-embedding the corpus, but this middleware process still reports hot-path vector writes as ` +
      `disabled (new turns store no vector and process-reuse writes are rejected). A current ` +
      `knowledge-graph plugin re-enables them without a restart — upgrade it, or restart the process`
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
