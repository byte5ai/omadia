/**
 * #758 — receipt hash chain: canonicalization, entry hashing, segment
 * verification (tamper tests), the transactional chained append, and
 * Ed25519 checkpoint signing. All against in-memory fakes; the pg wire
 * behaviour (FOR UPDATE serialization) is modelled by a stateful fake pool.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync, verify as edVerify, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';

import {
  RECEIPT_STREAM_ID,
  canonicalJson,
  computeEntryHash,
  genesisHash,
  verifyChainSegment,
  type ChainRow,
} from '../src/receipts/chain.js';
import {
  PgTurnReceiptStore,
  receiptChainPayload,
  resetTurnReceiptCounters,
  turnReceiptCounters,
} from '../src/receipts/store.js';
import {
  checkpointSigningInput,
  loadCheckpointSigner,
  runCheckpointPass,
} from '../src/receipts/checkpoints.js';

const RECEIPT = {
  datasetsInterned: 1,
  fieldsMasked: 4,
  fieldsCleartext: 2,
  verbsExecuted: ['v4_sort'],
  pseudonymProjectionUsed: false,
};

describe('#758 canonicalJson', () => {
  it('is key-order independent, drops undefined members, keeps array order', () => {
    const a = canonicalJson({ b: 1, a: { y: [3, 1], x: 'ü' }, skip: undefined });
    const b = canonicalJson({ a: { x: 'ü', y: [3, 1] }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"x":"ü","y":[3,1]},"b":1}');
  });
});

describe('#758 computeEntryHash + verifyChainSegment', () => {
  function buildChain(payloads: unknown[]): ChainRow[] {
    const rows: ChainRow[] = [];
    let prev = genesisHash(RECEIPT_STREAM_ID);
    payloads.forEach((payload, i) => {
      const seq = i + 1;
      const entryHash = computeEntryHash({ streamId: RECEIPT_STREAM_ID, seq, prevHash: prev, payload });
      rows.push({ seq, prevHash: prev, entryHash, payload });
      prev = entryHash;
    });
    return rows;
  }

  it('a well-formed chain verifies end to end', () => {
    const rows = buildChain([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const verdict = verifyChainSegment(RECEIPT_STREAM_ID, rows, genesisHash(RECEIPT_STREAM_ID));
    assert.deepEqual(verdict, { ok: true, checkedEntries: 3 });
  });

  it('TAMPER: editing a mid-chain payload reports hash_mismatch at exactly that seq', () => {
    const rows = buildChain([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const tampered = rows.map((r) => (r.seq === 2 ? { ...r, payload: { n: 99 } } : r));
    const verdict = verifyChainSegment(RECEIPT_STREAM_ID, tampered, genesisHash(RECEIPT_STREAM_ID));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.firstBrokenSeq, 2);
    assert.equal(verdict.breakKind, 'hash_mismatch');
  });

  it('TAMPER: deleting a mid-chain row reports seq_gap', () => {
    const rows = buildChain([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const withGap = [rows[0]!, rows[2]!];
    const verdict = verifyChainSegment(RECEIPT_STREAM_ID, withGap, genesisHash(RECEIPT_STREAM_ID));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.firstBrokenSeq, 3);
    assert.equal(verdict.breakKind, 'seq_gap');
  });

  it('TAMPER: a re-written chain suffix still fails against the trusted genesis (link_mismatch)', () => {
    const rows = buildChain([{ n: 1 }]);
    const forged = buildChain([{ n: 999 }]).map((r) => ({ ...r, prevHash: rows[0]!.entryHash }));
    const verdict = verifyChainSegment(RECEIPT_STREAM_ID, forged, genesisHash(RECEIPT_STREAM_ID));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.breakKind, 'link_mismatch');
  });
});

// ── stateful fake pool modelling the chained-append transaction ────────────

interface FakeRow {
  turn_id: string;
  seq: number;
  prev_hash: Buffer;
  entry_hash: Buffer;
  payload: unknown;
}

function chainFakePool(): {
  pool: Pool;
  rows: FakeRow[];
  head: () => { head_seq: number; head_hash: Buffer } | undefined;
} {
  const rows: FakeRow[] = [];
  const turnIds = new Set<string>();
  let head: { head_seq: number; head_hash: Buffer } | undefined;
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
      // The fake applies writes immediately; ROLLBACK-safety is asserted via
      // the head/rows invariants in the replay test below.
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM audit_stream_heads') && sql.includes('FOR UPDATE')) {
      return { rows: head ? [{ head_seq: String(head.head_seq), head_hash: head.head_hash }] : [], rowCount: head ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO turn_receipts')) {
      const turnId = params[0] as string;
      if (turnIds.has(turnId)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      turnIds.add(turnId);
      rows.push({
        turn_id: turnId,
        seq: params[6] as number,
        prev_hash: params[7] as Buffer,
        entry_hash: params[8] as Buffer,
        payload: JSON.parse(params[4] as string),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_stream_heads')) {
      head = { head_seq: params[1] as number, head_hash: params[2] as Buffer };
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`chainFakePool: unscripted SQL: ${sql.slice(0, 80)}`);
  };
  const client = { query, release: () => undefined };
  const pool = { connect: async () => client, query } as unknown as Pool;
  return { pool, rows, head: () => head };
}

describe('#758 PgTurnReceiptStore chained append', () => {
  it('three records form a verifiable linear chain from the genesis hash', async () => {
    resetTurnReceiptCounters();
    const { pool, rows } = chainFakePool();
    const store = new PgTurnReceiptStore(pool);
    for (const id of ['t-1', 't-2', 't-3']) {
      await store.record({ turnId: id, sessionScope: 's', receipt: RECEIPT });
    }
    assert.equal(rows.length, 3);
    const chainRows: ChainRow[] = rows.map((r) => ({
      seq: r.seq,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
      // The verifier recomputes from the SAME payload shape the store hashed.
      payload: receiptChainPayload({ turnId: r.turn_id, sessionScope: 's', receipt: r.payload as never }),
    }));
    const verdict = verifyChainSegment(RECEIPT_STREAM_ID, chainRows, genesisHash(RECEIPT_STREAM_ID));
    assert.deepEqual(verdict, { ok: true, checkedEntries: 3 });
    assert.equal(turnReceiptCounters().persisted, 3);
  });

  it('a migration-seeded head (seq 0, genesis hash) yields the identical first append', async () => {
    // Review H1 — 0041 seeds the head row so FOR UPDATE always has a row to
    // lock. The seeded state (0, genesis) must produce byte-identical chain
    // rows to the pre-seed fallback path.
    resetTurnReceiptCounters();
    const { pool, rows } = chainFakePool();
    // Simulate the seed by priming the fake's head before any append.
    await pool.query(
      'INSERT INTO audit_stream_heads (stream_id, head_seq, head_hash, updated_at) VALUES ($1,$2,$3,NOW())',
      [RECEIPT_STREAM_ID, 0, genesisHash(RECEIPT_STREAM_ID)],
    );
    await new PgTurnReceiptStore(pool).record({ turnId: 't-1', sessionScope: 's', receipt: RECEIPT });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.seq, 1);
    assert.ok(rows[0]!.prev_hash.equals(genesisHash(RECEIPT_STREAM_ID)));
  });

  it('a replayed turn advances neither rows, nor head, nor the counter', async () => {
    resetTurnReceiptCounters();
    const { pool, rows, head } = chainFakePool();
    const store = new PgTurnReceiptStore(pool);
    await store.record({ turnId: 't-1', receipt: RECEIPT });
    const headAfterFirst = head()!.head_hash;
    await store.record({ turnId: 't-1', receipt: RECEIPT }); // replay
    assert.equal(rows.length, 1);
    assert.ok(head()!.head_hash.equals(headAfterFirst), 'head must not move on a replay');
    assert.equal(turnReceiptCounters().persisted, 1);
  });
});

describe('#758 checkpoint signing', () => {
  function makeKey(): string {
    const { privateKey } = generateKeyPairSync('ed25519');
    return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  }

  it('loadCheckpointSigner rejects a non-Ed25519 key loudly', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    assert.throws(() => loadCheckpointSigner(rsaB64), /must be an Ed25519 key/);
    assert.throws(() => loadCheckpointSigner('not-a-key'), /AUDIT_SIGNING_KEY/);
  });

  function checkpointFakePool(headSeq: number | undefined): { pool: Pool; inserted: unknown[][] } {
    const inserted: unknown[][] = [];
    let lastCheckpointSeq: number | undefined;
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM audit_stream_heads')) {
          return headSeq === undefined
            ? { rows: [], rowCount: 0 }
            : { rows: [{ head_seq: String(headSeq), head_hash: genesisHash('x') }], rowCount: 1 };
        }
        if (sql.includes('MAX(seq)')) {
          return { rows: [{ seq: lastCheckpointSeq === undefined ? null : String(lastCheckpointSeq) }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO audit_checkpoints')) {
          inserted.push(params);
          lastCheckpointSeq = params[1] as number;
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`checkpointFakePool: unscripted SQL: ${sql.slice(0, 60)}`);
      },
    } as unknown as Pool;
    return { pool, inserted };
  }

  it('signs the head, is verifiable with the public key, anchors externally, and never duplicates', async () => {
    const signer = loadCheckpointSigner(makeKey());
    const { pool, inserted } = checkpointFakePool(7);
    const anchorPath = join(mkdtempSync(join(tmpdir(), 'anchor-')), 'anchors.jsonl');
    const record = await runCheckpointPass(pool, signer, { anchorPath });
    assert.ok(record);
    assert.equal(record.seq, 7);
    // Signature verifies against the exported public key over the documented input.
    const ok = edVerify(
      null,
      checkpointSigningInput({
        streamId: record.streamId,
        seq: record.seq,
        headHash: Buffer.from(record.headHashHex, 'hex'),
        signedAtIso: record.signedAtIso,
      }),
      createPublicKey(signer.publicKeyPem),
      Buffer.from(record.signatureBase64, 'base64'),
    );
    assert.equal(ok, true, 'checkpoint signature must verify with the public key');
    // External anchor line landed and round-trips.
    const anchored = JSON.parse(readFileSync(anchorPath, 'utf-8').trim()) as { seq: number };
    assert.equal(anchored.seq, 7);
    // Head unchanged ⇒ second pass writes nothing (no duplicate checkpoints).
    const again = await runCheckpointPass(pool, signer, { anchorPath });
    assert.equal(again, undefined);
    assert.equal(inserted.length, 1);
  });

  it('a stream with no head yet produces no checkpoint (nothing to certify)', async () => {
    const signer = loadCheckpointSigner(makeKey());
    const { pool, inserted } = checkpointFakePool(undefined);
    assert.equal(await runCheckpointPass(pool, signer, {}), undefined);
    assert.equal(inserted.length, 0);
  });

  it('the LOSING replica of a checkpoint race neither anchors nor reports (review M1)', async () => {
    const signer = loadCheckpointSigner(makeKey());
    // Fake where the checkpoint INSERT loses the (stream, seq) conflict.
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM audit_stream_heads')) {
          return { rows: [{ head_seq: '7', head_hash: genesisHash('x') }], rowCount: 1 };
        }
        if (sql.includes('MAX(seq)')) return { rows: [{ seq: null }], rowCount: 1 };
        if (sql.includes('INSERT INTO audit_checkpoints')) return { rows: [], rowCount: 0 };
        throw new Error('unscripted');
      },
    } as unknown as Pool;
    const anchorPath = join(mkdtempSync(join(tmpdir(), 'anchor-loser-')), 'anchors.jsonl');
    const record = await runCheckpointPass(pool, signer, { anchorPath });
    assert.equal(record, undefined, 'the loser must not report a checkpoint');
    // The anchor file must not exist — nothing was appended.
    assert.throws(() => readFileSync(anchorPath, 'utf-8'));
  });
});
