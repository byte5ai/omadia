/**
 * #761 — server-side verification of the receipt hash chain (#758).
 *
 * Walks the stored rows, recomputes every entry hash from the canonical
 * payload (the exact `receiptChainPayload` shape the store hashed), checks
 * link continuity, validates every checkpoint against both the signature
 * and the row it claims to certify, and consults the stream head so tail
 * truncation and a wiped table cannot report green.
 *
 * Anchoring semantics (review #761/H2): a retention-reaped prefix is
 * ANCHORED when any signature-valid checkpoint inside the surviving range
 * certifies its row — the prev_hash of the first survivor is an input to
 * that row's hash, which is transitively covered by the checkpoint, so the
 * suffix as a whole is vouched for. No exact boundary alignment required.
 *
 * Premature-deletion rule (review #761/M4, replacing the unsound #758-M2
 * draft): a signature-valid checkpoint at seq S signed at time T proves
 * every row with seq > S was created AFTER T. If the youngest reaped row
 * (seq = firstSurvivor-1) sits above such a checkpoint whose T is younger
 * than the retention window, that row was provably younger than retention
 * when deleted — a laundering finding, not retention. Only ever inferred
 * from signature-checked checkpoints.
 *
 * What a green verdict proves / does not prove: see
 * `docs/provenance-verification.md`.
 */

import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { Pool } from 'pg';

import {
  HASH_VERSION,
  RECEIPT_STREAM_ID,
  computeEntryHash,
  genesisHash,
} from './chain.js';
import { receiptChainPayload } from './store.js';
import { checkpointSigningInput } from './checkpoints.js';

const MAX_VERIFY_ENTRIES = 50_000;

export interface CheckpointFinding {
  readonly seq: number;
  readonly kind: 'orphaned' | 'bad_signature' | 'hash_mismatch_vs_row';
}

export type ChainBreakKind =
  | 'hash_mismatch'
  | 'link_mismatch'
  | 'seq_gap'
  | 'unsupported_hash_version'
  | 'head_beyond_rows'
  | 'empty_chain_with_history';

export interface VerifyReceiptStreamResult {
  readonly ok: boolean;
  readonly checkedEntries: number;
  readonly headSeq?: number;
  readonly headHashHex?: string;
  /** Recorded stream-head seq from audit_stream_heads (0 = none). */
  readonly recordedHeadSeq: number;
  /** True when the row fetch hit MAX_VERIFY_ENTRIES — verification covered a
   *  prefix only; checkpoints beyond the window were not judged. */
  readonly truncated: boolean;
  /** Rows written before chaining existed (NULL chain columns) — reported,
   *  never counted as verified or broken. */
  readonly preChainRows: number;
  readonly firstBrokenSeq?: number;
  readonly breakKind?: ChainBreakKind;
  readonly checkpoints: {
    readonly total: number;
    readonly verified: number;
    readonly findings: readonly CheckpointFinding[];
    /** No public key available ⇒ signatures could not be checked. */
    readonly signaturesChecked: boolean;
  };
  readonly prefix: {
    /** Highest seq removed by retention (0 = nothing reaped). */
    readonly reapedUpToSeq: number;
    /** A signature-valid checkpoint inside the surviving range certifies the
     *  suffix (transitively covering the first survivor's prev link). */
    readonly anchored: boolean;
    /** Sound youngest-reaped-row proof (see module doc). Only inferred when
     *  signatures were checked. */
    readonly prematureDeletion?: {
      readonly provenCreatedAfterIso: string;
      readonly retentionDays: number;
    };
  };
}

interface ChainDbRow {
  turn_id: string;
  session_scope: string | null;
  channel: string | null;
  model: string | null;
  receipt: unknown;
  seq: string;
  prev_hash: Buffer;
  entry_hash: Buffer;
  hash_version: number;
}

interface CheckpointDbRow {
  seq: string;
  head_hash: Buffer;
  signed_at: Date;
  signature: Buffer;
}

