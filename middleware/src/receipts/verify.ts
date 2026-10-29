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
 * Verdict (#1568 / #1584): `verified` needs a public key and at least one
 * signature-valid checkpoint certifying a surviving row; without a key the
 * best possible verdict is `unsigned` — the chain is internally consistent
 * but nothing vouches for it, and a retention-reaped prefix is reported as
 * unanchored information, not as a break. `checkpoints.verified` only ever
 * counts signature-checked checkpoints.
 *
 * Truncation / rollback (#1565 / #1566): a checkpoint above the last stored
 * row is orphaned whenever the row fetch was complete; with a key configured
 * a chain no signed checkpoint certifies is never `verified`; the external
 * anchor file (`AUDIT_ANCHOR_PATH`) is compared against `audit_checkpoints`;
 * and a recorded head below this process's high-water mark is a rollback.
 *
 * The offline verifier (`scripts/verify-audit-export.mjs`) applies the same
 * rules to an export; the process high-water mark is the only server-only
 * signal.
 *
 * What a green verdict proves / does not prove: see
 * `docs/provenance-verification.md`.
 */

import { createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import type { Pool } from 'pg';

import { type AnchorReadResult, type HeadHighWater } from './anchor.js';
import { HASH_VERSION, RECEIPT_STREAM_ID, computeEntryHash, genesisHash } from './chain.js';
import { receiptChainPayload } from './store.js';
import { checkpointSigningInput } from './checkpoints.js';

const MAX_VERIFY_ENTRIES = 50_000;

export interface CheckpointFinding {
  readonly seq: number;
  /** `no_signed_checkpoint` (#1565): a signing key is configured but no
   *  signature-valid checkpoint certifies any surviving row — `seq` is the
   *  recorded head. */
  readonly kind: 'orphaned' | 'bad_signature' | 'hash_mismatch_vs_row' | 'no_signed_checkpoint';
}

export interface AnchorFinding {
  readonly seq: number;
  /**
   * missing_in_db — the anchor holds a checkpoint `audit_checkpoints` lost.
   * mismatch      — the DB checkpoint at that seq certifies another hash.
   * beyond_head   — the anchor certifies a seq above the recorded head.
   * bad_signature — the anchor line does not verify with the public key.
   * malformed     — the line is not an anchor record (`seq` = line number).
   */
  readonly kind: 'missing_in_db' | 'mismatch' | 'beyond_head' | 'bad_signature' | 'malformed';
}

export type ProvenanceVerdict = 'verified' | 'unsigned' | 'broken';

export type ChainBreakKind =
  | 'hash_mismatch'
  | 'link_mismatch'
  | 'seq_gap'
  | 'unsupported_hash_version'
  | 'head_beyond_rows'
  | 'head_rollback'
  | 'empty_chain_with_history';

export interface VerifyReceiptStreamResult {
  /** False only for `verdict: 'broken'`. An `unsigned` chain is ok — and
   *  still never `verified`. */
  readonly ok: boolean;
  readonly verdict: ProvenanceVerdict;
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
    /** Signature checked AND valid (#1584) — always 0 without a key. */
    readonly verified: number;
    /** Present but signature not checked (no public key). */
    readonly unchecked: number;
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
    /** Set when a reaped prefix is unanchored but that is expected: no
     *  public key, so no checkpoint could vouch for it (#1568). Reported,
     *  not a break. */
    readonly unanchoredReason?: 'no_signing_key';
    /** Sound youngest-reaped-row proof (see module doc). Only inferred when
     *  signatures were checked. */
    readonly prematureDeletion?: {
      readonly provenCreatedAfterIso: string;
      readonly retentionDays: number;
    };
  };
  /** External anchor comparison (#1565). */
  readonly anchor: {
    readonly configured: boolean;
    readonly status?: AnchorReadResult['status'];
    /** Anchor records of this stream. */
    readonly records: number;
    /** Records whose checkpoint the DB still holds unchanged. */
    readonly matched: number;
    readonly findings: readonly AnchorFinding[];
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
    /** `AUDIT_ANCHOR_PATH` is set — the caller passes what it read (#1565). */
    anchor?: AnchorReadResult;
    /** Highest head this process has seen (#1566 rollback evidence). */
    highWater?: HeadHighWater;
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

  // #1526 — ORDER BY must name the table: a bare `seq` binds to the
  // `seq::text` output alias, which sorts 1, 10, 11, …, 2 and turns every
  // chain of ten or more rows into a false seq_gap at seq 10.
  const rowsRes = await pool.query<ChainDbRow>(
    `SELECT turn_id, session_scope, channel, model, receipt,
            seq::text AS seq, prev_hash, entry_hash, hash_version
       FROM turn_receipts
      WHERE stream_id = $1
      ORDER BY turn_receipts.seq ASC
      LIMIT $2`,
    [RECEIPT_STREAM_ID, MAX_VERIFY_ENTRIES],
  );
  const cpRes = await pool.query<CheckpointDbRow>(
    `SELECT seq::text AS seq, head_hash, signed_at, signature
       FROM audit_checkpoints
      WHERE stream_id = $1
      ORDER BY audit_checkpoints.seq ASC`,
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
  for (const cp of checkpoints) {
    const seq = Number(cp.seq);
    if (publicKey) {
      const sigOk = verifySignature(
        publicKey,
        seq,
        cp.head_hash,
        cp.signed_at.toISOString(),
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
    } else if (firstSeq !== undefined && seq >= firstSeq && (!truncated || seq <= lastLoadedSeq!)) {
      // At or above the first surviving row with no row: certified evidence
      // of deletion — inside the range, or ABOVE the last row when the fetch
      // was complete (#1566: newest rows deleted + head rolled back). Only a
      // truncated fetch window leaves checkpoints beyond it unjudged
      // (review H3) — `truncated` says so.
      cpFindings.push({ seq, kind: 'orphaned' });
    }
    // Below the first survivor: the row was reaped by retention — the
    // signature (when checked) is all there is to judge. Zero rows at all is
    // surfaced via empty_chain_with_history below.
  }
  if (publicKey && rows.length > 0 && validCertifyingSeqs.size === 0) {
    // #1565 — signing is on, yet nothing certifies the stored chain: the
    // worker signs every interval (and eagerly at boot), so this is what
    // deleting `audit_checkpoints` looks like. Never `verified`.
    cpFindings.push({ seq: recordedHeadSeq, kind: 'no_signed_checkpoint' });
  }

  // ── prefix (retention) analysis ───────────────────────────────────────────
  const reapedUpToSeq = firstSeq !== undefined ? firstSeq - 1 : recordedHeadSeq;
  // Anchored: any signature-valid, row-matching checkpoint in the surviving
  // range transitively covers the whole suffix incl. the first survivor's
  // prev link (its prev_hash is an input to a certified hash).
  const anchored =
    reapedUpToSeq === 0 ||
    (firstSeq !== undefined && [...validCertifyingSeqs].some((s) => s >= firstSeq));
  // #1568 — without a key nothing can anchor anything; the reaper's age-only
  // rule is the documented keyless behaviour, so an unanchored prefix is
  // information there, not a break.
  const unanchoredReason = !anchored && !publicKey ? ('no_signing_key' as const) : undefined;
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
  let breakInfo = walkChain(rows);
  const checkedEntries = breakInfo?.checkedEntries ?? rows.length;

  // Head consistency (review H1): a recorded head beyond the last stored row
  // means tail truncation — unless the fetch itself was truncated, in which
  // case the judgement is out of window.
  if (!breakInfo && !truncated && lastLoadedSeq !== undefined && recordedHeadSeq > lastLoadedSeq) {
    breakInfo = {
      checkedEntries,
      firstBrokenSeq: lastLoadedSeq + 1,
      breakKind: 'head_beyond_rows',
    };
  }
  // #1566 — heads only move forward. A recorded head below what this
  // process already saw was rolled back, even if rows and head agree now.
  const highWater = opts.highWater?.value ?? 0;
  if (!breakInfo && recordedHeadSeq < highWater) {
    breakInfo = { checkedEntries, firstBrokenSeq: recordedHeadSeq + 1, breakKind: 'head_rollback' };
  }
  opts.highWater?.note(recordedHeadSeq);
  // Empty table while head/checkpoints claim history: nothing verifiable —
  // never green (mirrors the offline tool's zero-entry refusal). A total
  // legitimate reap lands here too and must be read consciously.
  if (!breakInfo && rows.length === 0 && (recordedHeadSeq > 0 || checkpoints.length > 0)) {
    breakInfo = { checkedEntries, firstBrokenSeq: 1, breakKind: 'empty_chain_with_history' };
  }

  const anchor = compareAnchor(opts.anchor, checkpoints, recordedHeadSeq, publicKey);

  const broken =
    breakInfo !== undefined ||
    cpFindings.length > 0 ||
    anchor.findings.length > 0 ||
    (!anchored && unanchoredReason === undefined) ||
    prematureDeletion !== undefined;
  const verdict: ProvenanceVerdict = broken
    ? 'broken'
    : publicKey && validCertifyingSeqs.size > 0
      ? 'verified'
      : 'unsigned';
  const last = rows[rows.length - 1];
  return {
    ok: verdict !== 'broken',
    verdict,
    checkedEntries,
    ...(last ? { headSeq: Number(last.seq), headHashHex: last.entry_hash.toString('hex') } : {}),
    recordedHeadSeq,
    truncated,
    preChainRows,
    ...(breakInfo
      ? { firstBrokenSeq: breakInfo.firstBrokenSeq, breakKind: breakInfo.breakKind }
      : {}),
    checkpoints: {
      total: checkpoints.length,
      // #1584 — only signature-checked checkpoints without a finding.
      verified: [...validSignedAt.keys()].filter((seq) => !cpFindings.some((f) => f.seq === seq))
        .length,
      unchecked: publicKey ? 0 : checkpoints.length,
      findings: cpFindings,
      signaturesChecked: Boolean(publicKey),
    },
    prefix: {
      reapedUpToSeq,
      anchored,
      ...(unanchoredReason ? { unanchoredReason } : {}),
      ...(prematureDeletion ? { prematureDeletion } : {}),
    },
    anchor,
  };
}

function verifySignature(
  publicKey: KeyObject,
  seq: number,
  headHash: Buffer,
  signedAtIso: string,
  signature: Buffer,
): boolean {
  try {
    return edVerify(
      null,
      checkpointSigningInput({ streamId: RECEIPT_STREAM_ID, seq, headHash, signedAtIso }),
      publicKey,
      signature,
    );
  } catch {
    // A malformed signature (wrong length) is a bad signature, not a crash.
    return false;
  }
}

interface ChainBreak {
  readonly checkedEntries: number;
  readonly firstBrokenSeq: number;
  readonly breakKind: ChainBreakKind;
}

/** Walk the stored rows in seq order; the first break, or undefined. */
function walkChain(rows: readonly ChainDbRow[]): ChainBreak | undefined {
  if (rows.length === 0) return undefined;
  const firstSeq = Number(rows[0]!.seq);
  let prev = firstSeq === 1 ? genesisHash(RECEIPT_STREAM_ID) : rows[0]!.prev_hash;
  let expected = firstSeq;
  let checkedEntries = 0;
  for (const row of rows) {
    const seq = Number(row.seq);
    const fail = (breakKind: ChainBreakKind): ChainBreak => ({
      checkedEntries,
      firstBrokenSeq: seq,
      breakKind,
    });
    if (row.hash_version !== HASH_VERSION) return fail('unsupported_hash_version');
    if (seq !== expected) return fail('seq_gap');
    if (!row.prev_hash.equals(prev)) return fail('link_mismatch');
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
    if (!recomputed.equals(row.entry_hash)) return fail('hash_mismatch');
    prev = row.entry_hash;
    expected = seq + 1;
    checkedEntries += 1;
  }
  return undefined;
}

/**
 * #1565 — the anchor file against `audit_checkpoints`. Checkpoints are never
 * deleted legitimately (the reaper only touches `turn_receipts`), so every
 * anchored checkpoint must still be in the DB with the same hash. A DB
 * checkpoint missing from the anchor is NOT a finding: the append is
 * best-effort and the path may have been configured later.
 */
function compareAnchor(
  read: AnchorReadResult | undefined,
  checkpoints: readonly CheckpointDbRow[],
  recordedHeadSeq: number,
  publicKey: KeyObject | undefined,
): VerifyReceiptStreamResult['anchor'] {
  if (!read) return { configured: false, records: 0, matched: 0, findings: [] };
  if (read.status !== 'ok') {
    // Missing / unreadable file: surfaced via `status`, not a DB finding —
    // the DB admin is not the actor who can delete it.
    return { configured: true, status: read.status, records: 0, matched: 0, findings: [] };
  }
  const dbBySeq = new Map(checkpoints.map((c) => [Number(c.seq), c]));
  const findings: AnchorFinding[] = read.malformedLines.map((line) => ({
    seq: line,
    kind: 'malformed' as const,
  }));
  let matched = 0;
  for (const rec of read.records) {
    const headHash = Buffer.from(rec.headHashHex, 'hex');
    if (
      publicKey &&
      !verifySignature(
        publicKey,
        rec.seq,
        headHash,
        rec.signedAtIso,
        Buffer.from(rec.signatureBase64, 'base64'),
      )
    ) {
      findings.push({ seq: rec.seq, kind: 'bad_signature' });
      continue;
    }
    if (rec.seq > recordedHeadSeq) findings.push({ seq: rec.seq, kind: 'beyond_head' });
    const db = dbBySeq.get(rec.seq);
    if (!db) {
      findings.push({ seq: rec.seq, kind: 'missing_in_db' });
    } else if (!db.head_hash.equals(headHash)) {
      findings.push({ seq: rec.seq, kind: 'mismatch' });
    } else {
      matched += 1;
    }
  }
  return { configured: true, status: 'ok', records: read.records.length, matched, findings };
}
