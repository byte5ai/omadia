import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';

import type { PluginCatalog } from '../plugins/manifestLoader.js';
import {
  INGEST_CONFLICT_CODES,
  type PackageUploadService,
} from '../plugins/packageUploadService.js';
import type { UploadedPackageStore } from '../plugins/uploadedPackageStore.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import { isTruthyFlag } from '../http/requestFlags.js';

/**
 * Zip-upload endpoints for agent packages.
 *
 * Mounted at /api/v1/install/packages, behind requireAuth. Feature-gated by
 * `PACKAGE_UPLOAD_ENABLED` — when false, the middleware does not return a
 * router (endpoint absent → 404 instead of 503, so scrapers learn nothing).
 *
 * Endpoints:
 *   POST   /packages/upload      multipart file=<zip> [, allow_downgrade=1]
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
          // #1401 — multer's text is English; the limit lets the UI say it
          // in the operator's locale.
          ...(code === 'LIMIT_FILE_SIZE'
            ? { params: { maxBytes: String(deps.maxBytes) } }
            : {}),
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

      // #1455 — an older zip of an installed plugin is refused unless the
      // operator confirms. The consent travels as a multipart text field (what
      // the upload dialog sends alongside the file); a query parameter is
      // accepted too, for curl. An EMPTY field is not consent — that is what a
      // form sends when the operator left it alone — so only the query string
      // may use the bare-flag spelling.
      const allowDowngrade =
        isTruthyFlag(
          (req.body as Record<string, unknown> | undefined)?.['allow_downgrade'],
        ) || isTruthyFlag(req.query['allow_downgrade'], { bareFlag: true });

      const result = await deps.service.ingest({
        fileBuffer: file.buffer,
        originalFilename: file.originalname,
        uploadedBy,
        ...(allowDowngrade ? { allowDowngrade: true } : {}),
      });

      if (!result.ok) {
        const status = mapIngestCodeToStatus(result.code);
        res.status(status).json({
          code: result.code,
          message: result.message,
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(result.params !== undefined ? { params: result.params } : {}),
        });
        return;
      }

      // #1455 — `direction` is present only when this upload replaced another
      // version. It is here so a caller cannot mistake a downgrade for an
      // update; the store dialog reports the refusal, not this field.
      // #1452 — `activation_error` present means the ZIP was ingested but the
      // re-activation of the running plugin threw; the registry entry has been
      // flipped to `errored` with the same message.
      res.status(201).json({
        package: result.package,
        ...(result.direction !== undefined ? { direction: result.direction } : {}),
        ...(result.activation_error !== undefined
          ? { activation_error: result.activation_error }
          : {}),
        ...(result.activation !== undefined ? { activation: result.activation } : {}),
      });
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
  // Host-state refusals (id taken, version already there, older version) come
  // from one set shared with the Hub-install route — see
  // `INGEST_CONFLICT_CODES`. `package.incompatible_core` is not in it but
  // answers the same status, for the reason noted below.
  if (INGEST_CONFLICT_CODES.has(code)) return 409;
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
    // `package.incompatible_core` belongs with the conflicts rather than the
    // 422s: a valid package whose compat.core range excludes this host's
    // @omadia/plugin-api. It stays a case of its own because the builder route
    // maps it to a reason of its own.
    case 'package.incompatible_core':
      return 409;
    default:
      return 400;
  }
}
