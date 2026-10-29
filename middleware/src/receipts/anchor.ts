/**
 * #1565 — the external checkpoint anchor (`AUDIT_ANCHOR_PATH`), read back.
 *
 * The checkpoint worker appends every signed checkpoint to a JSONL file
 * OUTSIDE the database. Until #1565 nothing ever read it, so an admin who
 * deleted the newest receipts together with `audit_checkpoints` passed every
 * check while the file still held the proof. This module parses the file so
 * the server verifier can compare it with the database and the checkpoint
 * worker can refuse to re-sign a head that rolled back below it.
 *
 * The offline verifier (`scripts/verify-audit-export.mjs --anchor`) has its
 * own independent copy of this parsing — deliberately, see that file.
 */

import { readFile } from 'node:fs/promises';

/** One anchor line, as `runCheckpointPass` writes it (`CheckpointRecord`). */
export interface AnchorRecord {
  readonly streamId: string;
  readonly seq: number;
  readonly headHashHex: string;
  readonly signedAtIso: string;
  readonly signatureBase64: string;
  readonly publicKeyFingerprint: string;
}

export type AnchorReadResult =
  | {
      readonly status: 'ok';
      /** Records of the requested stream, in file order. */
      readonly records: readonly AnchorRecord[];
      /** 1-based line numbers that are not a well-formed anchor record. */
      readonly malformedLines: readonly number[];
    }
  /** The file does not exist (yet): no checkpoint was anchored so far, or
   *  the path was configured after the fact. Not tamper evidence by itself. */
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly message: string };

const HEX_32 = /^[0-9a-f]{64}$/;

function parseRecord(value: unknown): AnchorRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v['streamId'] !== 'string' ||
    typeof v['seq'] !== 'number' ||
    !Number.isSafeInteger(v['seq']) ||
    v['seq'] < 1 ||
    typeof v['headHashHex'] !== 'string' ||
    !HEX_32.test(v['headHashHex']) ||
    typeof v['signedAtIso'] !== 'string' ||
    typeof v['signatureBase64'] !== 'string' ||
    typeof v['publicKeyFingerprint'] !== 'string'
  ) {
    return undefined;
  }
  return {
    streamId: v['streamId'],
    seq: v['seq'],
    headHashHex: v['headHashHex'],
    signedAtIso: v['signedAtIso'],
    signatureBase64: v['signatureBase64'],
    publicKeyFingerprint: v['publicKeyFingerprint'],
  };
}

/** Parse anchor JSONL text; records of other streams are skipped silently. */
export function parseAnchorJsonl(
  text: string,
  streamId: string,
): {
  records: AnchorRecord[];
  malformedLines: number[];
} {
  const records: AnchorRecord[] = [];
  const malformedLines: number[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines.push(i + 1);
      continue;
    }
    const record = parseRecord(parsed);
    if (!record) {
      malformedLines.push(i + 1);
      continue;
    }
    if (record.streamId === streamId) records.push(record);
  }
  return { records, malformedLines };
}

export async function readAnchorFile(path: string, streamId: string): Promise<AnchorReadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', message: err instanceof Error ? err.message : String(err) };
  }
  return { status: 'ok', ...parseAnchorJsonl(text, streamId) };
}

/** Highest anchored seq of the stream, 0 when the file has none or cannot
 *  be read — a read problem is logged here, because the worker guard then
 *  runs without the anchor half (the verifier reports the status itself). */
export async function maxAnchoredSeq(path: string, streamId: string): Promise<number> {
  const res = await readAnchorFile(path, streamId);
  if (res.status === 'unreadable') {
    console.error(`[receipts] anchor file unreadable, guard runs without it: ${res.message}`);
  }
  if (res.status !== 'ok') return 0;
  return res.records.reduce((max, r) => Math.max(max, r.seq), 0);
}

/**
 * What this process itself witnessed of the chain (#1565 / #1566): the
 * highest stream head it read and the newest checkpoint it signed. Heads
 * only move forward and checkpoints are never deleted, so a recorded head
 * below `highestHead`, or a DB that no longer holds `lastSigned` unchanged,
 * is tampering — an in-process anchor that needs no anchor file. It lasts
 * as long as the process; after a restart only the anchor file remembers.
 * One instance per process, created in `index.ts` and passed to the worker
 * and the verify route; never a module singleton (test isolation).
 */
export class ChainWitness {
  private head = 0;
  private signed: { readonly seq: number; readonly headHashHex: string } | undefined;

  noteHead(seq: number): void {
    if (seq > this.head) this.head = seq;
  }

  noteSigned(seq: number, headHashHex: string): void {
    this.noteHead(seq);
    if (!this.signed || seq > this.signed.seq) this.signed = { seq, headHashHex };
  }

  get highestHead(): number {
    return this.head;
  }

  get lastSigned(): { readonly seq: number; readonly headHashHex: string } | undefined {
    return this.signed;
  }
}
