/**
 * #761 — operator verification surface over the receipt chain (#758).
 * Mounted behind `requireAuth` at `/api/v1/operator/provenance` by the
 * caller (`index.ts`).
 *
 * GET /verify — walk + verify the stored chain, checkpoints, and the
 *   retention prefix (incl. the #758 M2 premature-deletion check).
 * GET /export — signed JSONL export: header line (format, stream, public
 *   key + fingerprint), then every chain row, then every checkpoint. The
 *   companion zero-dependency offline verifier
 *   (`scripts/verify-audit-export.mjs`) validates the export WITHOUT
 *   trusting this server or its database — that independence is the whole
 *   point of the export.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';

import { RECEIPT_STREAM_ID } from './chain.js';
import { verifyReceiptStream } from './verify.js';

export const EXPORT_FORMAT = 'omadia-audit-export-v1';

interface ExportChainRow {
  turn_id: string;
  session_scope: string | null;
  channel: string | null;
  model: string | null;
  receipt: unknown;
  seq: string;
  prev_hash: Buffer;
  entry_hash: Buffer;
  hash_version: number;
  created_at: Date;
}

interface ExportCheckpointRow {
  seq: string;
  head_hash: Buffer;
  signed_at: Date;
  signature: Buffer;
  public_key_fingerprint: string;
}

export function createProvenanceRoutes(
  pool: Pool,
  deps: {
    publicKeyPem?: string;
    publicKeyFingerprint?: string;
    retentionDays: number;
  },
): Router {
  const router = Router();

  router.get('/verify', async (_req: Request, res: Response) => {
    try {
      const result = await verifyReceiptStream(pool, {
        ...(deps.publicKeyPem ? { publicKeyPem: deps.publicKeyPem } : {}),
        retentionDays: deps.retentionDays,
      });
      res.json(result);
    } catch (err) {
      console.error('[provenance] verify failed:', err);
      res.status(500).json({ error: 'provenance_verify_failed' });
    }
  });

  router.get('/export', async (_req: Request, res: Response) => {
    try {
      const rows = await pool.query<ExportChainRow>(
        `SELECT turn_id, session_scope, channel, model, receipt,
                seq::text AS seq, prev_hash, entry_hash, hash_version, created_at
           FROM turn_receipts
          WHERE stream_id = $1
          ORDER BY seq ASC`,
        [RECEIPT_STREAM_ID],
      );
      const cps = await pool.query<ExportCheckpointRow>(
        `SELECT seq::text AS seq, head_hash, signed_at, signature, public_key_fingerprint
           FROM audit_checkpoints
          WHERE stream_id = $1
          ORDER BY seq ASC`,
        [RECEIPT_STREAM_ID],
      );
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader(
        'content-disposition',
        `attachment; filename="omadia-audit-export-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      );
      const write = (obj: unknown): void => {
        res.write(`${JSON.stringify(obj)}\n`);
      };
      const preChain = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM turn_receipts WHERE stream_id IS NULL`,
      );
      write({
        kind: 'header',
        format: EXPORT_FORMAT,
        streamId: RECEIPT_STREAM_ID,
        exportedAt: new Date().toISOString(),
        // Pre-chain era rows are not exportable as chain entries; the count
        // makes their existence visible to the offline auditor.
        preChainRows: Number(preChain.rows[0]?.n ?? 0),
        // Included for convenience; an independent verifier should pin the
        // key it received OUT-OF-BAND and pass it to the offline tool —
        // a key taken from the export only proves internal consistency.
        ...(deps.publicKeyPem ? { publicKeyPem: deps.publicKeyPem } : {}),
        ...(deps.publicKeyFingerprint ? { publicKeyFingerprint: deps.publicKeyFingerprint } : {}),
      });
      for (const r of rows.rows) {
        write({
          kind: 'entry',
          seq: Number(r.seq),
          prevHashHex: r.prev_hash.toString('hex'),
          entryHashHex: r.entry_hash.toString('hex'),
          hashVersion: r.hash_version,
          createdAt: r.created_at.toISOString(),
          payload: {
            turnId: r.turn_id,
            sessionScope: r.session_scope,
            channel: r.channel,
            model: r.model,
            receipt: r.receipt,
          },
        });
      }
      for (const c of cps.rows) {
        write({
          kind: 'checkpoint',
          seq: Number(c.seq),
          headHashHex: c.head_hash.toString('hex'),
          signedAtIso: c.signed_at.toISOString(),
          signatureBase64: c.signature.toString('base64'),
          publicKeyFingerprint: c.public_key_fingerprint,
        });
      }
      // Trailer (review M5): a file truncated at any line boundary is missing
      // this record — the offline verifier refuses to report green without it
      // or when the counts disagree.
      write({ kind: 'trailer', entries: rows.rows.length, checkpoints: cps.rows.length });
      res.end();
    } catch (err) {
      console.error('[provenance] export failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'provenance_export_failed' });
      else res.end();
    }
  });

  return router;
}
