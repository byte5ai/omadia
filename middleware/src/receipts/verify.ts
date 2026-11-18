/**
 * #761 — server-side verification of the receipt hash chain (#758).
 *
 * Walks every stored row in seq order (keyset batches, one REPEATABLE READ
 * snapshot — no row cap), recomputes every entry hash from the canonical
 * payload (the exact `receiptChainPayload` shape the store hashed), checks
 * link continuity, validates every checkpoint against both the signature
 * and the row it claims to certify, and consults the stream head so tail
 * truncation and a wiped table cannot report green.
 *
 * Anchoring semantics (review #761/H2, #1567): a retention-reaped prefix is
 * ANCHORED when any signature-valid checkpoint inside the surviving range
 * certifies its row — the prev_hash of the first survivor is an input to
 * that row's hash, which is transitively covered by the checkpoint, so the
 * suffix as a whole is vouched for. No exact boundary alignment required.
 *
 * Premature-deletion rule (review #761/M4): a signature-valid checkpoint at
 * seq S signed at time T proves every row with seq > S was created AFTER T.
 * If the youngest reaped row (seq = firstSurvivor-1) sits above such a
 * checkpoint whose T is younger than the retention window, that row was
 * provably younger than retention when deleted — a laundering finding, not
 * retention. Only ever inferred from signature-checked checkpoints.
 *
 * Verdict (#1568 / #1584): `verified` needs a public key and at least one
 * signature-valid checkpoint certifying a surviving row. Without a key the
 * best verdict is `unsigned` — consistent, but nothing vouches for it — and
 * a reaped prefix is unanchored information, not a break.
 * `checkpoints.verified` only counts signature-checked checkpoints.
 *
 * Truncation / rewrite (#1565 / #1566): a checkpoint above the newest row is
 * orphaned; with a key, a chain no signed checkpoint certifies is broken
 * once its oldest row is older than two checkpoint intervals; the external
 * anchor file is compared with `audit_checkpoints`; and what this process
 * witnessed (highest head, newest checkpoint it signed) must still hold.
 *
 * The offline verifier (`scripts/verify-audit-export.mjs`) applies the same
 * rules to an export, from the head and settings the export header carries.
 * Only the process witness is server-only.
 *
 * What a green verdict proves / does not prove: see
 * `docs/provenance-verification.md`.
 */

import { createPublicKey, type KeyObject } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { type AnchorReadResult, type ChainWitness } from './anchor.js';
import { HASH_VERSION, RECEIPT_STREAM_ID, computeEntryHash, genesisHash } from './chain.js';
import { checkpointSignatureValid } from './checkpoints.js';
import { receiptChainPayload } from './store.js';

/** Rows per keyset batch of the chain walk. */
const VERIFY_BATCH = 5_000;

export interface CheckpointFinding {
  readonly seq: number;
  /**
   * orphaned             — no stored row at or above the first survivor.
   * no_signed_checkpoint — a key is configured, yet no signature-valid
   *                        checkpoint certifies a stored row (`seq` = head).
   * witness_mismatch     — the checkpoint this process signed is missing or
   *                        changed in the DB.
   */
  readonly kind:
    | 'orphaned'
    | 'bad_signature'
    | 'hash_mismatch_vs_row'
    | 'no_signed_checkpoint'
    | 'witness_mismatch';
}

export interface AnchorFinding {
  readonly seq: number;
  /**
   * missing_in_db — the anchor holds a checkpoint `audit_checkpoints` lost.
   * mismatch      — the DB checkpoint at that seq certifies another hash.
   * beyond_head   — the anchor certifies a seq above the recorded head.
   * bad_signature — the anchor line does not verify with the public key.
   * unavailable   — signing is on but the anchor file is missing/unreadable
   *                 (the worker creates it at boot); `seq` is 0.
   */
  readonly kind: 'missing_in_db' | 'mismatch' | 'beyond_head' | 'bad_signature' | 'unavailable';
}

export type ProvenanceVerdict = 'verified' | 'unsigned' | 'broken';

