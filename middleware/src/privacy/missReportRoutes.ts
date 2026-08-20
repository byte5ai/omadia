/**
 * #760 — privacy miss-report review queue (the catch basin for prompt-masking
 * non-detection). Mounted behind `requireAuth` at
 * `/api/v1/operator/privacy/miss-reports` by the caller (`index.ts`).
 *
 * POST /            — file a report ("this should have been masked")
 * GET  /?status=    — list reports, newest first (default: open)
 * POST /:id/resolve — mark a report handled (after the reviewer added the
 *                     term to the privacy plugin's custom_terms, or decided
 *                     no rule is needed)
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

const createSchema = z.object({
  term: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  turnId: z.string().max(512).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface MissReportRow {
  id: string;
  reporter: string;
  term: string;
  description: string | null;
  turn_id: string | null;
  status: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

function toApiShape(row: MissReportRow): Record<string, unknown> {
  return {
    id: row.id,
    reporter: row.reporter,
    term: row.term,
    description: row.description ?? undefined,
    turnId: row.turn_id ?? undefined,
    status: row.status,
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: row.resolved_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

const COLS = `id, reporter, term, description, turn_id, status, resolved_by, resolved_at, created_at`;

export function createMissReportRoutes(pool: Pool): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input', detail: parsed.error.issues });
      return;
    }
    const reporter = req.session?.sub ?? 'operator';
    try {
      const result = await pool.query<MissReportRow>(
        `INSERT INTO privacy_miss_reports (reporter, term, description, turn_id)
         VALUES ($1, $2, $3, $4)
         RETURNING ${COLS}`,
        [reporter, parsed.data.term, parsed.data.description ?? null, parsed.data.turnId ?? null],
      );
      res.status(201).json(toApiShape(result.rows[0]!));
    } catch (err) {
      console.error('[privacy] miss-report create failed:', err);
      res.status(500).json({ error: 'miss_report_create_failed' });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', detail: parsed.error.issues });
      return;
    }
    const { status, limit } = parsed.data;
    try {
      const result =
        status === 'all'
          ? await pool.query<MissReportRow>(
              `SELECT ${COLS} FROM privacy_miss_reports ORDER BY created_at DESC LIMIT $1`,
              [limit],
            )
          : await pool.query<MissReportRow>(
              `SELECT ${COLS} FROM privacy_miss_reports WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
              [status, limit],
            );
      res.json({ items: result.rows.map(toApiShape) });
    } catch (err) {
      console.error('[privacy] miss-report list failed:', err);
      res.status(500).json({ error: 'miss_report_query_failed' });
    }
  });

  router.post('/:id/resolve', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const resolver = req.session?.sub ?? 'operator';
    try {
      const result = await pool.query<MissReportRow>(
        `UPDATE privacy_miss_reports
            SET status = 'resolved', resolved_by = $2, resolved_at = NOW()
          WHERE id = $1 AND status = 'open'
          RETURNING ${COLS}`,
        [id, resolver],
      );
      const row = result.rows[0];
      if (!row) {
        res.status(409).json({ error: 'miss_report_not_open' });
        return;
      }
      res.json(toApiShape(row));
    } catch (err) {
      console.error('[privacy] miss-report resolve failed:', err);
      res.status(500).json({ error: 'miss_report_resolve_failed' });
    }
  });

  return router;
}
