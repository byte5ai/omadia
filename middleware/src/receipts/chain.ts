/**
 * #758 — receipt hash chain: canonicalization, entry hashing, and segment
 * verification. Pure functions — the transactional append lives in
 * `store.ts`, the signing in `checkpoints.ts`.
 *
 * Mechanism (the sentence for the docs): every entry carries the fingerprint
 * of its predecessor; editing entry n changes its hash, which no longer
 * matches the copy stored in entry n+1 — the chain visibly breaks for every
 * later entry. Signed checkpoints anchored outside the DB mean the whole
 * chain cannot be silently rewritten either. Detection, not prevention.
 */

import { createHash } from 'node:crypto';

/** Bump when the canonicalization or hash input layout changes; stored per
 *  row so old chains stay verifiable under their own rules. */
export const HASH_VERSION = 1;

/** The one stream #758 ships. More streams (admin_audit, …) join later. */
export const RECEIPT_STREAM_ID = 'receipts';

/**
 * Canonical JSON — the RFC 8785 (JCS) subset this codebase needs: objects
 * with lexicographically sorted keys (code-unit order), arrays in order,
 * `undefined` object members dropped (JSON.stringify semantics), numbers as
 * JSON.stringify renders them. Payloads here are JSONB round-trips —
 * strings, bounded numbers, booleans, null, plain objects/arrays — so the
 * full-JCS number edge cases (±0, exponents beyond double round-trip) cannot
 * arise; `hash_version` exists for the day that changes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',');
  return `{${body}}`;
}

/** Genesis hash of a stream: sha256 over the stream id itself — a fixed,
 *  reproducible starting anchor an offline verifier can recompute. */
export function genesisHash(streamId: string): Buffer {
  return createHash('sha256').update(`genesis:${streamId}`, 'utf-8').digest();
}

export interface ChainEntryInput {
  readonly streamId: string;
  readonly seq: number;
  readonly prevHash: Buffer;
  /** The canonical payload — for receipts: {turnId, sessionScope, channel,
   *  model, receipt}. Never includes DB-generated values (created_at):
   *  time is anchored by checkpoint cadence, not per-row (documented). */
  readonly payload: unknown;
}

/** entry_hash = sha256(streamId \n seq \n hex(prevHash) \n canonical(payload)).
 *  Newline framing keeps fields from bleeding into each other. */
export function computeEntryHash(input: ChainEntryInput): Buffer {
  return createHash('sha256')
    .update(
      `${input.streamId}\n${String(input.seq)}\n${input.prevHash.toString('hex')}\n${canonicalJson(input.payload)}`,
      'utf-8',
    )
    .digest();
}

export interface ChainRow {
  readonly seq: number;
  readonly prevHash: Buffer;
  readonly entryHash: Buffer;
  readonly payload: unknown;
}

export type ChainBreakKind = 'hash_mismatch' | 'link_mismatch' | 'seq_gap';

export interface ChainVerdict {
  readonly ok: boolean;
  readonly checkedEntries: number;
  readonly firstBrokenSeq?: number;
  readonly breakKind?: ChainBreakKind;
}

/**
 * Verify a contiguous ascending-`seq` segment. `trustedPrevHash` is the hash
 * the first row must link to: the genesis hash when the segment starts at
 * seq 1, or a hash vouched for out-of-band (a signed checkpoint) when the
 * prefix was reaped by retention. Foundation for the #761 verify surface;
 * shipped here so the chain is testable (tamper tests) from day one.
 */
export function verifyChainSegment(
  streamId: string,
  rows: readonly ChainRow[],
  trustedPrevHash: Buffer,
): ChainVerdict {
  let prev = trustedPrevHash;
  let expectedSeq: number | undefined;
  for (const row of rows) {
    if (expectedSeq !== undefined && row.seq !== expectedSeq) {
      return { ok: false, checkedEntries: rows.indexOf(row), firstBrokenSeq: row.seq, breakKind: 'seq_gap' };
    }
    if (!row.prevHash.equals(prev)) {
      return { ok: false, checkedEntries: rows.indexOf(row), firstBrokenSeq: row.seq, breakKind: 'link_mismatch' };
    }
    const recomputed = computeEntryHash({
      streamId,
      seq: row.seq,
      prevHash: row.prevHash,
      payload: row.payload,
    });
    if (!recomputed.equals(row.entryHash)) {
      return { ok: false, checkedEntries: rows.indexOf(row), firstBrokenSeq: row.seq, breakKind: 'hash_mismatch' };
    }
    prev = row.entryHash;
    expectedSeq = row.seq + 1;
  }
  return { ok: true, checkedEntries: rows.length };
}
