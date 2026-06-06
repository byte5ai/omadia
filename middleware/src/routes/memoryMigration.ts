import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { MemoryStore } from '@omadia/plugin-api';
import { FilesystemMemoryStore } from '@omadia/memory/dist/filesystem.js';

import type { Config } from '../config.js';
import {
  migrateMemory,
  previewMigration,
} from '../services/memoryMigration.js';

/**
 * One-time memory migration — operator-facing admin endpoints.
 *
 * Mounted at `/api/v1/admin/memory/migrate` behind `requireAuth` (cookie
 * session JWT), consistent with the sibling `/api/v1/admin/memory/{purge,backend}`
 * routers the admin UI calls. NOT on the machine `ADMIN_TOKEN` surface.
 *
 * Purpose: when an operator switches `MEMORY_BACKEND` from `filesystem` to
 * `postgres`, the active `memoryStore` provider becomes the Postgres store and
 * the on-disk `/memories` tree is no longer read — orphaning the existing
 * data. This endpoint copies every on-disk file into the now-active store, so
 * it can be run ONCE right after the switch (while the old filesystem volume is
 * still mounted) to carry the data over.
 *
 * The SOURCE is ALWAYS a fresh `FilesystemMemoryStore(config.MEMORY_DIR)` — it
 * reads the on-disk files directly, regardless of which backend is currently
 * active. The TARGET is the active `memoryStore` service (the kernel's current
 * provider), threaded in as `targetStore` exactly like the purge router gets
 * `store`.
 *
 * When the active backend is STILL filesystem (pointing at the same
 * `MEMORY_DIR`), the migration is an idempotent near no-op: every source path
 * already exists in the target → all skipped. We can't cheaply prove
 * source/target identity, so we surface a `note` in the response explaining the
 * operation is only meaningful AFTER switching to Postgres.
 */

const PostBodySchema = z.object({
  overwrite: z.boolean().optional(),
});

const MIGRATION_NOTE =
  'Quelle ist immer das on-disk /memories (MEMORY_DIR). Diese Migration ist ' +
  'erst nach dem Umschalten auf Postgres sinnvoll — solange das aktive ' +
  'Backend ebenfalls das Dateisystem ist, sind alle Pfade bereits vorhanden ' +
  'und werden übersprungen.';

export interface MemoryMigrationDeps {
  /** The active memoryStore provider (kernel's current backend) = the TARGET. */
  targetStore: MemoryStore;
  config: Config;
}

/** Build a fresh on-disk source store over `MEMORY_DIR`. Always filesystem,
 *  regardless of the active backend, so the on-disk data is readable even
 *  after the active provider has been switched to Postgres. */
async function buildFilesystemSource(config: Config): Promise<FilesystemMemoryStore> {
  const source = new FilesystemMemoryStore(config.MEMORY_DIR);
  await source.init();
  return source;
}

export function createMemoryMigrationRouter(deps: MemoryMigrationDeps): Router {
  const router = Router();

  // Dry-run preview — counts what the migration WOULD copy without writing.
  // A missing MEMORY_DIR yields `{ totalFiles: 0, ... }` (walkAllFiles
  // tolerates a missing root), so this never errors on a fresh install.
  router.get('/preview', async (_req: Request, res: Response): Promise<void> => {
    try {
      const source = await buildFilesystemSource(deps.config);
      const preview = await previewMigration(source, deps.targetStore);
      res.json({ ...preview, note: MIGRATION_NOTE });
    } catch (err) {
      res.status(500).json({
        error: 'migration_preview_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Execute the migration. Per-file failures are tolerated and reported in
  // `failed` / `errors`; the run as a whole only 500s on an enumeration
  // failure of the source.
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = PostBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const source = await buildFilesystemSource(deps.config);
      const result = await migrateMemory(source, deps.targetStore, {
        ...(parsed.data.overwrite !== undefined
          ? { overwrite: parsed.data.overwrite }
          : {}),
      });
      res.json({ ...result, note: MIGRATION_NOTE });
    } catch (err) {
      res.status(500).json({
        error: 'migration_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
