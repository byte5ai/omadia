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
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { Pool } from 'pg';

import { type ChainWitness, maxAnchoredSeq } from './anchor.js';
import { RECEIPT_STREAM_ID } from './chain.js';

export interface CheckpointSigner {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
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
      { cause: err },
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
    publicKey,
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

/** Checks one stored checkpoint's Ed25519 signature; a malformed signature
 *  is invalid, never a crash. */
export function checkpointSignatureValid(
  publicKey: KeyObject,
  cp: { seq: number; headHash: Buffer; signedAtIso: string; signature: Buffer },
): boolean {
  try {
    return edVerify(
      null,
      checkpointSigningInput({
        streamId: RECEIPT_STREAM_ID,
        seq: cp.seq,
        headHash: cp.headHash,
        signedAtIso: cp.signedAtIso,
      }),
      publicKey,
      cp.signature,
    );
  } catch {
    return false;
  }
}

const CHECKPOINT_PAGE = 100;

/**
 * The newest checkpoint whose signature verifies (security review M2): a
 * junk row anyone with INSERT can write at a huge seq must neither stop the
 * worker (`seq <= lastSeq` forever) nor widen the reaper's bound. Pages
 * downward until a valid one is found.
 */
export async function highestValidCheckpointSeq(pool: Pool, publicKey: KeyObject): Promise<number> {
  let below: string | null = null;
  for (;;) {
    const res: { rows: { seq: string; head_hash: Buffer; signed_at: Date; signature: Buffer }[] } =
      await pool.query(
        `SELECT seq::text AS seq, head_hash, signed_at, signature
           FROM audit_checkpoints
          WHERE stream_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
          ORDER BY audit_checkpoints.seq DESC
          LIMIT $3`,
        [RECEIPT_STREAM_ID, below, CHECKPOINT_PAGE],
      );
    for (const r of res.rows) {
      const seq = Number(r.seq);
      const valid = checkpointSignatureValid(publicKey, {
        seq,
        headHash: r.head_hash,
        signedAtIso: r.signed_at.toISOString(),
        signature: r.signature,
      });
      if (valid) return seq;
    }
    if (res.rows.length < CHECKPOINT_PAGE) return 0;
    below = res.rows[res.rows.length - 1]!.seq;
  }
}

/**
 * Why the current head must not be signed, or undefined when it may be.
 * The real key must never certify a rewound or rewritten chain (#1565,
 * security review H1): the head must be a stored row; it must not be below
 * the highest head this process saw; the newest checkpoint this process
 * signed must still be in the DB unchanged; and no anchored checkpoint may
 * lie above the newest signature-valid DB checkpoint (every anchored seq was
 * stored first, so that means checkpoints were deleted).
 */
async function refuseToSign(
  pool: Pool,
  head: { seq: number; hash: Buffer },
  lastSeq: number,
  opts: { anchorPath?: string; witness?: ChainWitness },
): Promise<string | undefined> {
  const stored = await pool.query<{ entry_hash: Buffer }>(
    `SELECT entry_hash FROM turn_receipts WHERE stream_id = $1 AND seq = $2`,
    [RECEIPT_STREAM_ID, head.seq],
  );
  const headRow = stored.rows[0];
  if (!headRow || !headRow.entry_hash.equals(head.hash)) {
    return `the stream head seq=${String(head.seq)} does not match a stored receipt`;
  }
  const witness = opts.witness;
  if (witness && head.seq < witness.highestHead) {
    return `the stream head seq=${String(head.seq)} is below the highest head this process saw (${String(witness.highestHead)})`;
  }
  const signed = witness?.lastSigned;
  if (signed) {
    const cp = await pool.query<{ head_hash: Buffer }>(
      `SELECT head_hash FROM audit_checkpoints WHERE stream_id = $1 AND seq = $2`,
      [RECEIPT_STREAM_ID, signed.seq],
    );
    if (cp.rows[0]?.head_hash.toString('hex') !== signed.headHashHex) {
      return `the checkpoint this process signed at seq=${String(signed.seq)} is missing or changed`;
    }
  }
  const anchored = opts.anchorPath ? await maxAnchoredSeq(opts.anchorPath, RECEIPT_STREAM_ID) : 0;
  if (anchored > lastSeq) {
    return `the external anchor holds seq=${String(anchored)}, above the newest valid DB checkpoint (${String(lastSeq)})`;
  }
  return undefined;
}

/**
 * One checkpoint pass: read the stream head; if it advanced past the last
 * valid checkpoint, sign and persist (+ optionally anchor). Exported for
 * tests and for an eager boot pass. Returns the record written, or undefined
 * when the head has not moved (no pointless duplicate checkpoints) or the
 * pass refused to sign (logged loudly).
 */
export async function runCheckpointPass(
  pool: Pool,
  signer: CheckpointSigner,
  opts: { anchorPath?: string; now?: () => Date; witness?: ChainWitness },
): Promise<CheckpointRecord | undefined> {
  const head = await pool.query<{ head_seq: string; head_hash: Buffer }>(
    `SELECT head_seq, head_hash FROM audit_stream_heads WHERE stream_id = $1`,
    [RECEIPT_STREAM_ID],
  );
  const row = head.rows[0];
  if (!row) return undefined; // nothing recorded yet
  const seq = Number(row.head_seq);
  if (seq === 0) return undefined; // genesis seed, nothing to certify
  const lastSeq = await highestValidCheckpointSeq(pool, signer.publicKey);
  const refusal = await refuseToSign(pool, { seq, hash: row.head_hash }, lastSeq, opts);
  if (refusal) {
    console.error(
      `[receipts] REFUSING to sign checkpoint: ${refusal} — receipts or checkpoints were changed; run provenance verify (#1565)`,
    );
    return undefined;
  }
  opts.witness?.noteHead(seq);
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
  // anchor↔DB comparison (#1565) flags phantom "tampering".
  if ((insertRes.rowCount ?? 0) === 0) return undefined;
  opts.witness?.noteSigned(seq, row.head_hash.toString('hex'));
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
    // non-fatal — the in-DB checkpoint stands, and a DB checkpoint the anchor
    // lacks is not a finding (only the reverse is).
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
  opts: { intervalMs: number; anchorPath?: string; witness?: ChainWitness },
): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const record = await runCheckpointPass(pool, signer, {
        ...(opts.anchorPath ? { anchorPath: opts.anchorPath } : {}),
        ...(opts.witness ? { witness: opts.witness } : {}),
      });
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
  void (async () => {
    // #1565 — create the anchor file at boot, so a MISSING file means it was
    // deleted (verify reports that) rather than "nothing signed yet".
    if (opts.anchorPath) {
      await appendFile(opts.anchorPath, '', 'utf-8').catch((err: unknown) => {
        console.error('[receipts] cannot create the checkpoint anchor file:', err);
      });
    }
    await tick();
  })();
  return { stop: () => clearInterval(timer) };
}