export type ChainBreakKind =
  | 'hash_mismatch'
  | 'link_mismatch'
  | 'seq_gap'
  | 'unsupported_hash_version'
  | 'head_beyond_rows'
  | 'head_hash_mismatch'
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
  /** Rows written before chaining existed (NULL chain columns) — reported,
   *  never counted as verified or broken. */
  readonly preChainRows: number;
  readonly firstBrokenSeq?: number;
  readonly breakKind?: ChainBreakKind;
  readonly checkpoints: {
    readonly total: number;
    /** Signature checked AND valid, no finding (#1584) — 0 without a key. */
    readonly verified: number;
    /** Present but signature not checked (no public key). */
    readonly unchecked: number;
    readonly findings: readonly CheckpointFinding[];
    /** No public key available ⇒ signatures could not be checked. */
    readonly signaturesChecked: boolean;
    /** Key configured, nothing certified yet, every row younger than two
     *  checkpoint intervals: the worker has not caught up — `unsigned`,
     *  not broken. */
    readonly awaitingFirstCheckpoint?: boolean;
  };
  readonly prefix: {
    /** Highest seq removed by retention (0 = nothing reaped). */
    readonly reapedUpToSeq: number;
    /** A signature-valid checkpoint inside the surviving range certifies the
     *  suffix (transitively covering the first survivor's prev link). */
    readonly anchored: boolean;
    /** Unanchored but expected: no public key, so no checkpoint could vouch
     *  for it (#1568). Reported, not a break. */
    readonly unanchoredReason?: 'no_signing_key';
    /** Sound youngest-reaped-row proof (see module doc). */
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
    /** Lines that are not anchor records (e.g. a torn final write) —
     *  reported, not tamper evidence: the DB admin cannot write the file. */
    readonly malformedLines: number;
    readonly findings: readonly AnchorFinding[];
  };
}

export interface VerifyReceiptStreamOptions {
  /** SPKI PEM of the checkpoint public key; absent ⇒ signatures unchecked. */
  readonly publicKeyPem?: string;
  readonly retentionDays: number;
  /** `AUDIT_CHECKPOINT_INTERVAL_MINUTES` — the grace before an uncertified
   *  keyed chain counts as `no_signed_checkpoint` (default 60). */
  readonly checkpointIntervalMinutes?: number;
  readonly now?: () => Date;
  /** `AUDIT_ANCHOR_PATH` is set — the caller passes what it read (#1565). */
  readonly anchor?: AnchorReadResult;
  /** What this process witnessed (#1565 / #1566). */
  readonly witness?: ChainWitness;
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
  created_at: Date;
}

interface CheckpointDbRow {
  seq: string;
  head_hash: Buffer;
  signed_at: Date;
  signature: Buffer;
}

type Db = Pick<PoolClient, 'query'>;

/**
 * Run read-only queries in ONE snapshot (reviewer M6): head, rows and
 * checkpoints read separately could see a row append and a checkpoint pass
 * land in between — a checkpoint above the newest loaded row, i.e. a false
 * `orphaned`. Used by verify and by the export.
 */
export async function withReadSnapshot<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Keyset-paged chain rows in numeric seq order. #1526 — ORDER BY names the
 *  table: a bare `seq` binds to the `seq::text` alias and sorts as text. */
export async function* chainRowBatches(db: Db, columns: string): AsyncGenerator<ChainDbRow[]> {
  let after = 0;
  for (;;) {
    const res = await db.query<ChainDbRow>(
      `SELECT ${columns}
         FROM turn_receipts
        WHERE stream_id = $1 AND seq > $2
        ORDER BY turn_receipts.seq ASC
        LIMIT $3`,
      [RECEIPT_STREAM_ID, after, VERIFY_BATCH],
    );
    if (res.rows.length === 0) return;
    yield res.rows;
    if (res.rows.length < VERIFY_BATCH) return;
    after = Number(res.rows[res.rows.length - 1]!.seq);
  }
}

export const CHAIN_ROW_COLUMNS = `turn_id, session_scope, channel, model, receipt,
       seq::text AS seq, prev_hash, entry_hash, hash_version, created_at`;

