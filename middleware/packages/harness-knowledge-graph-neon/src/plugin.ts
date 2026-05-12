import type { PluginContext } from '@omadia/plugin-api';
import { EntityRefBus } from '@omadia/plugin-api';
import type { EmbeddingClient } from '@omadia/embeddings';
import type { Pool } from 'pg';

import { NeonKnowledgeGraph, createNeonPool } from './neonKnowledgeGraph.js';
import { runGraphMigrations } from './migrator.js';
import {
  startEmbeddingBackfill,
  type EmbeddingBackfillHandle,
} from './embeddingBackfill.js';
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
  const databaseUrl = await ctx.secrets.get('database_url');

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

  const embeddingClient = ctx.services.get<EmbeddingClient>(EMBEDDING_CLIENT_SERVICE);
  const turnContextAccessor = ctx.services.get<TurnContextAccessor>(TURN_CONTEXT_SERVICE);

  const tenantId =
    ctx.config.get<string>('graph_tenant_id') ??
    process.env['GRAPH_TENANT_ID'] ??
    'default';

  const graphPool: Pool = createNeonPool(databaseUrl);
  await runGraphMigrations(graphPool, (msg) => { console.log(msg); });

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
    ...(embeddingClient ? { embeddingClient } : {}),
  });
  console.log(
    embeddingClient
      ? '[graph] Neon knowledge graph ready (embeddings enabled)'
      : '[graph] Neon knowledge graph ready (embeddings disabled — set ollama_base_url on @omadia/embeddings)',
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
  if (backfillEnabled && embeddingClient) {
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
      embeddingClient,
      tenantId,
      intervalMs: intervalMinutes * 60 * 1000,
      batchSize,
      maxAttempts,
      log: (msg) => { console.error(msg); },
    });
    console.error(
      `[graph-embedding-backfill] scheduler armed interval=${String(intervalMinutes)}min batch=${String(batchSize)} maxAttempts=${String(maxAttempts)}`,
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
    ...(embeddingClient ? { embeddingClient } : {}),
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
