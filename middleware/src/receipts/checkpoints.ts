/**
 * #758 — signed audit checkpoints. On an interval, sign the receipt stream's
 * current head `(stream_id, seq, head_hash, signed_at)` with Ed25519 and
 * persist the checkpoint — plus, when configured, append it to an external
 * anchor file (JSONL) OUTSIDE the database, suitable for shipping to WORM
 * storage. The private key comes from the environment / secret manager and
 * is NEVER stored in Postgres: the admin the chain defends against must not
 * be able to re-sign a rewritten chain.
 *
 * Key format: base64-encoded PKCS#8 DER Ed25519 private key — generate with
 * `node scripts/generate-audit-signing-key.mjs`.
 */

import { appendFile } from 'node:fs/promises';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  type KeyObject,
} from 'node:crypto';
import type { Pool } from 'pg';

import { RECEIPT_STREAM_ID } from './chain.js';

export interface CheckpointSigner {
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  /** sha256 over the SPKI DER of the public key, hex — the stable id an
   *  offline verifier pins. */
  readonly publicKeyFingerprint: string;
}

/** Parse the configured signing key. Throws with a actionable message on a
 *  malformed key — a silently-disabled signer would be the #640 no-op. */
export function loadCheckpointSigner(privateKeyBase64: string): CheckpointSigner {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (err) {
    throw new Error(
      `AUDIT_SIGNING_KEY is not a base64 PKCS#8 Ed25519 private key (generate one with scripts/generate-audit-signing-key.mjs): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `AUDIT_SIGNING_KEY must be an Ed25519 key, got '${privateKey.asymmetricKeyType ?? 'unknown'}'`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicKeyFingerprint: createHash('sha256').update(spkiDer).digest('hex'),
  };
}

/** The exact bytes a checkpoint signature covers. Newline-framed, hex for
 *  the hash — reproducible by an offline verifier with no library beyond
 *  node:crypto. */
export function checkpointSigningInput(input: {
  streamId: string;
  seq: number;
  headHash: Buffer;
  signedAtIso: string;
}): Buffer {
  return Buffer.from(
    `omadia-audit-checkpoint-v1\n${input.streamId}\n${String(input.seq)}\n${input.headHash.toString('hex')}\n${input.signedAtIso}`,
    'utf-8',
  );
}

export interface CheckpointRecord {
  readonly streamId: string;
  readonly seq: number;
  readonly headHashHex: string;
  readonly signedAtIso: string;
  readonly signatureBase64: string;
  readonly publicKeyFingerprint: string;
}

/**
 * One checkpoint pass: read the stream head; if it advanced past the last
 * checkpoint, sign and persist (+ optionally anchor). Exported for tests and
 * for an eager boot pass. Returns the record written, or undefined when the
 * head has not moved (no pointless duplicate checkpoints).
 */
export async function runCheckpointPass(
  pool: Pool,
  signer: CheckpointSigner,
  opts: { anchorPath?: string; now?: () => Date },
): Promise<CheckpointRecord | undefined> {
  const head = await pool.query<{ head_seq: string; head_hash: Buffer }>(
    `SELECT head_seq, head_hash FROM audit_stream_heads WHERE stream_id = $1`,
    [RECEIPT_STREAM_ID],
  );
  const row = head.rows[0];
  if (!row) return undefined; // nothing recorded yet
  const seq = Number(row.head_seq);
  const last = await pool.query<{ seq: string }>(
    `SELECT MAX(seq)::text AS seq FROM audit_checkpoints WHERE stream_id = $1`,
    [RECEIPT_STREAM_ID],
  );
  const lastSeq = last.rows[0]?.seq ? Number(last.rows[0].seq) : 0;
  if (seq <= lastSeq) return undefined;

  const signedAt = (opts.now?.() ?? new Date()).toISOString();
  const signature = edSign(
    null, // Ed25519: algorithm must be null/undefined
    checkpointSigningInput({
      streamId: RECEIPT_STREAM_ID,
      seq,
      headHash: row.head_hash,
      signedAtIso: signedAt,
    }),
    signer.privateKey,
  );
  const insertRes = await pool.query(
    `INSERT INTO audit_checkpoints
       (stream_id, seq, head_hash, signed_at, signature, public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stream_id, seq) DO NOTHING`,
    [RECEIPT_STREAM_ID, seq, row.head_hash, signedAt, signature, signer.publicKeyFingerprint],
  );
  // Replica race (review M1): the loser of the (stream, seq) conflict must
  // NOT anchor or report its own differently-timestamped signature — the
  // anchor file has to correspond to what the DB actually stored, or the
  // promised anchor↔DB comparison flags phantom "tampering".
  if ((insertRes.rowCount ?? 0) === 0) return undefined;
  const record: CheckpointRecord = {
    streamId: RECEIPT_STREAM_ID,
    seq,
    headHashHex: row.head_hash.toString('hex'),
    signedAtIso: signedAt,
    signatureBase64: signature.toString('base64'),
    publicKeyFingerprint: signer.publicKeyFingerprint,
  };
  if (opts.anchorPath) {
    // External anchor: append-only JSONL outside the DB. Failure is loud but
    // non-fatal — the in-DB checkpoint stands, and a missing anchor line is
    // itself detectable when comparing the two.
    try {
      await appendFile(opts.anchorPath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (err) {
      console.error('[receipts] checkpoint anchor append failed:', err);
    }
  }
  return record;
}

/** Interval worker — unref'd, eager first pass (the table exists: plugin
 *  activation applies migrations well before this wiring, same reasoning as
 *  the retention reaper). */
export function startCheckpointWorker(
  pool: Pool,
  signer: CheckpointSigner,
  opts: { intervalMs: number; anchorPath?: string },
): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const record = await runCheckpointPass(pool, signer, { anchorPath: opts.anchorPath });
      if (record) {
        console.log(
          `[receipts] checkpoint signed: stream=${record.streamId} seq=${String(record.seq)} fingerprint=${record.publicKeyFingerprint.slice(0, 16)}…`,
        );
      }
    } catch (err) {
      console.error('[receipts] checkpoint pass failed:', err);
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer) };
}
