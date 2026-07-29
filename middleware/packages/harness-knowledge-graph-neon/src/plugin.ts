import type { EmbeddingClient, PluginContext } from '@omadia/plugin-api';
import { EntityRefBus, readEmbeddingProviderMetadata } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import {
  NeonKnowledgeGraph,
  createNeonPool,
  waitForPostgres,
} from './neonKnowledgeGraph.js';
import { runGraphMigrations } from './migrator.js';
import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
  requiresStaleVectorClearResume,
  type EmbeddingModelGateOutcome,
} from './embeddingModelGate.js';
import {
  startEmbeddingBackfill,
  type EmbeddingBackfillHandle,
} from './embeddingBackfill.js';
import { createEmbeddingGateStatus } from './gateStatusPublication.js';
import { runDecaySweep } from './decayJob.js';
import { AccessTracker } from './accessTracker.js';
import { runGcSweep } from './gc.js';
import {
  createLifecycleService,
  type LifecycleServiceConfig,
} from './lifecycleService.js';
import { NeonAgentPrioritiesStore } from './agentPrioritiesStore.js';
import { NeonProcessMemoryStore } from './processMemoryStore.js';
import { NeonNudgeStateStore } from './nudgeStateStore.js';

/**
 * @omadia/knowledge-graph-neon — plugin entry point.
 *
 * `kind: extension`. Provides on activate():
 *   - `knowledgeGraph` — durable Neon-Postgres + pgvector entity store.
 *   - `entityRefBus`   — ephemeral per-Turn in-memory pub/sub for EntityRef
 *     observations. New EntityRefBus instance per process — orthogonal to
 *     the storage backend (Fork-Decision #2).
 *   - `graphPool`      — the pg Pool, published so kernel-side consumers
 *     (verifier session-store, dev graph router) can reach it via
 *     ServiceRegistry without going through the KnowledgeGraph interface.
 *
 * Pulls from kernel bridges + capabilities:
 *   - `embeddingClient` (capability) — kernel publishes via the embeddings
 *     plugin. Plugin reads it lazily for the graph ingest path and the
 *     embedding-backfill scheduler. Absent when `ollama_base_url` is unset →
 *     embeddings degrade to NULL, retriever falls back to FTS, backfill
 *     stays disarmed.
 *   - `turnContext` (kernel-bridge) — AsyncLocalStorage accessor used to
 *     bind the EntityRefBus's `getCurrentTurnId` getter so per-turn
 *     correlation is preserved.
 *
 * Lifetime: activate() constructs Pool + Migrations + Graph + Bus +
 * Backfill scheduler. close() reverses (stop scheduler → dispose service
 * registrations → drain Pool with end()). SIGTERM/SIGINT shutdown is owned
 * by the kernel runtime which calls close() on every active plugin.
 *
 * S+11-2b: capability ownership flipped here from the legacy
 * @omadia/knowledge-graph plugin. Mutual exclusion with the
 * `*-inmemory` sibling — both plugins declare `provides: knowledgeGraph@1`,
 * the operator picks one (RequiresWizard / install UI), `ctx.services.provide`
 * throws on a duplicate so two-active is structurally impossible.
 *
 * Always-Register-Pattern (S+9.1 Rule #8): activate() runs even without a
 * `database_url`; in that case it logs + returns a no-op handle so the
 * registry entry stays toggle-able from the install UI without a re-bootstrap.
 */

const KNOWLEDGE_GRAPH_SERVICE = 'knowledgeGraph';
const ENTITY_REF_BUS_SERVICE = 'entityRefBus';
const GRAPH_POOL_SERVICE = 'graphPool';
const EMBEDDING_CLIENT_SERVICE = 'embeddingClient';
const TURN_CONTEXT_SERVICE = 'turnContext';
const GRAPH_LIFECYCLE_SERVICE = 'graphLifecycle';
const AGENT_PRIORITIES_SERVICE = 'agentPriorities';
const PROCESS_MEMORY_SERVICE = 'processMemory';
const NUDGE_STATE_SERVICE = 'nudgeStateStore';
/** #440 — read by the kernel's /health route (see src/health/kgHealth.ts).
 *  Structural contract: a plain object, no shared type import either way. */
const EMBEDDING_GATE_STATUS_SERVICE = 'embeddingModelGateStatus';

