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
  EMBEDDING_CLIENT_CAPABILITY,
  KG_NEON_ID,
  describeProviderConfig,
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
 * and the gate auto-migrates the vector columns on a width change. So this
 * router performs the switch: deactivate the current provider, activate the
 * target, then re-activate the knowledge-graph so its gate re-runs against the
 * new provider. No process restart anywhere in this path.
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
 * not.
 */

const SwitchBodySchema = z.object({
  pluginId: z.string().min(1),
  confirmDiscardVectors: z.boolean().optional(),
});

export interface AdminEmbeddingProviderDeps {
  readonly installedRegistry: InstalledRegistry;
  /** Manifest catalog — the source of truth for who provides the capability. */
  readonly catalog: EmbeddingProviderCatalog;
  /** Live `embeddingClient@1` service, as the knowledge-graph resolves it. */
  readonly getEmbeddingClient: () => EmbeddingClient | undefined;
  /** Live gate verdict. NOT cached — `vectorWritesAllowed` flips false→true
   *  in-process when a stale-vector clear drains, and a captured copy would
   *  show a stale red forever. */
  readonly getGateStatus: () => EmbeddingGateStatus | undefined;
  /** Neon pool. Undefined on the in-memory knowledge-graph backend, in which
   *  case there are no governed vector columns to price. */
  readonly getGraphPool: () => Pool | undefined;
  readonly tenantId: string;
  /** Runtime activation of a tool/extension plugin (ToolPluginRuntime). */
  readonly activate: (pluginId: string) => Promise<void>;
  readonly deactivate: (pluginId: string) => Promise<boolean>;
  /** Tear down + bring back up so a plugin re-reads its world. Used on the
   *  knowledge-graph so the gate re-evaluates against the new provider. */
  readonly reactivate: (pluginId: string) => Promise<void>;
}

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

/** Read the current `auto_migrate_vector_columns` value off the KG entry.
 *  Manifest default is `'true'`; anything but the literal `'false'` reads as
 *  on, mirroring `plugin.ts`. */
function autoMigrateEnabled(registry: InstalledRegistry): boolean {
  const raw = registry.get(KG_NEON_ID)?.config?.[AUTO_MIGRATE_CONFIG_KEY];
  return (
    String(raw ?? 'true')
      .trim()
      .toLowerCase() !== 'false'
  );
}

/** Raised when the target could not take over and the previous provider was
 *  put back. Distinguished from a genuine failure so the caller can say so. */
class SwitchRolledBack extends Error {}

export function createAdminEmbeddingProviderRouter(deps: AdminEmbeddingProviderDeps): Router {
  const router = Router();

  /** Everything the page needs, in one call. */
  async function snapshot(): Promise<Record<string, unknown>> {
    const providerIds = installedProviderIds(deps);
    const activeId = activeProviderId(deps, providerIds);
    const pool = deps.getGraphPool();

    let corpus = EMPTY_CORPUS;
    let recorded: Awaited<ReturnType<typeof readRecordedModel>> = null;
    let corpusError: string | null = null;
    if (pool) {
      try {
        corpus = await readCorpus(pool, deps.tenantId);
        recorded = await readRecordedModel(pool, deps.tenantId);
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
    return {
      providers,
      activeProviderId: activeId,
      activeModel: activeMetadata,
      capabilityPublished: deps.getEmbeddingClient() !== undefined,
      corpus: recorded,
      columns: corpus.columns,
      columnDimensions: corpus.columnDimensions,
      storedVectorTotal: corpus.storedVectorTotal,
      gate: deps.getGateStatus() ?? null,
      autoMigrateVectorColumns: autoMigrateEnabled(deps.installedRegistry),
      knowledgeGraphInstalled: deps.installedRegistry.has(KG_NEON_ID),
      graphAvailable: pool !== undefined,
      corpusError,
    };
  }

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
        corpus = await readCorpus(pool, deps.tenantId);
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

    try {
      await applySwitch(deps, previousId, pluginId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof SwitchRolledBack ? 409 : 500).json({
        code:
          err instanceof SwitchRolledBack
            ? 'embeddingProvider.target_unavailable'
            : 'embeddingProvider.switch_failed',
        message,
        details: { restoredProviderId: previousId },
      });
      return;
    }

    res.json({ ok: true, switchedTo: pluginId, ...(await snapshot()) });
  });

  return router;
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
 * `ctx.services.provide` with two `embeddingClient@1` providers.
 */
async function applySwitch(
  deps: AdminEmbeddingProviderDeps,
  previousId: string | null,
  targetId: string,
): Promise<void> {
  if (previousId !== null) {
    await deps.deactivate(previousId);
    await setStatus(deps.installedRegistry, previousId, 'inactive');
  }

  const restorePrevious = async (): Promise<void> => {
    await deps.deactivate(targetId).catch(() => false);
    await setStatus(deps.installedRegistry, targetId, 'inactive');
    if (previousId !== null) {
      await setStatus(deps.installedRegistry, previousId, 'active');
      await deps.activate(previousId).catch(() => undefined);
    }
    // The knowledge-graph captured the outgoing client at its last activate();
    // re-gate so it goes back to the restored one rather than a disposed
    // reference.
    await deps.reactivate(KG_NEON_ID).catch(() => undefined);
  };

  await setStatus(deps.installedRegistry, targetId, 'active');
  try {
    await deps.activate(targetId);
  } catch (err) {
    await restorePrevious();
    throw new SwitchRolledBack(
      `activating '${targetId}' failed (${err instanceof Error ? err.message : String(err)}) — the previous provider was restored`,
    );
  }

  // An adapter that activates without publishing anything (no API key in the
  // vault, no ollama_base_url) leaves the deployment with NO embedding
  // provider — strictly worse than not switching. Treat it as a failure.
  if (deps.getEmbeddingClient() === undefined) {
    await restorePrevious();
    throw new SwitchRolledBack(
      `'${targetId}' activated but published no embeddingClient@1 — it is not configured (missing API key or base URL); the previous provider was restored`,
    );
  }

  // Re-run the model/dimension gate against the new provider. This is what
  // migrates the vector columns when the width changed — in-process, no
  // restart.
  await deps.reactivate(KG_NEON_ID);
}