export async function verifyReceiptStream(
  pool: Pool,
  opts: VerifyReceiptStreamOptions,
): Promise<VerifyReceiptStreamResult> {
  // Copy the witness BEFORE the snapshot (security review N2): a checkpoint
  // signed or a head read by a concurrent pass after BEGIN is not in this
  // snapshot and would read as tampering.
  const witnessView = opts.witness
    ? { highestHead: opts.witness.highestHead, lastSigned: opts.witness.lastSigned }
    : undefined;
  const result = await withReadSnapshot(pool, (db) => verifyInSnapshot(db, opts, witnessView));
  opts.witness?.noteHead(result.recordedHeadSeq);
  return result;
}

interface WitnessView {
  readonly highestHead: number;
  readonly lastSigned: ChainWitness['lastSigned'];
}

interface ChainBreak {
  readonly firstBrokenSeq: number;
  readonly breakKind: ChainBreakKind;
}

/** Incremental chain walk: feed rows in seq order; stops at the first break. */
class ChainWalker {
  checked = 0;
  broken: ChainBreak | undefined;
  private prev: Buffer | undefined;
  private expected: number | undefined;

  feed(row: ChainDbRow): void {
    if (this.broken) return;
    const seq = Number(row.seq);
    if (this.expected === undefined) {
      this.expected = seq;
      this.prev = seq === 1 ? genesisHash(RECEIPT_STREAM_ID) : row.prev_hash;
    }
    const fail = (breakKind: ChainBreakKind): void => {
      this.broken = { firstBrokenSeq: seq, breakKind };
    };
    if (row.hash_version !== HASH_VERSION) return fail('unsupported_hash_version');
    if (seq !== this.expected) return fail('seq_gap');
    if (!row.prev_hash.equals(this.prev!)) return fail('link_mismatch');
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
    this.prev = row.entry_hash;
    this.expected = seq + 1;
    this.checked += 1;
  }
}

