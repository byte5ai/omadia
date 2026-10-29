/**
 * #761 — operator verification surface over the receipt chain (#758).
 * Mounted behind `requireAuth` at `/api/v1/operator/provenance` by the
 * caller (`index.ts`).
 *
 * GET /verify — walk + verify the stored chain, checkpoints, and the
 *   retention prefix (incl. the #758 M2 premature-deletion check), and
 *   compare the external anchor file against the DB (#1565).
 * GET /export — signed JSONL export: header line (format, stream, public
 *   key + fingerprint, recorded head, retention + checkpoint settings), then
 *   every chain row, then every checkpoint, then a trailer — all read in
 *   one snapshot so they agree with each other. The
 *   companion zero-dependency offline verifier
 *   (`scripts/verify-audit-export.mjs`) validates the export WITHOUT
 *   trusting this server or its database — that independence is the whole
 *   point of the export.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';

import { type ChainWitness, readAnchorFile } from './anchor.js';
import { RECEIPT_STREAM_ID } from './chain.js';
import {
  CHAIN_ROW_COLUMNS,
  chainRowBatches,
  verifyReceiptStream,
  withReadSnapshot,
} from './verify.js';

export const EXPORT_FORMAT = 'omadia-audit-export-v1';

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
    checkpointIntervalMinutes?: number;
    /** `AUDIT_ANCHOR_PATH` — read back and compared on every verify. */
    anchorPath?: string;
    witness?: ChainWitness;
  },
): Router {
  const router = Router();

  router.get('/verify', async (_req: Request, res: Response) => {
    try {
      // The anchor is read BEFORE the DB snapshot: a checkpoint signed in
      // between lands in the DB, never only in the anchor.
      const anchor = deps.anchorPath
        ? await readAnchorFile(deps.anchorPath, RECEIPT_STREAM_ID)
        : undefined;
      if (anchor?.status === 'unreadable') {
        console.error(`[provenance] anchor file unreadable: ${anchor.message}`);
      }
      const result = await verifyReceiptStream(pool, {
        ...(deps.publicKeyPem ? { publicKeyPem: deps.publicKeyPem } : {}),
        retentionDays: deps.retentionDays,
        ...(deps.checkpointIntervalMinutes
          ? { checkpointIntervalMinutes: deps.checkpointIntervalMinutes }
          : {}),
        ...(anchor ? { anchor } : {}),
        ...(deps.witness ? { witness: deps.witness } : {}),
      });
      res.json(result);
    } catch (err) {
      console.error('[provenance] verify failed:', err);
      res.status(500).json({ error: 'provenance_verify_failed' });
    }
  });

  router.get('/export', async (_req: Request, res: Response) => {
    // Taken before the snapshot: the offline verifier ignores anchor records
    // signed after this instant (they cannot be in the export).
    const exportedAt = new Date().toISOString();
    try {
      await withReadSnapshot(pool, async (db) => {
        const preChain = await db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM turn_receipts WHERE stream_id IS NULL`,
        );
        const head = await db.query<{ head_seq: string; head_hash: Buffer }>(
          `SELECT head_seq::text AS head_seq, head_hash FROM audit_stream_heads WHERE stream_id = $1`,
          [RECEIPT_STREAM_ID],
        );
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader(
          'content-disposition',
          `attachment; filename="omadia-audit-export-${exportedAt.slice(0, 10)}.jsonl"`,
        );
        const write = (obj: unknown): void => {
          res.write(`${JSON.stringify(obj)}\n`);
        };
        const headRow = head.rows[0];
        write({
          kind: 'header',
          format: EXPORT_FORMAT,
          streamId: RECEIPT_STREAM_ID,
          exportedAt,
          // Pre-chain era rows are not exportable as chain entries; the count
          // makes their existence visible to the offline auditor.
          preChainRows: Number(preChain.rows[0]?.n ?? 0),
          // The recorded head and the settings the server judges with, so the
          // offline tool can apply the same head, grace and premature-deletion
          // rules (reviewer M4).
          recordedHeadSeq: Number(headRow?.head_seq ?? 0),
          ...(headRow ? { recordedHeadHashHex: headRow.head_hash.toString('hex') } : {}),
          retentionDays: deps.retentionDays,
          checkpointIntervalMinutes: deps.checkpointIntervalMinutes ?? 60,
          // Included for convenience; an independent verifier should pin the
          // key it received OUT-OF-BAND and pass it to the offline tool —
          // a key taken from the export only proves internal consistency.
          ...(deps.publicKeyPem ? { publicKeyPem: deps.publicKeyPem } : {}),
          ...(deps.publicKeyFingerprint ? { publicKeyFingerprint: deps.publicKeyFingerprint } : {}),
        });
        let entries = 0;
        for await (const batch of chainRowBatches(db, CHAIN_ROW_COLUMNS)) {
          for (const r of batch) {
            entries += 1;
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
        }
        const cps = await db.query<ExportCheckpointRow>(
          `SELECT seq::text AS seq, head_hash, signed_at, signature, public_key_fingerprint
             FROM audit_checkpoints
            WHERE stream_id = $1
            ORDER BY audit_checkpoints.seq ASC`,
          [RECEIPT_STREAM_ID],
        );
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
        // Trailer (review M5): a file truncated at any line boundary is
        // missing this record — the offline verifier refuses to report green
        // without it or when the counts disagree.
        write({ kind: 'trailer', entries, checkpoints: cps.rows.length });
      });
      res.end();
    } catch (err) {
      console.error('[provenance] export failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'provenance_export_failed' });
      else res.end();
    }
  });

  return router;
}
