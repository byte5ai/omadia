import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';

import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { PackageUploadService } from '../plugins/packageUploadService.js';
import {
  ingestFailureBody,
  ingestFailureStatus,
} from '../plugins/ingestErrorContract.js';
import type { UploadedPackageStore } from '../plugins/uploadedPackageStore.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import { isTruthyFlag } from '../http/requestFlags.js';
import { auditActorFromRequest, type AdminAuditLog } from '../auth/adminAuditLog.js';

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
  log?: (msg: string) => void;
  /** #1490 — package removal is an admin action like uninstall. Optional:
   *  without it (no database) only the log line is written. */
  audit?: AdminAuditLog;
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
    // #1489 — no mimetype gate. It only ever read what the client DECLARED
    // (part content-type and file name), so the same bytes got 400 or 422
    // depending on the headers, and it stopped nothing: the zip check that
    // counts is the content one in `PackageUploadService.ingest`, which every
    // non-zip reaches and answers 422 `zip.invalid`.
  });

  router.post(
    '/upload',
    (req, res, next) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        // #1489 — the fallback is the bare suffix: `upload.` is prepended
        // once, below, for multer's own codes and this one alike. It used to
        // be `upload.multipart` here as well, which every error without a
        // `code` (a truncated multipart body, a busboy parse error) answered
        // as `upload.upload.multipart`.
        const multerCode =
          err instanceof multer.MulterError ||
          (typeof err === 'object' && err !== null && 'code' in err)
            ? (err as { code?: unknown }).code
            : undefined;
        const code =
          typeof multerCode === 'string' && multerCode.length > 0
            ? multerCode
            : 'multipart';
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
        // #1477 — same status and body as the Hub install and the builder.
        res.status(ingestFailureStatus(result.code)).json(ingestFailureBody(result));
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
        // #1490 — the version this upload replaced, so the dropzone can say
        // so instead of reporting a swap as a first upload.
        ...(result.replaced_version !== undefined
          ? { replaced_version: result.replaced_version }
          : {}),
        ...(result.activation_error !== undefined
          ? { activation_error: result.activation_error }
          : {}),
      });
    },
  );

  router.get('/', (_req: Request, res: Response) => {
    const items = deps.store.list();
    res.json({ items });
  });

  const log = deps.log ?? ((msg: string) => console.log(msg));

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
    const removed = deps.store.get(id);
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
    // #1490 — the removal used to leave no trace at all.
    const actor = auditActorFromRequest(req);
    log(
      `[upload] package removed id=${id} version=${removed?.version ?? '?'} by=${actor.email ?? actor.id ?? 'unknown'}`,
    );
    if (deps.audit) {
      try {
        await deps.audit.record({
          actor,
          action: 'plugin.package_remove',
          target: `plugin:${id}`,
          before: { version: removed?.version ?? null, uploaded_by: removed?.uploaded_by ?? null },
        });
      } catch (err) {
        log(
          `[upload] audit write failed for package removal ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    res.status(204).end();
  });

  return router;
}