async function verifyInSnapshot(
  db: Db,
  opts: VerifyReceiptStreamOptions,
  witness: WitnessView | undefined,
): Promise<VerifyReceiptStreamResult> {
  const now = opts.now?.() ?? new Date();
  const preChain = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM turn_receipts WHERE stream_id IS NULL`,
  );
  const preChainRows = Number(preChain.rows[0]?.n ?? 0);
  const headRes = await db.query<{ head_seq: string; head_hash: Buffer }>(
    `SELECT head_seq::text AS head_seq, head_hash FROM audit_stream_heads WHERE stream_id = $1`,
    [RECEIPT_STREAM_ID],
  );
  const recordedHeadSeq = Number(headRes.rows[0]?.head_seq ?? 0);
  const recordedHeadHash = headRes.rows[0]?.head_hash;
  const cpRes = await db.query<CheckpointDbRow>(
    `SELECT seq::text AS seq, head_hash, signed_at, signature
       FROM audit_checkpoints
      WHERE stream_id = $1
      ORDER BY audit_checkpoints.seq ASC`,
    [RECEIPT_STREAM_ID],
  );
  const checkpoints = cpRes.rows;
  const publicKey = opts.publicKeyPem ? createPublicKey(opts.publicKeyPem) : undefined;

  // ── checkpoint signatures ─────────────────────────────────────────────────
  const cpFindings: CheckpointFinding[] = [];
  /** Signature-valid (or, keyless, unjudged) checkpoints awaiting a row. */
  const pending = new Map<number, CheckpointDbRow>();
  /** Signature-valid checkpoints by seq → signed_at. */
  const validSignedAt = new Map<number, Date>();
  for (const cp of checkpoints) {
    const seq = Number(cp.seq);
    if (publicKey) {
      const sigOk = checkpointSignatureValid(publicKey, {
        seq,
        headHash: cp.head_hash,
        signedAtIso: cp.signed_at.toISOString(),
        signature: cp.signature,
      });
      if (!sigOk) {
        cpFindings.push({ seq, kind: 'bad_signature' });
        continue;
      }
      validSignedAt.set(seq, cp.signed_at);
    }
    pending.set(seq, cp);
  }

  // ── chain walk + checkpoint↔row comparison, one pass ─────────────────────
  const walker = new ChainWalker();
  /** Signature-valid checkpoints whose certified row matched — the anchors. */
  const certifying = new Set<number>();
  let rowCount = 0;
  let firstSeq: number | undefined;
  let last: ChainDbRow | undefined;
  let oldestCreatedAt: Date | undefined;
  for await (const batch of chainRowBatches(db, CHAIN_ROW_COLUMNS)) {
    for (const row of batch) {
      const seq = Number(row.seq);
      rowCount += 1;
      firstSeq ??= seq;
      last = row;
      if (!oldestCreatedAt || row.created_at < oldestCreatedAt) oldestCreatedAt = row.created_at;
      walker.feed(row);
      const cp = pending.get(seq);
      if (!cp) continue;
      pending.delete(seq);
      if (!row.entry_hash.equals(cp.head_hash)) {
        cpFindings.push({ seq, kind: 'hash_mismatch_vs_row' });
      } else if (publicKey) {
        certifying.add(seq);
      }
    }
  }
  const lastSeq = last ? Number(last.seq) : undefined;
  for (const seq of pending.keys()) {
    // At or above the first survivor with no row: certified evidence of
    // deletion — inside the range, or above the newest row (#1566: newest
    // rows deleted + head rolled back). Below it: reaped by retention.
    if (firstSeq !== undefined && seq >= firstSeq) cpFindings.push({ seq, kind: 'orphaned' });
  }

  // #1565 — signing is on, yet nothing certifies the stored chain. Grace
  // while every row is younger than two intervals: a fresh install's worker
  // has not had a pass since the first receipt (reviewer H2).
  const graceMs = 2 * (opts.checkpointIntervalMinutes ?? 60) * 60_000;
  const awaitingFirstCheckpoint =
    publicKey !== undefined &&
    rowCount > 0 &&
    certifying.size === 0 &&
    oldestCreatedAt !== undefined &&
    now.getTime() - oldestCreatedAt.getTime() < graceMs;
  if (publicKey && rowCount > 0 && certifying.size === 0 && !awaitingFirstCheckpoint) {
    cpFindings.push({ seq: recordedHeadSeq, kind: 'no_signed_checkpoint' });
  }

  // What this process signed must still be there (security review H1): the
  // only DB-independent evidence when there is no anchor file.
  const signed = witness?.lastSigned;
  if (signed) {
    const cp = checkpoints.find((c) => Number(c.seq) === signed.seq);
    if (cp?.head_hash.toString('hex') !== signed.headHashHex) {
      cpFindings.push({ seq: signed.seq, kind: 'witness_mismatch' });
    }
  }

  // ── prefix (retention) analysis ───────────────────────────────────────────
  const reapedUpToSeq = firstSeq !== undefined ? firstSeq - 1 : recordedHeadSeq;
  const anchored =
    reapedUpToSeq === 0 || (firstSeq !== undefined && [...certifying].some((s) => s >= firstSeq));
  const unanchoredReason = !anchored && !publicKey ? ('no_signing_key' as const) : undefined;
  const prematureDeletion =
    firstSeq !== undefined && reapedUpToSeq > 0
      ? findPrematureDeletion(validSignedAt, reapedUpToSeq, opts.retentionDays, now)
      : undefined;

  // ── head consistency ──────────────────────────────────────────────────────
  let breakInfo = walker.broken;
  if (!breakInfo && lastSeq !== undefined && recordedHeadSeq > lastSeq) {
    // Review H1: a recorded head beyond the last stored row = tail truncation.
    breakInfo = { firstBrokenSeq: lastSeq + 1, breakKind: 'head_beyond_rows' };
  }
  if (
    !breakInfo &&
    last &&
    recordedHeadSeq === lastSeq &&
    recordedHeadHash &&
    !recordedHeadHash.equals(last.entry_hash)
  ) {
    breakInfo = { firstBrokenSeq: recordedHeadSeq, breakKind: 'head_hash_mismatch' };
  }
  const highestHead = witness?.highestHead ?? 0;
  if (!breakInfo && recordedHeadSeq < highestHead) {
    // #1566 — heads only move forward.
    breakInfo = { firstBrokenSeq: recordedHeadSeq + 1, breakKind: 'head_rollback' };
  }
  if (!breakInfo && rowCount === 0 && (recordedHeadSeq > 0 || checkpoints.length > 0)) {
    // Empty table while head/checkpoints claim history: never green (mirrors
    // the offline tool's zero-entry refusal).
    breakInfo = { firstBrokenSeq: 1, breakKind: 'empty_chain_with_history' };
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
    : publicKey && certifying.size > 0
      ? 'verified'
      : 'unsigned';
  const flagged = new Set(cpFindings.map((f) => f.seq));
  return {
    ok: verdict !== 'broken',
    verdict,
    checkedEntries: walker.checked,
    ...(last ? { headSeq: lastSeq, headHashHex: last.entry_hash.toString('hex') } : {}),
    recordedHeadSeq,
    preChainRows,
    ...(breakInfo ?? {}),
    checkpoints: {
      total: checkpoints.length,
      verified: [...validSignedAt.keys()].filter((seq) => !flagged.has(seq)).length,
      unchecked: publicKey ? 0 : checkpoints.length,
      findings: cpFindings,
      signaturesChecked: Boolean(publicKey),
      ...(awaitingFirstCheckpoint ? { awaitingFirstCheckpoint } : {}),
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

/** Sound direction: the highest valid checkpoint BELOW the youngest reaped
 *  row proves that row was created AFTER its signing time. */
function findPrematureDeletion(
  validSignedAt: ReadonlyMap<number, Date>,
  reapedUpToSeq: number,
  retentionDays: number,
  now: Date,
): VerifyReceiptStreamResult['prefix']['prematureDeletion'] {
  const below = [...validSignedAt.entries()]
    .filter(([seq]) => seq < reapedUpToSeq)
    .sort((a, b) => b[0] - a[0])[0];
  if (!below) return undefined;
  const ageMs = now.getTime() - below[1].getTime();
  if (ageMs >= retentionDays * 24 * 60 * 60 * 1000) return undefined;
  return { provenCreatedAfterIso: below[1].toISOString(), retentionDays };
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
  const empty = { records: 0, matched: 0, malformedLines: 0 };
  if (!read) return { configured: false, ...empty, findings: [] };
  if (read.status !== 'ok') {
    // With signing on, the worker creates the file at boot — a missing or
    // unreadable file is never green (reviewer M5). Keyless, nothing writes
    // it: status only.
    const findings: AnchorFinding[] = publicKey ? [{ seq: 0, kind: 'unavailable' }] : [];
    return { configured: true, status: read.status, ...empty, findings };
  }
  const dbBySeq = new Map(checkpoints.map((c) => [Number(c.seq), c]));
  const findings: AnchorFinding[] = [];
  let matched = 0;
  for (const rec of read.records) {
    const headHash = Buffer.from(rec.headHashHex, 'hex');
    if (
      publicKey &&
      !checkpointSignatureValid(publicKey, {
        seq: rec.seq,
        headHash,
        signedAtIso: rec.signedAtIso,
        signature: Buffer.from(rec.signatureBase64, 'base64'),
      })
    ) {
      findings.push({ seq: rec.seq, kind: 'bad_signature' });
      continue;
    }
    if (rec.seq > recordedHeadSeq) findings.push({ seq: rec.seq, kind: 'beyond_head' });
    const db = dbBySeq.get(rec.seq);
    if (!db) findings.push({ seq: rec.seq, kind: 'missing_in_db' });
    else if (!db.head_hash.equals(headHash)) findings.push({ seq: rec.seq, kind: 'mismatch' });
    else matched += 1;
  }
  return {
    configured: true,
    status: 'ok',
    records: read.records.length,
    matched,
    malformedLines: read.malformedLines.length,
    findings,
  };
}
