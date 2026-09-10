import { countVectors, discoverGovernedVectorColumns } from '@omadia/knowledge-graph-neon';
import { parseCapabilityRef } from '@omadia/plugin-api';
import type { CapabilityRef, EmbeddingClient } from '@omadia/plugin-api';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { EmbeddingGateStatus } from '../health/kgHealth.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  AUTO_MIGRATE_CONFIG_KEY,
  DEDUP_THRESHOLD_CONFIG_KEY,
  EMBEDDING_CLIENT_CAPABILITY,
  GRAPH_TENANT_ID_CONFIG_KEY,
  KG_NEON_ID,
  describeProviderConfig,
  isKeylessProvider,
  recommendedDedupThreshold,
  type EmbeddingProviderCatalog,
} from './embeddingProviderCatalog.js';

/**
 * `/api/v1/admin/embedding-provider` — live switching of the active
 * `embeddingClient@1` provider (#440 follow-up).
 *
 * Mounted behind `requireAuth` (cookie session JWT), same admin-router family
 * as `adminProviders` / `adminSettings` / `memoryBackend`. NOT on the machine
 * `ADMIN_TOKEN` surface.
 *
 * WHY THIS IS NOT THE MEMORY-BACKEND PAGE. `memoryBackend.ts` only PERSISTS a
 * choice and tells the operator to restart. That is unacceptable here: the
 * whole point of the #440 gate work is that a provider swap now takes effect
 * in-process — the knowledge-graph stores resolve their embedding client live
 * and the gate rewrites the vector columns on a width change. So this router
 * performs the switch: deactivate the current provider, activate the target,
 * then ask the gate to RE-EVALUATE ITSELF against the new provider. No process
 * restart anywhere in this path.
 *
 * WHY IT DOES NOT REACTIVATE THE KNOWLEDGE GRAPH. It used to, and that is the
 * one thing it must never do. `installService.reactivate` runs
 * `toolPluginRuntime.deactivate`, which calls the KG plugin's `close()`, which
 * calls `graphPool.end()` — on the pool the kernel captured ONCE
 * (`src/index.ts`) and shares with ~40 subsystems: routines, plugin webhooks,
 * agent schedules, cost telemetry, MCP audit, `AgentGraphStore`,
 * `McpConfigService`. After every SUCCESSFUL switch all of them answered
 * `Cannot use a pool after calling end on the pool` until the process was
 * restarted, i.e. the "switch without restart" feature forced one. The gate is
 * re-evaluated in place instead (`embeddingModelGateStatus.reevaluate`), which
 * re-resolves the embedding client, re-runs the model/dimension gate and
 * republishes the verdict without tearing anything down.
 *
 * WHO MAY DESTROY THE CORPUS. The destructive column rewrite is a capability
 * this route hands to that re-evaluation, and only after `confirmDiscardVectors`.
 * Plugin activation never hands it over, so a deployment sitting on
 * `blocked/column-width-mismatch` that merely upgrades and restarts keeps its
 * corpus. `auto_migrate_vector_columns` is the operator's master switch over
 * the confirmed path, not a boot-path behaviour.
 *
 * SAFETY. Switching provider discards the stored corpus — a different width
 * rewrites the `vector(n)` columns, an equal width clears them for re-embed.
 * Either way every stored embedding is re-earned by the backfill sweep, one
 * paid provider call per row. The switch therefore refuses to run without an
 * explicit `confirmDiscardVectors: true`, and GET reports up front how many
 * vectors that is.
 *
 * ROLLBACK. Activating the target can succeed without the target publishing a
 * client (both adapters activate but publish nothing when unconfigured — no
 * `api_key` in the vault, no `ollama_base_url`). Ending there would leave the
 * deployment with NO active embedding provider at all, which is strictly worse
 * than where it started. The switch therefore verifies that the capability is
 * actually published afterwards and restores the previous provider when it is
 * not — and VERIFIES THE RESTORE, rather than reporting one it never checked.
 *
 * ONE SWITCH AT A TIME. Two concurrent `POST /switch` calls (A→B and A→C) used
 * to interleave into the exact corruption this router's own comments say it
 * prevents: R1 marks B active, R2 marks C active,
 * `ctx.services.provide('embeddingClient', …)` throws on the duplicate, the
 * rollback's own `activate` throws on the duplicate too and was swallowed —
 * leaving A and B both `status: 'active'` in the registry, which crashes the
 * next boot in `activateAllInstalled`. Everything from pricing the corpus to
 * the final re-gate therefore runs under `switchInFlight`; a second caller is
 * told so (409) instead of being queued behind an operation that holds a
 * 10s-capped activation and a corpus count.
 *
 * TRUTHFUL REPORTING. The failure this once guarded against — `reactivate`
 * swallowing a hook error and the endpoint answering `{ ok: true, gate: null }`
 * over a knowledge graph that never came back — is gone with the reactivation
 * itself; nothing is torn down, so nothing can fail to come back. The property
 * is kept at the same strength on the state that CAN still fail: the response
 * reports `gateReevaluated` truthfully, a re-evaluation that throws is a 500
 * rather than an `ok: true`, and a deployment with no re-evaluate entry point
 * at all (no Postgres knowledge-graph active) is named instead of implied.
 */

const SwitchBodySchema = z.object({
  pluginId: z.string().min(1),
  confirmDiscardVectors: z.boolean().optional(),
});

/**
 * Structural view of the keyless adapter's `localEmbeddingModelFetcher`
 * service. The plugin publishes a plain object
 * (`packages/embedding-adapter-local/src/modelFetcherService.ts`); this module
 * only reads it, so neither side imports the other. Same shape of contract as
 * `EmbeddingGateStatus`.
 */
export interface LocalEmbeddingModelFetcher {
  status(): {
    readonly modelDir: string;
    readonly missingFiles: readonly string[];
    readonly totalBytes: number;
    readonly job: {
      readonly state: 'idle' | 'running' | 'done' | 'failed';
      readonly downloadedBytes: number;
      readonly totalBytes: number;
      readonly currentFile: string | null;
      readonly error: string | null;
    };
  };
  /** Single-flight. `false` ⇒ a run was already in progress. */
  start(): boolean;
}

