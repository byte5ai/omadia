import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';

/**
 * Memory-storage backend switch — operator-facing admin endpoint.
 *
 * Mounted at `/api/v1/admin/memory/backend` behind `requireAuth` (cookie
 * session JWT), consistent with the sibling `/api/v1/admin/memory/purge`
 * router that the admin UI calls. NOT on the machine `ADMIN_TOKEN` surface.
 *
 * The backend is selected at boot by `bootstrapMemoryFromEnv`: a PERSISTED
 * operator choice — the `memory_backend` config key on the active
 * `memoryStore` provider's installed-registry entry — wins over the
 * `MEMORY_BACKEND` env default. Postgres REQUIRES `DATABASE_URL` (it consumes
 * the Neon KG's shared graphPool); without it the bootstrap falls back to
 * filesystem.
 *
 * This router only PERSISTS the choice. The actual provider swap happens on
 * the NEXT restart, when `bootstrapMemoryFromEnv` reconciles install-state to
 * the persisted choice — a live hot-swap is out of scope. The UI is told a
 * restart is required.
 */

// Mirror of the provider ids in bootstrap.ts. Kept local so this router has
// no import-cycle into the bootstrap module.
const MEMORY_TOOL_ID = '@omadia/memory';
const MEMORY_POSTGRES_ID = '@omadia/memory-postgres';

type Backend = 'filesystem' | 'postgres';

const PutBodySchema = z.object({
  backend: z.enum(['filesystem', 'postgres']),
});

export interface MemoryBackendDeps {
  registry: InstalledRegistry;
  config: Config;
}

/** The provider id that is currently registered+active, if any. Only one of
 *  the two memoryStore providers is ever registered at a time (bootstrap
 *  removes the non-selected one). Prefer the postgres entry when, for any
 *  transient both-registered state, both exist. */
function activeProviderId(registry: InstalledRegistry): string | null {
  if (registry.has(MEMORY_POSTGRES_ID)) return MEMORY_POSTGRES_ID;
  if (registry.has(MEMORY_TOOL_ID)) return MEMORY_TOOL_ID;
  return null;
}

/** Resolve the DESIRED backend: the persisted operator choice (read from
 *  whichever provider entry carries `memory_backend`) wins over the
 *  `MEMORY_BACKEND` env default; then apply the postgres→filesystem fallback
 *  when DATABASE_URL is unset. Mirrors `resolveMemoryBackend` in bootstrap.ts. */
function resolveDesiredBackend(deps: MemoryBackendDeps): Backend {
  const persisted =
    (deps.registry.get(MEMORY_POSTGRES_ID)?.config?.['memory_backend'] as
      | string
      | undefined) ??
    (deps.registry.get(MEMORY_TOOL_ID)?.config?.['memory_backend'] as
      | string
      | undefined);
  let backend: Backend =
    persisted === 'postgres' || persisted === 'filesystem'
      ? persisted
      : deps.config.MEMORY_BACKEND;
  if (backend === 'postgres' && !deps.config.DATABASE_URL) {
    backend = 'filesystem';
  }
  return backend;
}

/** Which backend is currently RUNNING — derived from which provider is the
 *  active registry entry. Used to decide whether a restart is pending. */
function runningBackend(registry: InstalledRegistry): Backend | null {
  const active = activeProviderId(registry);
  if (active === MEMORY_POSTGRES_ID) return 'postgres';
  if (active === MEMORY_TOOL_ID) return 'filesystem';
  return null;
}

export function createMemoryBackendRouter(deps: MemoryBackendDeps): Router {
  const router = Router();

  // Current state + whether a restart is pending to apply a persisted switch.
  router.get('/', (_req: Request, res: Response) => {
    const desired = resolveDesiredBackend(deps);
    const running = runningBackend(deps.registry);
    const databaseUrlPresent = Boolean(deps.config.DATABASE_URL);
    // A restart is required when the resolved/desired backend differs from the
    // provider that is actually active right now. When no provider is
    // registered yet (cold boot edge), there is nothing to reconcile.
    const restartRequiredToApply = running !== null && running !== desired;
    res.json({
      current: desired,
      envDefault: deps.config.MEMORY_BACKEND,
      databaseUrlPresent,
      activeProviderId: activeProviderId(deps.registry),
      restartRequiredToApply,
    });
  });

  // Persist the operator's backend choice onto the active provider's entry.
  // Takes effect on the next restart.
  router.put('/', async (req: Request, res: Response) => {
    const parsed = PutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { backend } = parsed.data;

    if (backend === 'postgres' && !deps.config.DATABASE_URL) {
      res.status(400).json({
        error: 'database_url_required',
        message:
          'Postgres-Backend benötigt DATABASE_URL (Neon-KG/graphPool). Setze DATABASE_URL und starte neu, bevor du auf Postgres wechselst.',
      });
      return;
    }

    // Write onto whichever memoryStore provider is currently registered. Only
    // one is ever registered at a time; if for some reason neither is, there
    // is nothing to persist the choice onto.
    const targetId = activeProviderId(deps.registry);
    if (targetId === null) {
      res.status(409).json({ error: 'no_memory_provider' });
      return;
    }
    const entry = deps.registry.get(targetId);
    if (!entry) {
      res.status(409).json({ error: 'no_memory_provider' });
      return;
    }

    await deps.registry.register({
      ...entry,
      config: { ...entry.config, memory_backend: backend },
    });

    res.json({ ok: true, backend, restartRequired: true });
  });

  return router;
}