/** Kernel-side AsyncLocalStorage accessor (structural type — published by the
 *  middleware kernel via ServiceRegistry). Inlined locally because the type
 *  is trivial and lifting it to plugin-api would be cross-cutting churn. */
interface TurnContextAccessor {
  currentTurnId(): string | undefined;
}

export interface NeonKnowledgeGraphPluginHandle {
  close(): Promise<void>;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const t = raw.trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes') return true;
  if (t === 'false' || t === '0' || t === 'no') return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeFloat(
  raw: string | number | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export async function activate(
  ctx: PluginContext,
): Promise<NeonKnowledgeGraphPluginHandle> {
  ctx.log('[harness-knowledge-graph-neon] activating');

  // S+12.5-3: database_url is vault-stored (matches telegram_bot_token-pattern).
  // Bootstrap writes it during installation; operator can override via
  // setup-form (Vault) post-install. The legacy installed.json fallback was
  // dropped; bootstrapKnowledgeGraphFromEnv migrates pre-S+12.5-3 entries
  // automatically on first boot.
  //
  // Desktop installer exception: the embedded Postgres binds a loopback port
  // that can change between launches (collision → a new free port is chosen),
  // but the vault froze the FIRST-boot DSN and bootstrap never refreshes it. So
  // when the supervisor signals an embedded DB (OMADIA_EMBEDDED_DB=1), the live
  // DATABASE_URL env is authoritative — otherwise a drifted port would make this
  // eager connect crash-loop boot against a dead port. Cloud/server (flag unset)
  // keep vault precedence unchanged.
  const embeddedDbUrl =
    process.env['OMADIA_EMBEDDED_DB'] === '1' ? process.env['DATABASE_URL'] : undefined;
  const databaseUrl = embeddedDbUrl || (await ctx.secrets.get('database_url'));

  if (!databaseUrl) {
    ctx.log(
      '[harness-knowledge-graph-neon] no database_url — capabilities NOT published; install @omadia/knowledge-graph-inmemory or set database_url',
    );
    return {
      async close(): Promise<void> {
        // no-op: nothing constructed
      },
    };
  }

  const resolvedEmbeddingClient =
    ctx.services.get<EmbeddingClient>(EMBEDDING_CLIENT_SERVICE);
  const turnContextAccessor = ctx.services.get<TurnContextAccessor>(TURN_CONTEXT_SERVICE);

  const tenantId =
    ctx.config.get<string>('graph_tenant_id') ??
    process.env['GRAPH_TENANT_ID'] ??
    'default';

  // Pool size is configurable via graph_pool_max / GRAPH_POOL_MAX (defaults to
  // 5). The desktop installer bundles a REAL native PostgreSQL 17, which pools
  // normally — no single-connection cap needed. (The knob predates that: it let
  // an earlier PGlite-over-pglite-socket engine, which was single-client, cap at
  // 1. Kept configurable for constrained deployments.)
  const poolMaxRaw =
    ctx.config.get<string | number>('graph_pool_max') ?? process.env['GRAPH_POOL_MAX'];
  const poolMaxParsed = Number(poolMaxRaw);
  const poolMax =
    Number.isInteger(poolMaxParsed) && poolMaxParsed > 0 ? poolMaxParsed : 5;

  const graphPool: Pool = createNeonPool(databaseUrl, poolMax);
  // Ride out the first-boot Postgres-startup race (e.g. `docker compose up`,
  // where the DNS alias for the `postgres` service can lag the middleware's
  // first connection by a second or two). Without this a transient
  // `getaddrinfo ENOTFOUND` would fail activate(), and since the kernel
  // treats knowledgeGraph as a required service the whole middleware
  // crash-loops. Bounded to stay inside the 10s activate() timeout.
  await waitForPostgres(graphPool, { log: (msg) => { ctx.log(msg); } });
  await runGraphMigrations(graphPool, (msg) => { console.log(msg); });

  // #440 — dimension/model gate. An embedding provider that disagrees with
  // the vector columns (declared width) or with the corpus recorded in
  // `graph_embedding_model` must not write vectors: mixing two models in one
  // cosine space is silent recall rot, not an error anyone would see. When
  // the gate blocks, the resolver below hands the stores `undefined` — graph
  // ingest and process writes store NULL embeddings and the backfill stays
  // disarmed. Same shape as the long-standing no-Ollama degradation, and now
  // reversible in-process: the resolver is re-consulted on every embed, so a
  // refusal that ends (a drained stale-vector clear) re-enables writes without
  // an operator restart.
  //
  // The gate governs THIS plugin's vector writes, not the whole system:
  // contextRetriever / inconsistencyDetector / mergeCandidateDetector /
  // topicDetector resolve `embeddingClient` from the registry themselves and
  // keep calling it. Their vector queries then fail inside the try/catch each
  // of them already has, so recall is FTS-only in effect — at the cost of one
  // wasted embed call plus an error log per attempt.
  //
  // A gate FAILURE (unreachable catalog, migration race, …) must not take
  // knowledge-graph activation down with it: the kernel treats knowledgeGraph
  // as a required service, so a throw here would crash-loop the middleware.
  // Degrade to the safe path instead — no embeddings is recoverable, a boot
  // loop is not.
  //
  // #440 Wave A — a DECLARED-WIDTH mismatch is no longer terminal. The KG
  // columns are vector(768) and every OpenAI model is 1536/3072, so switching
  // provider always trips it; the gate now rewrites the columns at the new
  // width and lets the backfill re-embed. That destroys every stored
  // embedding, so it is a flag — defaulted ON because automatic migration is
  // the asked-for behaviour, but an operator who would rather hand-write a
  // 0005-style migration can turn it off and get the old `blocked` outcome.
  const autoMigrateVectorColumns = parseBool(
    ctx.config.get<string>('auto_migrate_vector_columns') ??
      process.env['GRAPH_AUTO_MIGRATE_VECTOR_COLUMNS'],
    true,
  );
  let gateOutcome: EmbeddingModelGateOutcome;
  try {
    gateOutcome = await evaluateEmbeddingModelGate({
      pool: graphPool,
      tenantId,
      provider: readEmbeddingProviderMetadata(resolvedEmbeddingClient),
      autoMigrateVectorColumns,
      log: (msg) => { console.error(msg); },
    });
  } catch (err) {
    console.error(
      `[graph-embedding-gate] gate evaluation failed: ${err instanceof Error ? err.message : String(err)} — refusing vector writes for this boot`,
    );
    gateOutcome = {
      status: 'blocked',
      reason: 'dimension-mismatch',
      modelId: '(gate evaluation failed)',
      dimensions: 0,
      storedModelId: '(unknown)',
      storedDimensions: 0,
    };
  }
  const vectorWritesAllowed = allowsVectorWrites(gateOutcome);
  // BOOT-TIME snapshot of the verdict. Used only for the startup log lines and
  // for deciding whether to arm the backfill; the STORES do not use it, they
  // go through `resolveEmbeddingClient` below and see the live answer.
  const embeddingClient = vectorWritesAllowed
    ? resolvedEmbeddingClient
    : undefined;
  // A capped or interrupted stale-vector clear still owes work. Vector writes
  // stay refused for the duration (that is what makes "non-NULL ⇒ old model"
  // true), but the backfill sweep is the ONLY thing that can finish the clear
  // and lower the flag — so it gets armed even though nothing may be embedded
  // yet. Once the flag drops, the same sweep re-embeds every NULL vector,
  // including whatever was ingested while writes were off.
  const clearResumeOwed = requiresStaleVectorClearResume(gateOutcome);
  if (!vectorWritesAllowed) {
    ctx.log(
      clearResumeOwed
        ? '[harness-knowledge-graph-neon] a stale-vector clear from an embedding-model switch is still owed — vector writes stay disabled until the backfill sweep finishes it'
        : '[harness-knowledge-graph-neon] embedding provider rejected by the model/dimension gate — knowledge-graph vector writes disabled until the provider or the vector columns are migrated',
    );
  }

  // Publish what the gate decided. Without this, /health projects the plugin
  // REGISTRY (an embeddings adapter is installed and active) and reports
  // `embeddings: true, semanticRecall: true, processReuse: true, warnings: []`
  // for a boot where no vector is ever written and every processMemory write
  // returns `embedding-unavailable`.
  // Live rather than a snapshot: the gate runs once at activation, but the
  // state it describes changes underneath it when the backfill sweep drains
  // the owed clear. A frozen object would keep reporting
  // `stale-vector-clear-pending` on /health until the next restart.
  const gateStatus = createEmbeddingGateStatus(
    gateOutcome,
    vectorWritesAllowed,
    clearResumeOwed,
  );
  const disposeGateStatus = ctx.services.provide(
    EMBEDDING_GATE_STATUS_SERVICE,
    gateStatus.status,
  );

  // THE live resolver both stores consult on every embed. It reads the gate's
  // CURRENT verdict, not the boot-time one, which is the whole point: when the
  // backfill sweep drains an owed stale-vector clear it calls
  // `markStaleVectorClearComplete()`, the published status flips
  // `vectorWritesAllowed` back to true, and the very next ingest embeds again
  // — no restart. Before this, both stores captured `embeddingClient:
  // undefined` in their constructors and a gated boot could never embed again.
  //
  // Returning `undefined` is a SKIP, not an error: the stores store NULL and
  // fall back to FTS, exactly as on a deployment with no provider at all.
  const resolveEmbeddingClient = (): EmbeddingClient | undefined =>
    gateStatus.vectorWritesAllowed() ? resolvedEmbeddingClient : undefined;

  if (gateOutcome.status === 'column-migrated') {
    ctx.log(
      `[harness-knowledge-graph-neon] vector columns were MIGRATED to ${String(gateOutcome.dimensions)}d for '${gateOutcome.modelId}' — ${gateOutcome.discardedVectors === undefined ? 'an unknown number of' : String(gateOutcome.discardedVectors)} stored embedding(s) were discarded; vector writes are enabled and the backfill sweep is re-embedding the corpus (recall is degraded until it finishes). Set auto_migrate_vector_columns=false to require a manual column migration instead.`,
    );
  }

  // OB-73 (Phase 4 / Slice B) — read-path access tracker. Reads queue
  // touches into an in-memory map; the decay-job tick flushes them into a
  // single batched UPDATE (access_count, accessed_at, COLD→WARM promotion).
  const accessTracker = new AccessTracker({
    log: (msg) => { console.error(msg); },
  });

  const knowledgeGraph = new NeonKnowledgeGraph({
    pool: graphPool,
    tenantId,
    accessTracker,
    resolveEmbeddingClient,
  });
  console.log(
    embeddingClient
      ? '[graph] Neon knowledge graph ready (embeddings enabled)'
      : '[graph] Neon knowledge graph ready (embeddings disabled — configure an embeddingClient@1 provider, or check the model/dimension gate above)',
  );

  const entityRefBus = new EntityRefBus({
    getCurrentTurnId: () => turnContextAccessor?.currentTurnId(),
  });

  const disposeGraph = ctx.services.provide(KNOWLEDGE_GRAPH_SERVICE, knowledgeGraph);
  const disposeBus = ctx.services.provide(ENTITY_REF_BUS_SERVICE, entityRefBus);
  const disposePool = ctx.services.provide(GRAPH_POOL_SERVICE, graphPool);

  // Re-embed Turns whose post-commit `embedAndStoreTurn` failed (Ollama
  // timeout / 500). Runs in-process on a cheap timer; no-ops without
  // embeddingClient.
  let backfill: EmbeddingBackfillHandle | undefined;
  const backfillEnabled = parseBool(
    ctx.config.get<string>('graph_embedding_backfill_enabled') ??
      process.env['GRAPH_EMBEDDING_BACKFILL_ENABLED'],
    true,
  );
  // `embeddingClient` is undefined while a clear is owed, but the sweep still
  // has to run — see clearResumeOwed above. It only clears until the flag
  // drops; the client it holds is used afterwards, on the next tick.
  const backfillClient =
    embeddingClient ?? (clearResumeOwed ? resolvedEmbeddingClient : undefined);
  if (backfillEnabled && backfillClient) {
    const intervalMinutes = parsePositiveInt(
      ctx.config.get<string>('graph_embedding_backfill_interval_minutes') ??
        process.env['GRAPH_EMBEDDING_BACKFILL_INTERVAL_MINUTES'],
      5,
    );
    const batchSize = parsePositiveInt(
      ctx.config.get<string>('graph_embedding_backfill_batch_size') ??
        process.env['GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE'],
      20,
    );
    const maxAttempts = parsePositiveInt(
      ctx.config.get<string>('graph_embedding_backfill_max_attempts') ??
        process.env['GRAPH_EMBEDDING_BACKFILL_MAX_ATTEMPTS'],
      5,
    );
    backfill = startEmbeddingBackfill({
      pool: graphPool,
      embeddingClient: backfillClient,
      tenantId,
      intervalMs: intervalMinutes * 60 * 1000,
      batchSize,
      maxAttempts,
      // Slice 7 — sweep all three embedded node types in a single
      // worker. Turn was the original Slice-1 type; MK + PalaiaExcerpt
      // join the rotation so curated memory becomes recall-ready
      // automatically without a second sweep process.
      nodeTypes: ['Turn', 'MemorableKnowledge', 'PalaiaExcerpt'],
      // #440 — `processes.embedding` is the second governed cosine space, and
      // the sweep is also what finishes a stale-vector clear the gate capped
      // at activation time.
      includeProcesses: true,
      // Unconditionally on, even when THIS boot's gate found no owed clear:
      // another instance can raise `clear_pending` at any time (a rolling
      // deploy that switches models), and the sweep re-checks the flag every
      // tick, so leaving it armed is the multi-instance-safe setting. What
      // makes it safe is the gate refusing writes whenever the flag is up —
      // including on the `unknown-provider` path, which used to skip the
      // registry read entirely.
      resumeStaleVectorClear: true,
      // Republish the gate status the moment the clear drains, so /health
      // stops reporting a pending clear without waiting for a restart.
      onStaleVectorClearComplete: () => {
        gateStatus.markStaleVectorClearComplete();
      },
      log: (msg) => { console.error(msg); },
    });
    console.error(
      `[graph-embedding-backfill] scheduler armed interval=${String(intervalMinutes)}min batch=${String(batchSize)} maxAttempts=${String(maxAttempts)} types=[Turn,MemorableKnowledge,PalaiaExcerpt,+processes]`,
    );
  }

  // OB-73 (Phase 4) — Decay-Score + Tier-Rotation + Done-Task-TTL hourly cron.
  // Pure SQL sweep against `graph_nodes`; no LLM call; tenant-scoped.
  // Single-flight via JobScheduler's `overlap: 'skip'`.
  // Resolve the unified lifecycle config UP FRONT so both the cron handlers
  // AND the LifecycleService (admin route) operate on the same numbers.
  const decayEnabled = parseBool(
    ctx.config.get<string>('graph_decay_enabled'),
    true,
  );
  const gcEnabled = parseBool(ctx.config.get<string>('graph_gc_enabled'), true);
  const gcIntervalMinutesRaw = ctx.config.get<string | number>(
    'graph_gc_interval_minutes',
  );
  const gcIntervalParsed =
    gcIntervalMinutesRaw !== undefined
      ? parsePositiveInt(String(gcIntervalMinutesRaw), 0)
      : 0;
  const gcCron =
    (ctx.config.get<string>('graph_gc_cron') ?? '').trim() || '0 4 * * *';

  const lifecycleConfig: LifecycleServiceConfig = {
    decay: {
      enabled: decayEnabled,
      intervalMinutes: parsePositiveInt(
        ctx.config.get<string>('graph_decay_interval_minutes'),
        60,
      ),
      lambda: parseNonNegativeFloat(
        ctx.config.get<string | number>('graph_decay_lambda'),
        0.05,
      ),
      hotToWarmScoreThreshold: parseNonNegativeFloat(
        ctx.config.get<string | number>('graph_decay_hot_to_warm_score'),
        0.5,
      ),
      hotToWarmIdleDays: parsePositiveInt(
        ctx.config.get<string>('graph_decay_hot_to_warm_idle_days'),
        7,
      ),
      warmToColdScoreThreshold: parseNonNegativeFloat(
        ctx.config.get<string | number>('graph_decay_warm_to_cold_score'),
        0.1,
      ),
      warmToColdIdleDays: parsePositiveInt(
        ctx.config.get<string>('graph_decay_warm_to_cold_idle_days'),
        30,
      ),
      doneTaskTtlHours: parsePositiveInt(
        ctx.config.get<string>('graph_decay_done_task_ttl_hours'),
        24,
      ),
    },
    gc: {
      enabled: gcEnabled,
      cron: gcCron,
      intervalMinutes: gcIntervalParsed > 0 ? gcIntervalParsed : null,
      hotMaxEntries: parsePositiveInt(
        ctx.config.get<string>('graph_gc_hot_max_entries'),
        50,
      ),
      maxTotalChars: parsePositiveInt(
        ctx.config.get<string>('graph_gc_max_total_chars'),
        500_000,
      ),
      typeWeights: {
        memory: parseNonNegativeFloat(
          ctx.config.get<string | number>('graph_gc_type_weight_memory'),
          1.0,
        ),
        process: parseNonNegativeFloat(
          ctx.config.get<string | number>('graph_gc_type_weight_process'),
          2.0,
        ),
        task: parseNonNegativeFloat(
          ctx.config.get<string | number>('graph_gc_type_weight_task'),
          1.5,
        ),
      },
    },
  };

  // Lifecycle admin service — published as `graphLifecycle@1` for the
  // dev-route + admin UI to render histograms and trigger sweeps on demand.
  const lifecycleService = createLifecycleService({
    pool: graphPool,
    tenantId,
    config: lifecycleConfig,
    accessTracker,
    log: (msg) => { console.error(msg); },
  });
  const disposeLifecycle = ctx.services.provide(
    GRAPH_LIFECYCLE_SERVICE,
    lifecycleService,
  );

  // OB-74 (Phase 5) — per-Agent block/boost list for the Token-Budget
  // Assembler. Tenant-scoped pool-backed store; Migration 0008 already
  // created the table (see runGraphMigrations above).
  const agentPrioritiesStore = new NeonAgentPrioritiesStore({
    pool: graphPool,
    tenantId,
  });
  const disposeAgentPriorities = ctx.services.provide(
    AGENT_PRIORITIES_SERVICE,
    agentPrioritiesStore,
  );
  console.log('[graph] agentPriorities ready');

  // OB-76 (Phase 7) — Process-Memory with Dedup-First-Write + versioning.
  // Embedding-Sidecar is required for `write` (Dedup guarantee); without
  // a sidecar the store rejects with `embedding-unavailable` — no silent
  // bypass. Migration 0009 already created processes + process_history.
  const dedupThresholdRaw = ctx.config.get<string | number>(
    'process_dedup_threshold',
  );
  const dedupThreshold = parseNonNegativeFloat(dedupThresholdRaw, 0.9);
  const processMemoryStore = new NeonProcessMemoryStore({
    pool: graphPool,
    tenantId,
    dedupThreshold,
    resolveEmbeddingClient,
  });
  const disposeProcessMemory = ctx.services.provide(
    PROCESS_MEMORY_SERVICE,
    processMemoryStore,
  );
  console.log(
    `[graph] processMemory ready (dedup_threshold=${dedupThreshold.toFixed(2)}, embeddings=${embeddingClient ? 'on' : 'off'})`,
  );

  // OB-77 (Palaia Phase 8) — Nudge-State store. Backs the Nudge-Pipeline's
  // lifecycle (success_streak, suppressed_until, retired_at). Migration 0010
  // applied above. Pure read-write surface; no embedding dependency.
  const nudgeStateStore = new NeonNudgeStateStore({
    pool: graphPool,
    tenantId,
  });
  const disposeNudgeStateStore = ctx.services.provide(
    NUDGE_STATE_SERVICE,
    nudgeStateStore,
  );
  console.log('[graph] nudgeStateStore ready');

  let disposeDecayJob: (() => void) | undefined;
  if (decayEnabled) {
    disposeDecayJob = ctx.jobs.register(
      {
        name: 'decay-rotation',
        schedule: {
          intervalMs: lifecycleConfig.decay.intervalMinutes * 60 * 1000,
        },
        // Sweep is bounded SQL but the WHERE-clauses scan the full Turn
        // table per tenant; 5 min budget is enough headroom for 100k rows
        // on Neon serverless even with cold caches.
        timeoutMs: 5 * 60 * 1000,
        overlap: 'skip',
      },
      async (_signal): Promise<void> => {
        // Flush the read-path access tracker FIRST so the freshly-touched
        // Turns get their access_count + accessed_at updated (and any COLD
        // ones promoted to WARM) BEFORE the rotation thresholds run. Errors
        // here are logged + swallowed: a missed access flush is a stat
        // delay, not corruption — we don't want it to skip the rotation.
        try {
          await accessTracker.flush({ pool: graphPool, tenantId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[graph-decay] access flush failed (continuing with sweep): ${msg}`,
          );
        }
        await runDecaySweep({
          pool: graphPool,
          tenantId,
          lambda: lifecycleConfig.decay.lambda,
          hotToWarmScoreThreshold:
            lifecycleConfig.decay.hotToWarmScoreThreshold,
          hotToWarmIdleDays: lifecycleConfig.decay.hotToWarmIdleDays,
          warmToColdScoreThreshold:
            lifecycleConfig.decay.warmToColdScoreThreshold,
          warmToColdIdleDays: lifecycleConfig.decay.warmToColdIdleDays,
          doneTaskTtlHours: lifecycleConfig.decay.doneTaskTtlHours,
          log: (msg) => { console.error(msg); },
        });
      },
    );
    ctx.log(
      `[graph-decay] job registered (every ${String(lifecycleConfig.decay.intervalMinutes)}min, λ=${lifecycleConfig.decay.lambda.toFixed(3)}/d, HOT→WARM<${lifecycleConfig.decay.hotToWarmScoreThreshold.toFixed(2)}+${String(lifecycleConfig.decay.hotToWarmIdleDays)}d, WARM→COLD<${lifecycleConfig.decay.warmToColdScoreThreshold.toFixed(2)}+${String(lifecycleConfig.decay.warmToColdIdleDays)}d, done-TTL=${String(lifecycleConfig.decay.doneTaskTtlHours)}h)`,
    );
  }

  // OB-73 (Phase 4 / Slice C) — Daily GC + Hard-Limits per scope.
  // Defaults to 04:00 UTC; operators can either change the cron or set
  // `graph_gc_interval_minutes` for a fixed-interval schedule (useful in
  // tests + hot-loops). Single-flight via `overlap: 'skip'`.
  let disposeGcJob: (() => void) | undefined;
  if (gcEnabled) {
    const gcSchedule =
      lifecycleConfig.gc.intervalMinutes !== null
        ? { intervalMs: lifecycleConfig.gc.intervalMinutes * 60 * 1000 }
        : { cron: lifecycleConfig.gc.cron };

    disposeGcJob = ctx.jobs.register(
      {
        name: 'gc-quotas',
        schedule: gcSchedule,
        // GC walks every Turn row per overflowing scope; daily budget is
        // generous (10 min) so a backed-up tenant doesn't get its sweep
        // killed mid-eviction.
        timeoutMs: 10 * 60 * 1000,
        overlap: 'skip',
      },
      async (_signal): Promise<void> => {
        await runGcSweep({
          pool: graphPool,
          tenantId,
          hotMaxEntries: lifecycleConfig.gc.hotMaxEntries,
          maxTotalChars: lifecycleConfig.gc.maxTotalChars,
          typeWeights: lifecycleConfig.gc.typeWeights,
          log: (msg) => { console.error(msg); },
        });
      },
    );
    ctx.log(
      `[graph-gc] job registered (${lifecycleConfig.gc.intervalMinutes !== null ? `every ${String(lifecycleConfig.gc.intervalMinutes)}min` : `cron='${lifecycleConfig.gc.cron}'`}, hot_max=${String(lifecycleConfig.gc.hotMaxEntries)}, max_chars=${String(lifecycleConfig.gc.maxTotalChars)}, weights=memory:${lifecycleConfig.gc.typeWeights.memory.toFixed(1)}/process:${lifecycleConfig.gc.typeWeights.process.toFixed(1)}/task:${lifecycleConfig.gc.typeWeights.task.toFixed(1)})`,
    );
  }

  ctx.log(
    `[harness-knowledge-graph-neon] ready (pool=neon, embeddings=${embeddingClient ? 'on' : 'off'}, backfill=${backfill ? 'armed' : 'off'}, decay=${disposeDecayJob ? 'armed' : 'off'}, gc=${disposeGcJob ? 'armed' : 'off'})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-knowledge-graph-neon] deactivating');
      disposeGcJob?.();
      disposeDecayJob?.();
      disposeGateStatus();
      disposeNudgeStateStore();
      disposeProcessMemory();
      disposeAgentPriorities();
      disposeLifecycle();
      backfill?.stop();
      disposePool();
      disposeBus();
      disposeGraph();
      try {
        await graphPool.end();
      } catch {
        // process exit path — pool draining is best-effort
      }
    },
  };
}