export interface AdminEmbeddingProviderDeps {
  readonly installedRegistry: InstalledRegistry;
  /** Manifest catalog — the source of truth for who provides the capability. */
  readonly catalog: EmbeddingProviderCatalog;
  /** Live `embeddingClient@1` service, as the knowledge-graph resolves it. */
  readonly getEmbeddingClient: () => EmbeddingClient | undefined;
  /**
   * The keyless adapter's weight downloader, when that adapter is active.
   *
   * OM-84 follow-up — the keyless provider exists but its weights are not
   * bundled, and "run npm run fetch-model" is indistinguishable from "you
   * cannot have this" for the desktop user this adapter was built for. So the
   * page drives the download.
   *
   * Resolved per request and never imported: same rule as the dimension
   * previews in `embeddingProviderCatalog.ts` — the kernel reads what the
   * adapters publish structurally and takes no build dependency on either,
   * since both may be uninstalled. `undefined` simply means the keyless
   * adapter is not active, which is the normal state on a keyed deployment.
   */
  readonly getLocalModelFetcher?: () => LocalEmbeddingModelFetcher | undefined;
  /** Live gate verdict. NOT cached — `vectorWritesAllowed` flips false→true
   *  in-process when a stale-vector clear drains, and a captured copy would
   *  show a stale red forever. Also carries the (non-enumerable) `reevaluate`
   *  entry point the switch calls; see `readReevaluator`. */
  readonly getGateStatus: () => EmbeddingGateStatus | undefined;
  /** Neon pool. Undefined on the in-memory knowledge-graph backend, in which
   *  case there are no governed vector columns to price. */
  readonly getGraphPool: () => Pool | undefined;
  /**
   * Env-derived fallback tenant (`GRAPH_TENANT_ID ?? 'default'`). The KG setup
   * field wins over it — see `resolveGraphTenantId`.
   */
  readonly tenantId: string;
  /** Runtime activation of a tool/extension plugin (ToolPluginRuntime). */
  readonly activate: (pluginId: string) => Promise<void>;
  readonly deactivate: (pluginId: string) => Promise<boolean>;
}

/**
 * The knowledge-graph's in-place gate re-evaluation, as this route sees it.
 *
 * Duck-typed off the published `embeddingModelGateStatus` object rather than
 * imported: the same no-shared-types structural contract `/health` already
 * keeps with that service, and it degrades correctly against a knowledge-graph
 * that predates the entry point (the property is simply absent).
 */
type GateReevaluate = (request: {
  allowDestructiveMigration: boolean;
  /** OM-98 — rebuild the governed vector columns IF the gate finds them
   *  empty. Absent on older knowledge-graph builds, which simply ignore it. */
  allowEmptyColumnMigration?: boolean;
}) => Promise<unknown>;

function readReevaluator(
  gate: EmbeddingGateStatus | undefined,
): GateReevaluate | undefined {
  const fn = (gate as { reevaluate?: unknown } | undefined)?.reevaluate;
  return typeof fn === 'function' ? (fn as GateReevaluate) : undefined;
}

/** Why no gate was re-run. Reported rather than implied — see TRUTHFUL REPORTING. */
const NO_REEVALUATOR =
  'the knowledge-graph published no gate re-evaluation entry point, so no model/dimension gate was re-run for the new provider — either no Postgres knowledge-graph is active, or it is an older build. Vector writes stay governed by the verdict from the last activation.';

/** `count(*)` per governed column plus the width they are declared at. */
interface CorpusSnapshot {
  readonly columns: ReadonlyArray<{
    table: string;
    column: string;
    declaredDimensions: number | null;
    storedVectors: number | null;
  }>;
  /** The single governed width, or null when the columns disagree / none. */
  readonly columnDimensions: number | null;
  /** Total governed vectors, or null when it could not be established. */
  readonly storedVectorTotal: number | null;
}

const EMPTY_CORPUS: CorpusSnapshot = {
  columns: [],
  columnDimensions: null,
  storedVectorTotal: null,
};

/** Best-effort `count(*)` timeout per column — this is a preview, not a gate. */
const COUNT_STATEMENT_TIMEOUT_MS = 5_000;

/** Read the governed columns and how much corpus each one holds. Read-only and
 *  best-effort: a DB that cannot answer degrades to `null` counts rather than
 *  failing the whole page. */
async function readCorpus(pool: Pool, tenantId: string): Promise<CorpusSnapshot> {
  const governed = await discoverGovernedVectorColumns(pool);
  if (governed.length === 0) return EMPTY_CORPUS;

  const client = await pool.connect();
  try {
    const columns: Array<CorpusSnapshot['columns'][number]> = [];
    for (const col of governed) {
      const n = await countVectors(
        client,
        { table: col.table, column: col.column },
        tenantId,
        COUNT_STATEMENT_TIMEOUT_MS,
      );
      columns.push({
        table: col.table,
        column: col.column,
        declaredDimensions: col.declaredDimensions ?? null,
        storedVectors: n ?? null,
      });
    }
    const widths = new Set(
      columns.map((c) => c.declaredDimensions).filter((d): d is number => d !== null),
    );
    const total = columns.reduce<number | null>(
      (acc, c) => (acc === null || c.storedVectors === null ? null : acc + c.storedVectors),
      0,
    );
    return {
      columns,
      columnDimensions: widths.size === 1 ? ([...widths][0] ?? null) : null,
      storedVectorTotal: total,
    };
  } finally {
    client.release();
  }
}

