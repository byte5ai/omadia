/**
 * #757 — operator read API for persisted per-turn receipts.
 *
 * Mounted under `/api/v1/operator/receipts` behind `requireAuth` (same
 * posture as the Conductor's operator API — mounting happens at the caller,
 * `middleware/src/index.ts`, which owns the auth middleware).
 *
 * Read-only by design: rows are written solely by the orchestrator's turn
 * path. Query params are validated at the boundary; the receipt payload is
 * PII-free by construction, so no masking is owed on this surface.
 *
 * Pagination is a composite keyset cursor `(created_at, id)`. A bare
 * `created_at` cursor would lose rows on this surface twice over: exact-tie
 * rows cut off by LIMIT would be skipped for good, and node-postgres
 * truncates pg's microseconds to JS milliseconds, so a `< cursor` filter on
 * a round-tripped ISO string swallows the sub-millisecond remainder. The
 * cursor therefore carries pg's own text form of the timestamp (full
 * microseconds, cast back with `::timestamptz`) plus the row id as the
 * tiebreaker — "no receipt silently disappears" is this feature's promise,
 * and paging is not allowed to break it.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

const LIST_MAX_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque list cursor: `<pg timestamptz text>|<row uuid>`. */
function parseCursor(raw: string): { ts: string; id: string } | undefined {
  const sep = raw.lastIndexOf('|');
  if (sep <= 0) return undefined;
  const ts = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!UUID_RE.test(id)) return undefined;
  if (ts.length === 0 || ts.length > 64 || Number.isNaN(Date.parse(ts))) {
    return undefined;
  }
  return { ts, id };
}

const listQuerySchema = z.object({
  scope: z.string().min(1).max(512).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(25),
  cursor: z
    .string()
    .max(128)
    .transform((raw, ctx) => {
      const parsed = parseCursor(raw);
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: 'malformed cursor' });
        return z.NEVER;
      }
      return parsed;
    })
    .optional(),
});

interface TurnReceiptRow {
  id: string;
  turn_id: string;
  session_scope: string | null;
  channel: string | null;
  model: string | null;
  /** #1033 W0 — attribution columns (migration 0057); NULL on older rows. */
  provider: string | null;
  fallback_used: boolean | null;
  receipt: unknown;
  created_at: Date;
  /** pg's own text rendering of created_at — microsecond-exact, used only
   *  to build the outgoing cursor. */
  created_at_cursor: string;
}

function toApiShape(row: TurnReceiptRow): Record<string, unknown> {
  return {
    turnId: row.turn_id,
    sessionScope: row.session_scope ?? undefined,
    channel: row.channel ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    // Only ever `true` on the wire: a row that predates the column is
    // indistinguishable from "primary answered", and the UI must not render
    // a "no fallback" badge it cannot vouch for.
    ...(row.fallback_used === true ? { fallbackUsed: true } : {}),
    receipt: row.receipt,
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT_COLUMNS = `id, turn_id, session_scope, channel, model, provider,
       fallback_used, receipt,
       created_at, created_at::text AS created_at_cursor`;

export function createReceiptRoutes(pool: Pool): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', detail: parsed.error.issues });
      return;
    }
    const { scope, from, to, limit, cursor } = parsed.data;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (scope) add('session_scope = ?', scope);
    if (from) add('created_at >= ?', from);
    if (to) add('created_at <= ?', to);
    if (cursor) {
      // Composite keyset: strictly after the boundary row in (created_at
      // DESC, id DESC) order — ascending row comparison inverts to `<`.
      params.push(cursor.ts, cursor.id);
      where.push(
        `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit);
    const sql = `SELECT ${SELECT_COLUMNS}
                   FROM turn_receipts
                  ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY created_at DESC, id DESC
                  LIMIT $${params.length}`;
    try {
      const result = await pool.query<TurnReceiptRow>(sql, params);
      const items = result.rows.map(toApiShape);
      // Next-page cursor only when the page was full — a short page is the end.
      const lastRow = result.rows[result.rows.length - 1];
      const nextCursor =
        result.rows.length === limit && lastRow
          ? `${lastRow.created_at_cursor}|${lastRow.id}`
          : undefined;
      res.json({ items, ...(nextCursor ? { nextCursor } : {}) });
    } catch (err) {
      console.error('[receipts] list query failed:', err);
      res.status(500).json({ error: 'receipts_query_failed' });
    }
  });

  router.get('/:turnId', async (req: Request, res: Response) => {
    const turnId = String(req.params.turnId ?? '');
    if (turnId.length === 0 || turnId.length > 512) {
      res.status(400).json({ error: 'invalid_turn_id' });
      return;
    }
    try {
      const result = await pool.query<TurnReceiptRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM turn_receipts WHERE turn_id = $1`,
        [turnId],
      );
      const row = result.rows[0];
      if (!row) {
        res.status(404).json({ error: 'receipt_not_found' });
        return;
      }
      res.json(toApiShape(row));
    } catch (err) {
      console.error('[receipts] get query failed:', err);
      res.status(500).json({ error: 'receipts_query_failed' });
    }
  });

  return router;
}
