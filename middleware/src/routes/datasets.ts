import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

import type { KnowledgeGraph } from '@omadia/plugin-api';
import { DatasetQueryValidationError } from '@omadia/plugin-api';
import { importCsvDataset, isCsvAttachment } from '@omadia/orchestrator';

/**
 * #430 — REST surface for structured dataset ingestion (CSV import).
 *
 * Mounted under `/api/v1/datasets`, ACL pattern mirrors `/api/v1/memory`
 * (`memory.ts`): `req.session.omadia_user_id` is the sole owner/viewer
 * identity, no anonymous access. Upload pattern mirrors the package-zip
 * upload route (`packages.ts`): `multer` memory storage, one file per
 * request, mapped error codes on 4xx.
 *
 * Every uploaded row runs through the SAME privacy-scan pipeline as the
 * chat-attachment auto-ingest path — both call `importCsvDataset` from
 * `@omadia/orchestrator`, so there is exactly one place the scan could be
 * skipped, and this route isn't it.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirrors TEAMS_ATTACHMENT_MAX_BYTES default

const RowsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

function mapErrorToHttp(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof DatasetQueryValidationError) {
    return { status: 400, code: `dataset.${err.code}`, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, code: 'dataset.internal_error', message };
}

export function createDatasetsRouter(deps: { graph: KnowledgeGraph }): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  });

  // ── POST / — multipart CSV upload ───────────────────────────────────────
  router.post(
    '/',
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
        res.status(status).json({ code: `dataset.${code.toLowerCase()}`, message });
      });
    },
    async (req: Request, res: Response) => {
      const sessionUserId = requireSessionUserId(req, res);
      if (!sessionUserId) return;
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res
          .status(400)
          .json({ code: 'dataset.no_file', message: "multipart field 'file' fehlt." });
        return;
      }
      if (!isCsvAttachment(file.mimetype, file.originalname)) {
        res.status(422).json({
          code: 'dataset.unsupported_type',
          message: 'Nur CSV-Dateien werden aktuell unterstützt (v1 scope, siehe #430).',
        });
        return;
      }
      const nameField = req.body?.['name'];
      const datasetName =
        typeof nameField === 'string' && nameField.trim().length > 0
          ? nameField.trim()
          : file.originalname;

      try {
        const imported = await importCsvDataset({
          graph: deps.graph,
          bytes: file.buffer,
          datasetName,
          sourceFileName: file.originalname,
          ownerOmadiaUserId: sessionUserId,
        });
        if (!imported.ok) {
          res.status(422).json({ code: 'dataset.import_failed', message: imported.reason });
          return;
        }
        res.status(201).json({
          dataset: imported.result,
          privacyScan: imported.privacyScan,
          // #430 fixup — cells over MAX_CELL_CHARS are still cut (protects the
          // scan + storage from one pathological cell), but the cut is no
          // longer silent: callers can see it happened and which columns.
          truncation: imported.truncation,
        });
      } catch (err) {
        // #430 fixup — an unexpected THROWN error (e.g. a transient Postgres
        // failure inside NeonKnowledgeGraph.ingestDataset) must still return
        // the same {code, message} JSON envelope as the other four dataset
        // handlers below, not Express's default HTML error page. The
        // structured `{ok: false, reason}` not-ok case above is unaffected —
        // this only guards against a thrown exception.
        const { status, code, message } = mapErrorToHttp(err);
        res.status(status).json({ code, message });
      }
    },
  );

  // ── GET / — list current user's datasets ────────────────────────────────
  router.get('/', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    try {
      const items = await deps.graph.listDatasets({ ownerOmadiaUserId: sessionUserId });
      res.json({ items });
    } catch (err) {
      const { status, code, message } = mapErrorToHttp(err);
      res.status(status).json({ code, message });
    }
  });

  // ── GET /:id — one dataset's schema ──────────────────────────────────────
  router.get('/:id', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    try {
      const dataset = await deps.graph.getDataset(String(req.params['id'] ?? ''), sessionUserId);
      if (!dataset) {
        res.status(404).json({ code: 'dataset.not_found' });
        return;
      }
      res.json(dataset);
    } catch (err) {
      const { status, code, message } = mapErrorToHttp(err);
      res.status(status).json({ code, message });
    }
  });

  // ── GET /:id/rows — paginated row preview (admin UI table) ─────────────
  router.get('/:id/rows', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = RowsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'dataset.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await deps.graph.queryDatasetRows(
        String(req.params['id'] ?? ''),
        sessionUserId,
        {
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
          ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
        },
      );
      if (!result) {
        res.status(404).json({ code: 'dataset.not_found' });
        return;
      }
      res.json(result);
    } catch (err) {
      const { status, code, message } = mapErrorToHttp(err);
      res.status(status).json({ code, message });
    }
  });

  // ── DELETE /:id — hard delete ────────────────────────────────────────────
  router.delete('/:id', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    try {
      const deleted = await deps.graph.deleteDataset(String(req.params['id'] ?? ''), {
        actorOmadiaUserId: sessionUserId,
      });
      if (!deleted) {
        res.status(404).json({ code: 'dataset.not_found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      const { status, code, message } = mapErrorToHttp(err);
      res.status(status).json({ code, message });
    }
  });

  return router;
}