export async function verifyReceiptStream(
  pool: Pool,
  opts: {
    /** SPKI PEM of the checkpoint public key; absent ⇒ signatures unchecked. */
    publicKeyPem?: string;
    retentionDays: number;
    now?: () => Date;
  },
): Promise<VerifyReceiptStreamResult> {
  const preChain = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM turn_receipts WHERE stream_id IS NULL`,
  );
  const preChainRows = Number(preChain.rows[0]?.n ?? 0);

  const headRes = await pool.query<{ head_seq: string }>(
    `SELECT head_seq::text AS head_seq FROM audit_stream_heads WHERE stream_id = $1`,
    [RECEIPT_STREAM_ID],
  );
  const recordedHeadSeq = Number(headRes.rows[0]?.head_seq ?? 0);

  const rowsRes = await pool.query<ChainDbRow>(
    `SELECT turn_id, session_scope, channel, model, receipt,
            seq::text AS seq, prev_hash, entry_hash, hash_version
       FROM turn_receipts
      WHERE stream_id = $1
      ORDER BY seq ASC
      LIMIT $2`,
    [RECEIPT_STREAM_ID, MAX_VERIFY_ENTRIES],
  );
  const cpRes = await pool.query<CheckpointDbRow>(
    `SELECT seq::text AS seq, head_hash, signed_at, signature
       FROM audit_checkpoints
      WHERE stream_id = $1
      ORDER BY seq ASC`,
    [RECEIPT_STREAM_ID],
  );

  const rows = rowsRes.rows;
  const checkpoints = cpRes.rows;
  const truncated = rows.length === MAX_VERIFY_ENTRIES;
  const publicKey = opts.publicKeyPem ? createPublicKey(opts.publicKeyPem) : undefined;
  const firstSeq = rows.length > 0 ? Number(rows[0]!.seq) : undefined;
  const lastLoadedSeq = rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : undefined;

  // ── checkpoint validation ─────────────────────────────────────────────────
  const rowBySeq = new Map<number, ChainDbRow>();
  for (const r of rows) rowBySeq.set(Number(r.seq), r);
  const cpFindings: CheckpointFinding[] = [];
  /** Signature-valid checkpoints whose certified row matched — the anchors. */
  const validCertifyingSeqs = new Set<number>();
  /** Signature-valid checkpoints (row match not required) by seq → signed_at. */
  const validSignedAt = new Map<number, Date>();
  let cpVerified = 0;
  for (const cp of checkpoints) {
    const seq = Number(cp.seq);
    if (publicKey) {
      const sigOk = edVerify(
        null,
        checkpointSigningInput({
          streamId: RECEIPT_STREAM_ID,
          seq,
          headHash: cp.head_hash,
          signedAtIso: cp.signed_at.toISOString(),
        }),
        publicKey,
        cp.signature,
      );
      if (!sigOk) {
        cpFindings.push({ seq, kind: 'bad_signature' });
        continue;
      }
      validSignedAt.set(seq, cp.signed_at);
    }
    const row = rowBySeq.get(seq);
    if (row) {
      if (!row.entry_hash.equals(cp.head_hash)) {
        cpFindings.push({ seq, kind: 'hash_mismatch_vs_row' });
        continue;
      }
      if (publicKey) validCertifyingSeqs.add(seq);
    } else if (
      firstSeq !== undefined &&
      lastLoadedSeq !== undefined &&
      seq >= firstSeq &&
      seq <= lastLoadedSeq
    ) {
      // Inside the LOADED range with no row: certified evidence of deletion.
      // Checkpoints beyond a truncated window are deliberately not judged
      // (review H3) — `truncated` says so.
      cpFindings.push({ seq, kind: 'orphaned' });
      continue;
    } else if (firstSeq === undefined && recordedHeadSeq > 0) {
      // Zero surviving rows while checkpoints exist: certified history with
      // nothing left to verify — surfaced via empty_chain_with_history below.
    }
    cpVerified += 1;
  }

  // ── prefix (retention) analysis ───────────────────────────────────────────
  const reapedUpToSeq = firstSeq !== undefined ? firstSeq - 1 : recordedHeadSeq;
  // Anchored: any signature-valid, row-matching checkpoint in the surviving
  // range transitively covers the whole suffix incl. the first survivor's
  // prev link (its prev_hash is an input to a certified hash).
  const anchored =
    reapedUpToSeq === 0 ||
    (firstSeq !== undefined && [...validCertifyingSeqs].some((s) => s >= firstSeq));
  let prematureDeletion: VerifyReceiptStreamResult['prefix']['prematureDeletion'];
  if (firstSeq !== undefined && reapedUpToSeq > 0 && publicKey) {
    // Sound direction: the highest valid checkpoint BELOW the youngest
    // reaped row proves that row was created AFTER its signing time.
    const below = [...validSignedAt.entries()]
      .filter(([seq]) => seq < reapedUpToSeq)
      .sort((a, b) => b[0] - a[0])[0];
    if (below) {
      const provenCreatedAfter = below[1];
      const ageMs = (opts.now?.() ?? new Date()).getTime() - provenCreatedAfter.getTime();
      if (ageMs < opts.retentionDays * 24 * 60 * 60 * 1000) {
        prematureDeletion = {
          provenCreatedAfterIso: provenCreatedAfter.toISOString(),
          retentionDays: opts.retentionDays,
        };
      }
    }
  }

  // ── chain walk ────────────────────────────────────────────────────────────
  let breakInfo: { firstBrokenSeq: number; breakKind: ChainBreakKind } | undefined;
  let checkedEntries = 0;
  if (rows.length > 0) {
    let prev = firstSeq === 1 ? genesisHash(RECEIPT_STREAM_ID) : rows[0]!.prev_hash;
    let expected = firstSeq!;
    for (const row of rows) {
      const seq = Number(row.seq);
      if (row.hash_version !== HASH_VERSION) {
        breakInfo = { firstBrokenSeq: seq, breakKind: 'unsupported_hash_version' };
        break;
      }
      if (seq !== expected) {
        breakInfo = { firstBrokenSeq: seq, breakKind: 'seq_gap' };
        break;
      }
      if (!row.prev_hash.equals(prev)) {
        breakInfo = { firstBrokenSeq: seq, breakKind: 'link_mismatch' };
        break;
      }
      const recomputed = computeEntryHash({
        streamId: RECEIPT_STREAM_ID,
        seq,
        prevHash: row.prev_hash,
        payload: receiptChainPayload({
          turnId: row.turn_id,
          sessionScope: row.session_scope ?? undefined,
          channel: row.channel ?? undefined,
          model: row.model ?? undefined,
          receipt: row.receipt as never,
        }),
      });
      if (!recomputed.equals(row.entry_hash)) {
        breakInfo = { firstBrokenSeq: seq, breakKind: 'hash_mismatch' };
        break;
      }
      prev = row.entry_hash;
      expected = seq + 1;
      checkedEntries += 1;
    }
  }

  // Head consistency (review H1): a recorded head beyond the last stored row
  // means tail truncation — unless the fetch itself was truncated, in which
  // case the judgement is out of window.
  if (!breakInfo && !truncated && lastLoadedSeq !== undefined && recordedHeadSeq > lastLoadedSeq) {
    breakInfo = { firstBrokenSeq: lastLoadedSeq + 1, breakKind: 'head_beyond_rows' };
  }
  // Empty table while head/checkpoints claim history: nothing verifiable —
  // never green (mirrors the offline tool's zero-entry refusal). A total
  // legitimate reap lands here too and must be read consciously.
  if (!breakInfo && rows.length === 0 && (recordedHeadSeq > 0 || checkpoints.length > 0)) {
    breakInfo = { firstBrokenSeq: 1, breakKind: 'empty_chain_with_history' };
  }

  const last = rows[rows.length - 1];
  const ok =
    breakInfo === undefined &&
    cpFindings.length === 0 &&
    anchored &&
    prematureDeletion === undefined &&
    (rows.length > 0 || (recordedHeadSeq === 0 && checkpoints.length === 0));
  return {
    ok,
    checkedEntries,
    ...(last ? { headSeq: Number(last.seq), headHashHex: last.entry_hash.toString('hex') } : {}),
    recordedHeadSeq,
    truncated,
    preChainRows,
    ...(breakInfo ?? {}),
    checkpoints: {
      total: checkpoints.length,
      verified: cpVerified,
      findings: cpFindings,
      signaturesChecked: Boolean(publicKey),
    },
    prefix: {
      reapedUpToSeq,
      anchored,
      ...(prematureDeletion ? { prematureDeletion } : {}),
    },
  };
}