/** The recorded corpus identity (`graph_embedding_model`, migration 0030). */
async function readRecordedModel(
  pool: Pool,
  tenantId: string,
): Promise<{ modelId: string; dimensions: number; clearPending: boolean } | null> {
  const result = await pool.query<{
    model_id: string;
    dimensions: number;
    clear_pending: boolean;
  }>(
    `SELECT model_id, dimensions, clear_pending
       FROM graph_embedding_model
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    modelId: row.model_id,
    dimensions: Number(row.dimensions),
    clearPending: row.clear_pending === true,
  };
}

/** Installed plugins whose manifest publishes `embeddingClient@1`. */
function installedProviderIds(deps: AdminEmbeddingProviderDeps): string[] {
  const wanted = parseCapabilityRef(EMBEDDING_CLIENT_CAPABILITY);
  const out: string[] = [];
  for (const entry of deps.catalog.list()) {
    if (!deps.installedRegistry.has(entry.plugin.id)) continue;
    const publishes = entry.plugin.provides.some((rawProv) => {
      const ref = tryParseCapability(rawProv);
      return ref !== undefined && ref.name === wanted.name && ref.major === wanted.major;
    });
    if (publishes) out.push(entry.plugin.id);
  }
  return out.sort();
}

/** A malformed `provides:` entry is a manifest bug, not a reason to hide every
 *  other provider — the catalog loader already warns about it. */
function tryParseCapability(raw: string): CapabilityRef | undefined {
  try {
    return parseCapabilityRef(raw);
  } catch {
    return undefined;
  }
}

/** The provider the registry says is live. Exactly one may be active — a
 *  second `ctx.services.provide('embeddingClient', …)` throws. */
function activeProviderId(
  deps: AdminEmbeddingProviderDeps,
  providerIds: readonly string[],
): string | null {
  for (const id of providerIds) {
    if (deps.installedRegistry.get(id)?.status === 'active') return id;
  }
  return null;
}

/**
 * The tenant the KNOWLEDGE-GRAPH PLUGIN actually uses.
 *
 * `plugin.ts` resolves it as `ctx.config.get('graph_tenant_id') ??
 * process.env['GRAPH_TENANT_ID'] ?? 'default'`, and `graph_tenant_id` IS an
 * operator-settable setup field in the KG manifest. This router used to price
 * the switch against the env value alone, so a deployment with
 * `graph_tenant_id: acme` and no env var counted vectors for tenant
 * `'default'`: `storedVectorTotal` came back 0, a same-width target computed
 * `destructive === false`, and `POST /switch` proceeded WITHOUT
 * `confirmDiscardVectors` — after which the gate cleared the real `acme`
 * corpus. GET reported `vectorsToDiscard: 0` for a populated corpus.
 *
 * Read live rather than captured: the field is editable in the Store UI, and a
 * value captured at boot would drift the moment an operator changes it.
 */
function resolveGraphTenantId(deps: AdminEmbeddingProviderDeps): string {
  const configured = deps.installedRegistry.get(KG_NEON_ID)?.config?.[
    GRAPH_TENANT_ID_CONFIG_KEY
  ];
  if (typeof configured === 'string') {
    const trimmed = configured.trim();
    if (trimmed !== '') return trimmed;
  }
  return deps.tenantId;
}

/**
 * Read the current `auto_migrate_vector_columns` value off the KG entry.
 * Manifest default is `'true'`; anything but the literal `'false'` reads as on,
 * mirroring `plugin.ts`.
 *
 * It is a MASTER SWITCH over the confirmed switch below, not a boot-path
 * behaviour: `'false'` forbids the destructive column rewrite even when the
 * operator confirms the discard here. `'true'` does not make a restart
 * destructive — activation never asks for the capability at all.
 */
function autoMigrateEnabled(registry: InstalledRegistry): boolean {
  const raw = registry.get(KG_NEON_ID)?.config?.[AUTO_MIGRATE_CONFIG_KEY];
  return (
    String(raw ?? 'true')
      .trim()
      .toLowerCase() !== 'false'
  );
}

/**
 * Raised when the target could not take over. `restoredProviderId` is the
 * provider that is VERIFIED live again — `null` when nothing was restored, so
 * the response can never claim a rollback that did not happen.
 */
class SwitchRolledBack extends Error {
  constructor(
    message: string,
    readonly restoredProviderId: string | null,
  ) {
    super(message);
  }
}

/**
 * Raised when the provider switch itself succeeded but the in-place gate
 * re-evaluation threw. Not a rollback: the new provider IS live and the
 * registry is consistent — what failed is the re-gate, which is why it must not
 * be reported as `{ ok: true }`.
 *
 * This is the repurposed `KnowledgeGraphDown`. That error covered "reactivating
 * the knowledge graph left it deactivated", a state this route can no longer
 * produce because it no longer reactivates anything. The truthful-reporting
 * property it carried — a re-gate that did not happen is never `ok: true` —
 * moves here unchanged.
 */
class GateReevaluationFailed extends Error {}

/**
 * OM-99 — WHY there is no `embeddingClient@1`, in terms of the provider that
 * is actually installed.
 *
 * The page used to answer this with one sentence for every case: "it is
 * running but not configured (API key or base URL missing)". For the keyless
 * adapter that sentence is simply false — it has no key and no base URL by
 * design, and the two states it really reaches are "the model weights are not
 * on disk" and "another adapter already owns the capability". Telling a
 * subscription user to enter an API key for the adapter that exists so they
 * would not need one is how a working install reads as broken.
 */
export type CapabilityGapReason =
  /** No `embeddingClient@1` provider is active at all. */
  | 'no-active-provider'
  /** A keyed adapter is active but holds no credential. */
  | 'missing-credentials'
  /** The keyless adapter is active and its weights are incomplete. */
  | 'missing-weights'
  /** Weights are present, yet nothing was published — the adapter stood down
   *  because a sibling already held the service, or its activation failed. */
  | 'not-published';

/**
 * The width collision, as a separate fact from the gap above.
 *
 * A width mismatch does NOT stop the capability from being published — the
 * adapter publishes and the GATE refuses the writes. The page treats them as
 * one red box today, which is why an operator reads "no API key" when the real
 * state is "your columns are 768 wide and this model emits 384".
 */
export interface WidthCollision {
  readonly providerDimensions: number | null;
  readonly columnDimensions: number | null;
  /** Every governed vector column is empty ⇒ the rebuild costs nothing and
   *  `POST /reactivate` will do it. `null` when it could not be counted. */
  readonly columnsEmpty: boolean | null;
}

function describeCapabilityGap(
  deps: AdminEmbeddingProviderDeps,
  activeProviderIdValue: string | null,
  localModel: ReturnType<LocalEmbeddingModelFetcher['status']> | null,
): CapabilityGapReason | null {
  if (deps.getEmbeddingClient() !== undefined) return null;
  if (activeProviderIdValue === null) return 'no-active-provider';
  if (isKeylessProvider(activeProviderIdValue)) {
    // The fetcher is published on BOTH the with-weights and without-weights
    // paths, so its absence here means the adapter never activated — not that
    // its weights are fine.
    if (localModel === null) return 'not-published';
    return localModel.missingFiles.length > 0 ? 'missing-weights' : 'not-published';
  }
  return 'missing-credentials';
}

/** The gate's own verdict, reduced to the width question the page asks. */
function describeWidthCollision(
  gate: EmbeddingGateStatus | null,
  activeModel: { modelId: string; dimensions: number } | null,
  corpus: CorpusSnapshot,
): WidthCollision | null {
  if (gate === null) return null;
  if (gate.reason !== 'column-width-mismatch') return null;
  return {
    providerDimensions: activeModel?.dimensions ?? null,
    columnDimensions: corpus.columnDimensions,
    // Fail closed on an unreadable count: `null` renders as "cannot tell",
    // which keeps the reactivate button honest rather than optimistic.
    columnsEmpty:
      corpus.storedVectorTotal === null ? null : corpus.storedVectorTotal === 0,
  };
}

/** What the reactivation did about the provider-relative dedup threshold. */
export interface DedupThresholdOutcome {
  readonly applied: boolean;
  readonly value: number | null;
  readonly previous: string | null;
  readonly reason:
    | 'applied'
    /** The operator already put a value in the store — never overwritten. */
    | 'operator-set'
    /** This adapter makes no recommendation; the KG default stands. */
    | 'no-recommendation'
    /** No knowledge-graph installed, so there is nothing to configure. */
    | 'no-knowledge-graph';
}

/**
 * Beta round 5 — carry the active adapter's recommended
 * `process_dedup_threshold` into the knowledge-graph's config.
 *
 * PROVENANCE IS THE WHOLE POINT. A value the operator typed is a decision and
 * is never touched; the *absence* of a key is the KG's compiled-in 0.90, which
 * is not a decision about this model at all — it is a default that predates
 * the model being installable. So this writes only into that absence.
 *
 * WHY IT DOES NOT TAKE EFFECT IMMEDIATELY. `process_dedup_threshold` is read
 * once, in the knowledge-graph plugin's `activate()`, and re-activating that
 * plugin calls `graphPool.end()` on the pool ~40 subsystems share (see the
 * module header). Persisting the value and saying "on the next restart" is
 * therefore the honest outcome; silently reactivating the graph to make one
 * number live would be a far worse trade.
 */
async function applyRecommendedDedupThreshold(
  deps: AdminEmbeddingProviderDeps,
  providerId: string,
): Promise<DedupThresholdOutcome> {
  const recommended = recommendedDedupThreshold(providerId);
  if (recommended === null) {
    return { applied: false, value: null, previous: null, reason: 'no-recommendation' };
  }
  const entry = deps.installedRegistry.get(KG_NEON_ID);
  if (!entry) {
    return {
      applied: false,
      value: recommended,
      previous: null,
      reason: 'no-knowledge-graph',
    };
  }
  const config = entry.config ?? {};
  const stored = config[DEDUP_THRESHOLD_CONFIG_KEY];
  // An empty string is the Store UI's way of spelling "not set" — treating it
  // as an operator decision would leave every install that once opened the
  // form stuck on the wrong scale.
  const storedText = typeof stored === 'string' ? stored.trim() : stored;
  const isSet =
    storedText !== undefined && storedText !== null && storedText !== '';
  if (isSet) {
    return {
      applied: false,
      value: recommended,
      previous: String(storedText),
      reason: 'operator-set',
    };
  }
  await deps.installedRegistry.register({
    ...entry,
    config: { ...config, [DEDUP_THRESHOLD_CONFIG_KEY]: String(recommended) },
  });
  return { applied: true, value: recommended, previous: null, reason: 'applied' };
}

export function createAdminEmbeddingProviderRouter(deps: AdminEmbeddingProviderDeps): Router {
  const router = Router();
  // Serialises `POST /switch`. See ONE SWITCH AT A TIME in the module header.
  let switchInFlight = false;

  /** Everything the page needs, in one call. */
  async function snapshot(): Promise<Record<string, unknown>> {
    const providerIds = installedProviderIds(deps);
    const activeId = activeProviderId(deps, providerIds);
    const pool = deps.getGraphPool();

    const tenantId = resolveGraphTenantId(deps);
    let corpus = EMPTY_CORPUS;
    let recorded: Awaited<ReturnType<typeof readRecordedModel>> = null;
    let corpusError: string | null = null;
    if (pool) {
      try {
        corpus = await readCorpus(pool, tenantId);
        recorded = await readRecordedModel(pool, tenantId);
      } catch (err) {
        corpusError = err instanceof Error ? err.message : String(err);
      }
    }

    const providers = providerIds.map((id) => {
      const entry = deps.installedRegistry.get(id);
      const desc = describeProviderConfig(id, entry?.config ?? {});
      const isActive = id === activeId;
      // Width change is only knowable when BOTH sides are known. `null` means
      // "cannot tell before activation" — the gate decides for real.
      const widthChange =
        isActive || desc.dimensions === null || corpus.columnDimensions === null
          ? null
          : desc.dimensions !== corpus.columnDimensions;
      return {
        pluginId: id,
        label: deps.catalog.get(id)?.plugin.name ?? id,
        active: isActive,
        registryStatus: entry?.status ?? null,
        modelId: desc.modelId,
        dimensions: desc.dimensions,
        preview: isActive
          ? null
          : {
              widthChange,
              // Any provider switch re-earns the whole corpus: a differing
              // width rewrites the columns, an equal width clears them for
              // re-embed. Reporting the full count either way is the honest
              // number, not a conservative guess.
              vectorsToDiscard: corpus.storedVectorTotal,
            },
      };
    });

    const activeMetadata = readActiveMetadata(deps);
    const gateStatus = deps.getGateStatus() ?? null;
    return {
      providers,
      activeProviderId: activeId,
      activeModel: activeMetadata,
      // The registry's CURRENT client vs. the model the last gate verdict was
      // computed against. They diverge when a provider was swapped through the
      // generic plugin-install UI, which deliberately does not re-gate — so
      // nothing is broken, but the graph is still governed by a verdict about
      // a model that is no longer active. Surfaced rather than left for an
      // operator to notice by comparing two fields on the page.
      providerDrift: describeProviderDrift(activeMetadata, gateStatus),
      capabilityPublished: deps.getEmbeddingClient() !== undefined,
      // OM-99 — WHY it is missing, in terms of the adapter that is installed.
      // `null` when nothing is missing. Read from the local fetcher rather
      // than guessed, so "the weights are still downloading" never renders as
      // "enter an API key".
      capabilityGap: describeCapabilityGap(
        deps,
        activeId,
        deps.getLocalModelFetcher?.()?.status() ?? null,
      ),
      // The width collision as its own fact — it does not stop the capability
      // from being published, it stops the WRITES.
      widthCollision: describeWidthCollision(gateStatus, activeMetadata, corpus),
      corpus: recorded,
      columns: corpus.columns,
      columnDimensions: corpus.columnDimensions,
      storedVectorTotal: corpus.storedVectorTotal,
      gate: gateStatus,
      autoMigrateVectorColumns: autoMigrateEnabled(deps.installedRegistry),
      knowledgeGraphInstalled: deps.installedRegistry.has(KG_NEON_ID),
      graphAvailable: pool !== undefined,
      // The tenant every number above was priced against. Reported so a
      // `vectorsToDiscard: 0` can be told apart from "priced the wrong tenant".
      graphTenantId: tenantId,
      corpusError,
    };
  }

  /**
   * OM-84 (#1003) — the cheap readiness summary for the dashboard health strip.
   *
   * `GET /` counts the stored corpus per vector column, which is right for the
   * switch page and wrong for a card that renders on every dashboard load. This
   * route answers the one question the card asks (is `embeddingClient@1`
   * published, and by whom) from the registry alone. No pool, no counts.
   */
  router.get('/status', (_req: Request, res: Response) => {
    const providerIds = installedProviderIds(deps);
    const activeId = activeProviderId(deps, providerIds);
    res.json({
      capabilityPublished: deps.getEmbeddingClient() !== undefined,
      activeProviderId: activeId,
      activeModel: readActiveMetadata(deps),
      installedProviderIds: providerIds,
    });
  });

  router.get('/', async (_req: Request, res: Response) => {
    // Express 4 does not forward async-handler rejections to error middleware:
    // an uncaught pool failure would hang the request. Catch → 500.
    try {
      res.json(await snapshot());
    } catch (err) {
      res.status(500).json({
        code: 'embeddingProvider.read_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * What the keyless adapter needs before it can publish anything, and how far
   * a running download has got. 404 rather than an empty body when the adapter
   * is not active: "there is no keyless provider here" and "its weights are
   * missing" are different answers and the UI reacts differently to each.
   */
  router.get('/local-model', (_req: Request, res: Response) => {
    const fetcher = deps.getLocalModelFetcher?.();
    if (!fetcher) {
      res.status(404).json({
        code: 'embeddingProvider.local_model_unavailable',
        message:
          'the keyless embedding adapter (@omadia/embedding-adapter-local) is not active',
      });
      return;
    }
    res.json(fetcher.status());
  });

  /**
   * Start the download. Answers 202 immediately — it moves ~135 MB and takes
   * minutes, so holding the request open would just time out behind whatever
   * proxy sits in front. The UI polls `GET /local-model`.
   *
   * 409 on a second click while one is running, rather than silently starting
   * a second run: two runs would write the same `.partial` paths and race the
   * renames.
   */
  router.post('/local-model/fetch', (_req: Request, res: Response) => {
    const fetcher = deps.getLocalModelFetcher?.();
    if (!fetcher) {
      res.status(404).json({
        code: 'embeddingProvider.local_model_unavailable',
        message:
          'the keyless embedding adapter (@omadia/embedding-adapter-local) is not active',
      });
      return;
    }
    const status = fetcher.status();
    if (status.missingFiles.length === 0) {
      // Nothing to do, and saying so beats a 202 that resolves instantly and
      // leaves the operator wondering whether anything happened.
      res.json({ ok: true, started: false, reason: 'already-complete', ...status });
      return;
    }
    if (!fetcher.start()) {
      res.status(409).json({
        code: 'embeddingProvider.local_model_busy',
        message: 'a weight download is already running',
        ...fetcher.status(),
      });
      return;
    }
    res.status(202).json({ ok: true, started: true, ...fetcher.status() });
  });

  /**
   * OM-98 — bring the ACTIVE provider (back) into service, without a switch.
   *
   * Three states dead-ended before this route existed, and all three are the
   * normal shape of a subscription install:
   *
   *  - the keyless adapter activated before its weights were on disk, so it
   *    published nothing; the download finished, and the only thing that would
   *    re-read the weights was a full restart;
   *  - the governed vector columns are 768 wide and EMPTY while the adapter
   *    emits 384, so the gate blocks writes. The only path allowed to change a
   *    column width was an operator-confirmed provider SWITCH — and #1053
   *    removes the surplus provider at boot, so there is no second provider to
   *    switch to and nothing to confirm;
   *  - both at once, which is what a beta tester actually hit.
   *
   * So: re-activate the provider (publishing the capability if it now can),
   * then re-run the gate with the empty-column rebuild permitted. Emptiness is
   * checked here for a fast, specific refusal AND again inside the gate, which
   * is the check that counts — this one is a page-load-old preview.
   *
   * A non-empty corpus is refused with 409 and pointed at the switch path,
   * which is the one that carries the discard confirmation. This route never
   * destroys anything.
   */
  router.post('/reactivate', async (_req: Request, res: Response) => {
    if (switchInFlight) {
      res.status(409).json({
        code: 'embeddingProvider.switch_in_progress',
        message:
          'another embedding-provider change is still running; wait for it to finish and re-read the current state before retrying',
      });
      return;
    }
    switchInFlight = true;
    try {
      await handleReactivate(res);
    } finally {
      switchInFlight = false;
    }
  });

  async function handleReactivate(res: Response): Promise<void> {
    const providerIds = installedProviderIds(deps);
    const pluginId = activeProviderId(deps, providerIds);
    if (pluginId === null) {
      res.status(409).json({
        code: 'embeddingProvider.no_active_provider',
        message:
          'no embeddingClient@1 provider is active — install and activate one first; there is nothing to reactivate',
      });
      return;
    }

    // Price the rebuild BEFORE touching the runtime. A populated corpus is a
    // refusal, not a prompt: this route has no confirmation step by design.
    const pool = deps.getGraphPool();
    let corpus = EMPTY_CORPUS;
    if (pool) {
      try {
        corpus = await readCorpus(pool, resolveGraphTenantId(deps));
      } catch {
        corpus = EMPTY_CORPUS;
      }
    }
    if (corpus.storedVectorTotal !== null && corpus.storedVectorTotal > 0) {
      res.status(409).json({
        code: 'embeddingProvider.corpus_not_empty',
        message:
          'the governed vector columns still hold embeddings, so rebuilding them at another width would destroy a corpus — use the provider switch with confirmDiscardVectors instead',
        details: {
          vectorsToDiscard: corpus.storedVectorTotal,
          columnDimensions: corpus.columnDimensions,
        },
      });
      return;
    }

    // Deactivate → activate the SAME plugin. This is what makes a finished
    // weight download take effect: the adapter decides whether to publish
    // `embeddingClient@1` in its `activate()`, from the files it finds then.
    // The knowledge-graph is never touched here — see the module header on why
    // reactivating THAT would end the shared pool.
    try {
      await deps.deactivate(pluginId);
      await deps.activate(pluginId);
    } catch (err) {
      // ONE MORE ATTEMPT, THEN THE TRUTH. The deactivate already happened, so
      // a throw out of `activate` leaves this deployment with NO live
      // embedding provider — the same hole `/switch`'s `restorePrevious`
      // closes, reached by a shorter path. A second activate costs one call
      // and recovers the common cause (a transient read of the weights that
      // the adapter retries successfully).
      //
      // The response stays honest either way: `getEmbeddingClient()` is the
      // same evidence the forward path is held to, so a recovered provider is
      // reported as recovered and a dead one is still a 500. Never a rollback
      // claim the runtime does not support.
      await deps.activate(pluginId).catch(() => undefined);
      const recovered = deps.getEmbeddingClient() !== undefined;
      res.status(500).json({
        code: 'embeddingProvider.reactivate_failed',
        message: `reactivating '${pluginId}' failed (${err instanceof Error ? err.message : String(err)}); ${
          recovered
            ? 'a retry brought the provider back and embeddingClient@1 IS published again, but the gate was NOT re-evaluated — retry the reactivation'
            : 'the retry did not bring it back either, so this deployment currently has NO active embedding provider — check the middleware log'
        }`,
        details: { pluginId, capabilityPublished: recovered, gateReevaluated: false },
      });
      return;
    }

    const capabilityPublished = deps.getEmbeddingClient() !== undefined;

    // Re-gate even when nothing was published: the verdict on display was
    // computed against the client that just went away, and leaving it up would
    // be the provider-drift state this page exists to surface.
    const reevaluate = readReevaluator(deps.getGateStatus());
    let gateWarning: string | undefined;
    if (reevaluate === undefined) {
      gateWarning = NO_REEVALUATOR;
    } else {
      try {
        await reevaluate({
          // Never. This route is the non-destructive one.
          allowDestructiveMigration: false,
          // The capability that makes it useful — and the gate verifies the
          // emptiness itself before acting on it.
          allowEmptyColumnMigration: true,
        });
      } catch (err) {
        res.status(500).json({
          code: 'embeddingProvider.gate_reevaluation_failed',
          message: `'${pluginId}' was reactivated and ${capabilityPublished ? 'IS publishing embeddingClient@1' : 'still publishes nothing'}, but re-evaluating the knowledge-graph model/dimension gate against it failed (${err instanceof Error ? err.message : String(err)}). The graph is still up and its pool is intact, but it is governed by the PREVIOUS verdict — check the middleware log, then retry.`,
          details: { pluginId, capabilityPublished, gateReevaluated: false },
        });
        return;
      }
    }

    // Only once the provider is genuinely serving: a threshold tuned for a
    // vector space nothing writes into would be noise.
    const dedupThreshold = capabilityPublished
      ? await applyRecommendedDedupThreshold(deps, pluginId)
      : null;

    res.json({
      ok: true,
      reactivated: pluginId,
      capabilityPublished,
      gateReevaluated: reevaluate !== undefined,
      ...(gateWarning === undefined ? {} : { gateWarning }),
      dedupThreshold,
      ...(await snapshot()),
    });
  }

  router.post('/switch', async (req: Request, res: Response) => {
    const parsed = SwitchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'embeddingProvider.invalid_request',
        message: 'body must be { pluginId, confirmDiscardVectors? }',
        details: parsed.error.issues,
      });
      return;
    }
    const { pluginId, confirmDiscardVectors } = parsed.data;

    // Everything below reads registry state and then writes it. A second
    // caller must not interleave with that — see ONE SWITCH AT A TIME.
    if (switchInFlight) {
      res.status(409).json({
        code: 'embeddingProvider.switch_in_progress',
        message:
          'another embedding-provider switch is still running; wait for it to finish and re-read the current state before retrying',
      });
      return;
    }
    switchInFlight = true;
    try {
      await handleSwitch(pluginId, confirmDiscardVectors, res);
    } finally {
      switchInFlight = false;
    }
  });

  async function handleSwitch(
    pluginId: string,
    confirmDiscardVectors: boolean | undefined,
    res: Response,
  ): Promise<void> {
    // Never activate an arbitrary caller-supplied plugin id: the target must
    // be installed AND actually declare `embeddingClient@1`.
    const providerIds = installedProviderIds(deps);
    if (!providerIds.includes(pluginId)) {
      res.status(400).json({
        code: 'embeddingProvider.unknown_target',
        message: `'${pluginId}' is not an installed embeddingClient@1 provider`,
      });
      return;
    }

    const previousId = activeProviderId(deps, providerIds);
    if (previousId === pluginId) {
      res.status(409).json({
        code: 'embeddingProvider.already_active',
        message: `'${pluginId}' is already the active embedding provider`,
      });
      return;
    }

    // Price the switch BEFORE touching anything, and refuse an unconfirmed
    // destructive one. Fail closed: when the corpus size cannot be read the
    // switch counts as destructive.
    const pool = deps.getGraphPool();
    let corpus = EMPTY_CORPUS;
    if (pool) {
      try {
        // The tenant the PLUGIN uses, not the env default — pricing the wrong
        // one is how an unconfirmed switch used to wipe a populated corpus.
        corpus = await readCorpus(pool, resolveGraphTenantId(deps));
      } catch {
        corpus = EMPTY_CORPUS;
      }
    }
    const targetDimensions = describeProviderConfig(
      pluginId,
      deps.installedRegistry.get(pluginId)?.config ?? {},
    ).dimensions;
    const widthMatches =
      targetDimensions !== null &&
      corpus.columnDimensions !== null &&
      targetDimensions === corpus.columnDimensions;
    const destructive =
      corpus.storedVectorTotal === null || corpus.storedVectorTotal > 0 || !widthMatches;
    if (destructive && confirmDiscardVectors !== true) {
      res.status(400).json({
        code: 'embeddingProvider.confirmation_required',
        message:
          'switching the embedding provider discards the stored vectors and re-embeds them; resend with confirmDiscardVectors: true',
        details: {
          vectorsToDiscard: corpus.storedVectorTotal,
          columnDimensions: corpus.columnDimensions,
          targetDimensions,
        },
      });
      return;
    }

    let regate: RegateReport;
    try {
      regate = await applySwitch(deps, previousId, pluginId, {
        // THE destructive-capability handover. `destructive && !confirmed`
        // already returned above, so this is true exactly when the operator
        // ticked the box in front of the discard count. Nothing else in the
        // system can hand this capability over — activation certainly cannot.
        allowDestructiveMigration: confirmDiscardVectors === true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GateReevaluationFailed) {
        // The switch itself STUCK — the target owns the capability and the
        // registry is consistent. Reporting a rollback here would be a lie in
        // the other direction, so this is its own code.
        res.status(500).json({
          code: 'embeddingProvider.gate_reevaluation_failed',
          message,
          details: { switchedTo: pluginId, gateReevaluated: false },
        });
        return;
      }
      res.status(err instanceof SwitchRolledBack ? 409 : 500).json({
        code:
          err instanceof SwitchRolledBack
            ? 'embeddingProvider.target_unavailable'
            : 'embeddingProvider.switch_failed',
        message,
        // Only claim a restore that was VERIFIED. A generic throw restores
        // nothing, and a rollback whose own `activate` failed restores nothing
        // either — both used to report `restoredProviderId: previousId`
        // regardless, which sent the operator looking at the wrong provider.
        details:
          err instanceof SwitchRolledBack
            ? { restoredProviderId: err.restoredProviderId }
            : {},
      });
      return;
    }

    res.json({
      ok: true,
      switchedTo: pluginId,
      // Say whether the gate actually re-ran. A switch against a deployment
      // with no Postgres knowledge-graph is a legitimate success, but it is a
      // different success from one whose vector columns were just re-gated.
      gateReevaluated: regate.reevaluated,
      ...(regate.warning === undefined ? {} : { gateWarning: regate.warning }),
      ...(await snapshot()),
    });
  }

  return router;
}

/**
 * The `(768d)` suffix `describeGateOutcome` appends on some arms and not
 * others. Stripped before comparing so a purely cosmetic difference in how the
 * verdict was worded never reads as drift.
 */
const GATE_MODEL_DIMENSION_SUFFIX = / \((\d+)d\)$/;

/**
 * What a FAILED gate evaluation puts in the model-name slot — see
 * `gateEvaluationFailed` in the knowledge-graph plugin's `gateReevaluation.ts`,
 * which degrades to `blocked` with `modelId: '(gate evaluation failed: …)'`
 * rather than crash-looping activation.
 *
 * It is a diagnostic string, not a model identity, so it can never DISAGREE
 * with the registry in the sense this warning means. Reporting it as drift
 * rendered the sentence "the verdict names <(gate evaluation failed: …)>" on a
 * page whose whole job is naming models. The gate's own `blocked` status
 * already tells the operator what is wrong there.
 */
const GATE_FAILURE_SENTINEL = /^\(gate evaluation failed:/;

/**
 * PROVIDER DRIFT — the registry's live client names a different model than the
 * verdict currently governing the graph.
 *
 * Reachable without anything going wrong: the generic plugin-install UI can
 * activate a different `embeddingClient@1` adapter, and it deliberately does
 * not re-gate (only Admin → Embedding provider does, behind an explicit
 * discard confirmation). The graph then keeps refusing or allowing writes on
 * the strength of a verdict about a model nobody is using any more. Both
 * numbers were already on the page; only their disagreement was silent.
 *
 * `null` whenever the comparison cannot be made — no client published, no
 * gate, or an `unknown-provider` verdict that names no model at all. Absence of
 * evidence is not drift.
 */
function describeProviderDrift(
  activeModel: { modelId: string; dimensions: number } | null,
  gate: EmbeddingGateStatus | null,
): { activeModelId: string; gateModelId: string } | null {
  if (activeModel === null || gate === null) return null;
  const gateModelId = gate.activeModelId;
  if (typeof gateModelId !== 'string' || gateModelId.length === 0) return null;
  if (GATE_FAILURE_SENTINEL.test(gateModelId)) return null;
  const suffix = GATE_MODEL_DIMENSION_SUFFIX.exec(gateModelId);
  const normalised = gateModelId.replace(GATE_MODEL_DIMENSION_SUFFIX, '');
  if (normalised !== activeModel.modelId) {
    return { activeModelId: activeModel.modelId, gateModelId: normalised };
  }
  // SAME NAME, DIFFERENT WIDTH. Comparing names alone missed it, and it is the
  // more dangerous half: a model id is free text an adapter chooses, so two
  // adapters can publish the same name at different widths, and the width is
  // what the governed `vector(n)` columns are actually shaped for. The suffix
  // is the only place the verdict carries its width, so this comparison is
  // only possible for the outcomes that render one.
  const gateDimensions = suffix?.[1] === undefined ? null : Number(suffix[1]);
  if (gateDimensions === null || gateDimensions === activeModel.dimensions) {
    return null;
  }
  // Widths are what disagree, so both sides carry theirs — "X vs X" would read
  // as a bug in the warning rather than a real divergence.
  return {
    activeModelId: `${activeModel.modelId} (${String(activeModel.dimensions)}d)`,
    gateModelId: `${normalised} (${String(gateDimensions)}d)`,
  };
}

function readActiveMetadata(
  deps: AdminEmbeddingProviderDeps,
): { modelId: string; dimensions: number } | null {
  const client = deps.getEmbeddingClient() as
    Partial<{ modelId: string; dimensions: number }> | undefined;
  if (!client) return null;
  const { modelId, dimensions } = client;
  if (typeof modelId !== 'string' || !Number.isInteger(dimensions)) return null;
  return { modelId, dimensions: dimensions as number };
}

/** Flip the registry entry's status without touching its config or secrets. */
async function setStatus(
  registry: InstalledRegistry,
  pluginId: string,
  status: 'active' | 'inactive',
): Promise<void> {
  const entry = registry.get(pluginId);
  if (!entry) return;
  await registry.register({ ...entry, status });
}

/**
 * Deactivate → activate → re-gate, with a restore path.
 *
 * The registry status is flipped alongside the runtime call because
 * `activateAllInstalled` only activates entries the registry marks active —
 * leaving both providers at `status: 'active'` would crash the NEXT boot in
 * `ctx.services.provide` with two `embeddingClient@1` providers. Callers hold
 * `switchInFlight` for the whole of this function, which is what makes that
 * reasoning hold under concurrency rather than only in the single-caller case.
 */
/** What the in-place re-gate did, so the response can say so. */
interface RegateReport {
  readonly reevaluated: boolean;
  readonly warning?: string;
}

async function applySwitch(
  deps: AdminEmbeddingProviderDeps,
  previousId: string | null,
  targetId: string,
  opts: { allowDestructiveMigration: boolean },
): Promise<RegateReport> {
  if (previousId !== null) {
    await deps.deactivate(previousId);
    await setStatus(deps.installedRegistry, previousId, 'inactive');
  }

  /**
   * Put the world back. Returns the provider id that is VERIFIED live again,
   * or `null` when nothing came back.
   *
   * Both steps used to be `.catch(() => undefined)` and the caller reported a
   * restore either way. That is how a failed rollback became a `409 … the
   * previous provider was restored` over a deployment with NO live provider at
   * all. The post-condition is `getEmbeddingClient()`, i.e. the same evidence
   * the forward path is held to.
   */
  const restorePrevious = async (): Promise<string | null> => {
    await deps.deactivate(targetId).catch(() => false);
    await setStatus(deps.installedRegistry, targetId, 'inactive');
    if (previousId === null) return null;
    await setStatus(deps.installedRegistry, previousId, 'active');
    await deps.activate(previousId).catch(() => undefined);
    if (deps.getEmbeddingClient() === undefined) {
      // The restore did not take. Do not leave the registry claiming a
      // provider that is not live — the next boot would activate it into the
      // same failure while this response said everything was fine.
      await setStatus(deps.installedRegistry, previousId, 'inactive');
      return null;
    }
    // The knowledge-graph's gate approved the OUTGOING client; re-gate so the
    // resolver hands out the restored one rather than a disposed reference.
    // Never destructive: the target never activated, so no column ever moved,
    // and a rollback that dropped a corpus would be its own incident.
    await readReevaluator(deps.getGateStatus())?.({
      allowDestructiveMigration: false,
    }).catch(() => undefined);
    return previousId;
  };

  await setStatus(deps.installedRegistry, targetId, 'active');
  try {
    await deps.activate(targetId);
  } catch (err) {
    const restored = await restorePrevious();
    throw new SwitchRolledBack(
      `activating '${targetId}' failed (${err instanceof Error ? err.message : String(err)}) — ${describeRestore(restored)}`,
      restored,
    );
  }

  // An adapter that activates without publishing anything (no API key in the
  // vault, no ollama_base_url) leaves the deployment with NO embedding
  // provider — strictly worse than not switching. Treat it as a failure.
  if (deps.getEmbeddingClient() === undefined) {
    const restored = await restorePrevious();
    throw new SwitchRolledBack(
      `'${targetId}' activated but published no embeddingClient@1 — it is not configured (missing API key or base URL); ${describeRestore(restored)}`,
      restored,
    );
  }

  // Re-run the model/dimension gate against the new provider, IN PLACE. This
  // is what re-points the knowledge-graph's embedding resolver at the client
  // that just took over — without it the switch would report success while the
  // graph kept embedding with the previous provider — and it is what rewrites
  // the vector columns when the width changed and the operator confirmed it.
  // Nothing is deactivated, so the shared `graphPool` survives.
  const reevaluate = readReevaluator(deps.getGateStatus());
  if (reevaluate === undefined) {
    return { reevaluated: false, warning: NO_REEVALUATOR };
  }
  try {
    await reevaluate({ allowDestructiveMigration: opts.allowDestructiveMigration });
  } catch (err) {
    throw new GateReevaluationFailed(
      `the embedding provider was switched to '${targetId}' and IS live, but re-evaluating the knowledge-graph model/dimension gate against it failed (${err instanceof Error ? err.message : String(err)}). The graph is still up and its pool is intact, but it is still governed by the PREVIOUS verdict — check the middleware log, then retry the switch.`,
    );
  }
  return { reevaluated: true };
}

/** Wording for a rollback that may or may not have taken. */
function describeRestore(restored: string | null): string {
  return restored === null
    ? 'AND THE PREVIOUS PROVIDER COULD NOT BE RESTORED — there is no live embeddingClient@1 right now; configure one and activate it'
    : `the previous provider ('${restored}') was restored and verified live`;
}
