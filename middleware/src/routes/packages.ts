import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';

import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { PackageUploadService } from '../plugins/packageUploadService.js';
import type { UploadedPackageStore } from '../plugins/uploadedPackageStore.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';

/**
 * Zip-upload endpoints for agent packages.
 *
 * Mounted at /api/v1/install/packages, behind requireAuth. Feature-gated by
 * `PACKAGE_UPLOAD_ENABLED` — when false, the middleware does not return a
 * router (endpoint absent → 404 instead of 503, so scrapers learn nothing).
 *
 * Endpoints:
 *   POST   /packages/upload      multipart file=<zip>
 *   GET    /packages             list uploaded
 *   DELETE /packages/:id         remove uploaded (reject if installed)
 */

export interface PackagesRouterDeps {
  service: PackageUploadService;
  store: UploadedPackageStore;
  registry: InstalledRegistry;
  catalog: PluginCatalog;
  maxBytes: number;
}

export function createPackagesRouter(deps: PackagesRouterDeps): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: deps.maxBytes,
      files: 1,
      fields: 4,
    },
    fileFilter: (_req, file, cb) => {
      if (
        file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.mimetype === 'application/octet-stream' ||
        file.originalname.toLowerCase().endsWith('.zip')
      ) {
        cb(null, true);
        return;
      }
      cb(new Error(`unsupported mimetype: ${file.mimetype}`));
    },
  });

  router.post(
    '/upload',
    (req, res, next) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        const isMulterError =
          err instanceof multer.MulterError ||
          (typeof err === 'object' && err !== null && 'code' in err);
        const code = isMulterError
          ? String((err as { code?: string }).code ?? 'upload.multipart')
          : 'upload.multipart';
        const message = err instanceof Error ? err.message : String(err);
        const status = code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        res.status(status).json({
          code: `upload.${code.toLowerCase()}`,
          message,
        });
      });
    },
    async (req: Request, res: Response) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({
          code: 'upload.no_file',
          message: "Feld 'file' (multipart) fehlt.",
        });
        return;
      }
      const session = (req as Request & { session?: { email: string } })
        .session;
      const uploadedBy = session?.email ?? 'unknown';

      const result = await deps.service.ingest({
        fileBuffer: file.buffer,
        originalFilename: file.originalname,
        uploadedBy,
      });

      if (!result.ok) {
        const status = mapIngestCodeToStatus(result.code);
        res.status(status).json({
          code: result.code,
          message: result.message,
          ...(result.details !== undefined ? { details: result.details } : {}),
        });
        return;
      }

      res.status(201).json({ package: result.package });
    },
  );

  router.get('/', (_req: Request, res: Response) => {
    const items = deps.store.list();
    res.json({ items });
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const rawId = req.params['id'];
    const id = typeof rawId === 'string' ? rawId : '';
    if (!id) {
      res.status(400).json({
        code: 'package.invalid_id',
        message: 'id fehlt',
      });
      return;
    }
    if (deps.registry.has(id)) {
      res.status(409).json({
        code: 'package.still_installed',
        message:
          'Package ist noch installiert. Erst deinstallieren, dann entfernen.',
      });
      return;
    }
    const ok = await deps.store.remove(id);
    if (!ok) {
      res.status(404).json({
        code: 'package.not_found',
        message: `kein Upload mit id '${id}'`,
      });
      return;
    }
    // Catalog mirrors uploaded packages at boot + after upload. Without a
    // reload the plugin entry would be gone from the store after DELETE,
    // but the in-memory catalog would still know it — a subsequent
    // install-create call would then create a "ghost job" whose
    // onInstalled hook in DynamicAgentRuntime silently registers no tool.
    // Reload here = accurate state for all following store/install calls.
    await deps.catalog.load();
    res.status(204).end();
  });

  return router;
}

function mapIngestCodeToStatus(code: string): number {
  switch (code) {
    case 'package.too_large':
    case 'zip.file_too_large':
    case 'zip.total_too_large':
      return 413;
    case 'package.manifest_missing':
    case 'package.manifest_invalid':
    case 'package.package_json_invalid':
    case 'package.id_mismatch':
    case 'package.version_mismatch':
    case 'package.entry_missing':
    case 'zip.invalid':
    case 'zip.too_many_entries':
    case 'zip.path_escape':
    case 'zip.symlink':
    case 'zip.forbidden_extension':
      return 422;
    case 'package.id_conflict_builtin':
    case 'package.duplicate_version':
      return 409;
    default:
      return 400;
  }
}
