/**
 * #761 — the verification surface: server-side verifyReceiptStream (every
 * tamper class incl. the #758 premature-deletion rule), the export route,
 * and the zero-dependency offline verifier run end-to-end via spawnSync —
 * the tool that certifies integrity must not be the untested part.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { Pool } from 'pg';

import {
  RECEIPT_STREAM_ID,
  computeEntryHash,
  genesisHash,
} from '../src/receipts/chain.js';
import { receiptChainPayload } from '../src/receipts/store.js';
import { checkpointSigningInput, loadCheckpointSigner } from '../src/receipts/checkpoints.js';
import { verifyReceiptStream } from '../src/receipts/verify.js';
import { createProvenanceRoutes } from '../src/receipts/verifyRoutes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIPT = {
  datasetsInterned: 1,
  fieldsMasked: 2,
  fieldsCleartext: 1,
  verbsExecuted: [],
  pseudonymProjectionUsed: false,
};

function makeSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return loadCheckpointSigner(
    privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  );
}

interface Row {
  turn_id: string;
  session_scope: string | null;
  channel: string | null;
  model: string | null;
  receipt: unknown;
  seq: number;
  prev_hash: Buffer;
  entry_hash: Buffer;
  hash_version: number;
  created_at: Date;
}

interface Cp {
  seq: number;
  head_hash: Buffer;
  signed_at: Date;
  signature: Buffer;
  public_key_fingerprint: string;
}

function buildChain(count: number): Row[] {
  const rows: Row[] = [];
  let prev = genesisHash(RECEIPT_STREAM_ID);
  for (let seq = 1; seq <= count; seq++) {
    const turnId = `t-${String(seq)}`;
    const payload = receiptChainPayload({ turnId, sessionScope: 's', receipt: RECEIPT });
    const entryHash = computeEntryHash({ streamId: RECEIPT_STREAM_ID, seq, prevHash: prev, payload });
    rows.push({
      turn_id: turnId,
      session_scope: 's',
      channel: null,
      model: null,
      receipt: RECEIPT,
      seq,
      prev_hash: prev,
      entry_hash: entryHash,
      hash_version: 1,
      created_at: new Date('2026-08-01T00:00:00Z'),
    });
    prev = entryHash;
  }
  return rows;
}

function signCheckpoint(
  signer: ReturnType<typeof makeSigner>,
  seq: number,
  headHash: Buffer,
  signedAt: Date,
): Cp {
  return {
    seq,
    head_hash: headHash,
    signed_at: signedAt,
    signature: edSign(
      null,
      checkpointSigningInput({
        streamId: RECEIPT_STREAM_ID,
        seq,
        headHash,
        signedAtIso: signedAt.toISOString(),
      }),
      signer.privateKey,
    ),
    public_key_fingerprint: signer.publicKeyFingerprint,
  };
}

function fakePool(rows: Row[], checkpoints: Cp[], preChain = 0, headSeq?: number): Pool {
  // Default recorded head = the last stored row (the healthy state).
  const recordedHead = headSeq ?? (rows.length > 0 ? rows[rows.length - 1]!.seq : 0);
  return {
    query: async (sql: string) => {
      if (sql.includes('stream_id IS NULL')) {
        return { rows: [{ n: String(preChain) }], rowCount: 1 };
      }
      if (sql.includes('FROM audit_stream_heads')) {
        return recordedHead > 0
          ? { rows: [{ head_seq: String(recordedHead) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM turn_receipts')) {
        return {
          rows: rows.map((r) => ({ ...r, seq: String(r.seq) })),
          rowCount: rows.length,
        };
      }
      if (sql.includes('FROM audit_checkpoints')) {
        return {
          rows: checkpoints.map((c) => ({ ...c, seq: String(c.seq) })),
          rowCount: checkpoints.length,
        };
      }
      throw new Error(`fakePool: unscripted SQL: ${sql.slice(0, 60)}`);
    },
  } as unknown as Pool;
}

const OPTS = { retentionDays: 90 };

describe('#761 verifyReceiptStream', () => {
  it('a clean chain with a valid checkpoint verifies ok', async () => {
    const signer = makeSigner();
    const rows = buildChain(4);
    const cps = [signCheckpoint(signer, 4, rows[3]!.entry_hash, new Date('2026-08-02T00:00:00Z'))];
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checkedEntries, 4);
    assert.equal(result.checkpoints.verified, 1);
    assert.equal(result.headSeq, 4);
  });

  it('TAMPER: an edited payload reports hash_mismatch at the exact seq', async () => {
    const rows = buildChain(4);
    rows[1]!.receipt = { ...RECEIPT, fieldsMasked: 999 };
    const result = await verifyReceiptStream(fakePool(rows, []), OPTS);
    assert.equal(result.ok, false);
    assert.equal(result.breakKind, 'hash_mismatch');
    assert.equal(result.firstBrokenSeq, 2);
  });

  it('TAMPER: a deleted mid-chain row reports seq_gap', async () => {
    const rows = buildChain(4).filter((r) => r.seq !== 3);
    const result = await verifyReceiptStream(fakePool(rows, []), OPTS);
    assert.equal(result.ok, false);
    assert.equal(result.breakKind, 'seq_gap');
    assert.equal(result.firstBrokenSeq, 4);
  });

  it('TAMPER: a checkpoint whose certified row vanished is an orphan finding', async () => {
    const signer = makeSigner();
    const all = buildChain(4);
    const cps = [signCheckpoint(signer, 2, all[1]!.entry_hash, new Date('2026-08-02T00:00:00Z'))];
    // Rows 3..4 survive; the checkpointed row 2 is gone from the surviving range?
    // Keep 1,3,4 — seq 2 missing INSIDE the range.
    const rows = all.filter((r) => r.seq !== 2);
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, false);
    assert.ok(result.checkpoints.findings.some((f) => f.kind === 'orphaned' && f.seq === 2));
  });

  it('TAMPER: a forged checkpoint signature is a bad_signature finding', async () => {
    const signer = makeSigner();
    const other = makeSigner(); // different key signs the checkpoint
    const rows = buildChain(2);
    const cps = [signCheckpoint(other, 2, rows[1]!.entry_hash, new Date('2026-08-02T00:00:00Z'))];
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, false);
    assert.ok(result.checkpoints.findings.some((f) => f.kind === 'bad_signature'));
  });

  it('retention: an UNALIGNED reaped prefix is anchored by any certifying checkpoint in the suffix', async () => {
    // Review H2 — the reap boundary (seq 2) has NO checkpoint of its own;
    // the checkpoint at seq 4 transitively covers the suffix incl. row 3's
    // back-link. Old semantics called this "unanchored" — permanent false
    // red on every aged install.
    const signer = makeSigner();
    const all = buildChain(5);
    const rows = all.slice(2); // rows 3..5 survive; 1..2 reaped
    const cps = [
      signCheckpoint(signer, 1, all[0]!.entry_hash, new Date('2026-01-01T00:00:00Z')),
      signCheckpoint(signer, 4, all[3]!.entry_hash, new Date('2026-01-02T00:00:00Z')),
    ];
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      now: () => new Date('2026-08-20T00:00:00Z'),
    });
    assert.equal(result.prefix.anchored, true);
    assert.equal(result.prefix.reapedUpToSeq, 2);
    assert.equal(result.prefix.prematureDeletion, undefined, 'seq-1 checkpoint is months old');
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('laundering (sound direction): a reaped row ABOVE a recent checkpoint is premature_deletion', async () => {
    // A checkpoint at seq 1 signed yesterday proves rows ABOVE seq 1 were
    // created after yesterday — deleting seq 2 today cannot be 90-day
    // retention.
    const signer = makeSigner();
    const all = buildChain(5);
    const rows = all.slice(2); // 1..2 reaped
    const cps = [
      signCheckpoint(signer, 1, all[0]!.entry_hash, new Date('2026-08-19T00:00:00Z')),
      signCheckpoint(signer, 5, all[4]!.entry_hash, new Date('2026-08-19T01:00:00Z')),
    ];
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      now: () => new Date('2026-08-20T00:00:00Z'),
    });
    assert.equal(result.ok, false);
    assert.ok(result.prefix.prematureDeletion, JSON.stringify(result));
  });

  it('no false laundering flag when signing was enabled late (no checkpoint below the boundary)', async () => {
    // Review M4's false-positive path: old rows reaped, the only checkpoints
    // sit INSIDE the surviving range — no youth proof exists, no finding.
    const signer = makeSigner();
    const all = buildChain(5);
    const rows = all.slice(2);
    const cps = [signCheckpoint(signer, 5, all[4]!.entry_hash, new Date('2026-08-19T00:00:00Z'))];
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      now: () => new Date('2026-08-20T00:00:00Z'),
    });
    assert.equal(result.prefix.prematureDeletion, undefined);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('WIPE (review H1): zero rows with recorded history is never green', async () => {
    const signer = makeSigner();
    const all = buildChain(3);
    const cps = [signCheckpoint(signer, 3, all[2]!.entry_hash, new Date('2026-08-02T00:00:00Z'))];
    const result = await verifyReceiptStream(fakePool([], cps, 0, 3), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, false);
    assert.equal(result.breakKind, 'empty_chain_with_history');
    assert.equal(result.recordedHeadSeq, 3);
  });

  it('TAIL TRUNCATION: a recorded head beyond the last stored row breaks the verdict', async () => {
    const rows = buildChain(4);
    const result = await verifyReceiptStream(fakePool(rows, [], 0, 6), OPTS);
    assert.equal(result.ok, false);
    assert.equal(result.breakKind, 'head_beyond_rows');
    assert.equal(result.firstBrokenSeq, 5);
  });

  it('an unsupported hash_version is flagged, never a spurious hash_mismatch', async () => {
    const rows = buildChain(2);
    rows[1]!.hash_version = 2;
    const result = await verifyReceiptStream(fakePool(rows, []), OPTS);
    assert.equal(result.ok, false);
    assert.equal(result.breakKind, 'unsupported_hash_version');
    assert.equal(result.firstBrokenSeq, 2);
  });

  it('a truly empty stream (no rows, no head, no checkpoints) is ok with zero entries', async () => {
    const result = await verifyReceiptStream(fakePool([], [], 0, 0), OPTS);
    assert.equal(result.ok, true);
    assert.equal(result.checkedEntries, 0);
  });

  it('pre-chain rows are reported, never verified or broken', async () => {
    const rows = buildChain(2);
    const result = await verifyReceiptStream(fakePool(rows, [], 7), OPTS);
    assert.equal(result.preChainRows, 7);
    assert.equal(result.checkedEntries, 2);
  });
});

describe('#761 export + offline verifier end-to-end', () => {
  const servers: Server[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  async function serveExport(rows: Row[], cps: Cp[], publicKeyPem: string): Promise<string> {
    const app = express();
    app.use(
      '/api/v1/operator/provenance',
      createProvenanceRoutes(fakePool(rows, cps), {
        publicKeyPem,
        publicKeyFingerprint: 'test-fingerprint',
        retentionDays: 90,
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1/operator/provenance/export`);
    assert.equal(res.status, 200);
    return res.text();
  }

  function runOffline(jsonl: string, pubkeyPem?: string): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'audit-export-'));
    const file = join(dir, 'export.jsonl');
    writeFileSync(file, jsonl, 'utf-8');
    const extra: string[] = [];
    if (pubkeyPem) {
      const keyFile = join(dir, 'key.pem');
      writeFileSync(keyFile, pubkeyPem, 'utf-8');
      extra.push('--pubkey', keyFile);
    }
    const out = spawnSync(
      process.execPath,
      [join(HERE, '..', 'scripts', 'verify-audit-export.mjs'), file, ...extra],
      { encoding: 'utf-8', timeout: 60_000 },
    );
    return { status: out.status, out: `${out.stdout}\n${out.stderr}` };
  }

  it('a clean export verifies offline with the out-of-band public key', async () => {
    const signer = makeSigner();
    const rows = buildChain(3);
    const cps = [signCheckpoint(signer, 3, rows[2]!.entry_hash, new Date('2026-08-02T00:00:00Z'))];
    const jsonl = await serveExport(rows, cps, signer.publicKeyPem);
    const result = runOffline(jsonl, signer.publicKeyPem);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /chain verified/);
  });

  it('a tampered export payload fails offline with the exact seq named', async () => {
    const signer = makeSigner();
    const rows = buildChain(3);
    const jsonl = await serveExport(rows, [], signer.publicKeyPem);
    const tampered = jsonl.replace('"fieldsMasked":2', '"fieldsMasked":999');
    assert.notEqual(tampered, jsonl, 'the tamper must actually land');
    const result = runOffline(tampered, signer.publicKeyPem);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /hash_mismatch at seq 1/);
  });

  it('a TRUNCATED export (trailer cut off) refuses to verify (review M5)', async () => {
    const signer = makeSigner();
    const rows = buildChain(3);
    const jsonl = await serveExport(rows, [], signer.publicKeyPem);
    const truncatedAtLineBoundary = jsonl
      .split('\n')
      .filter((l) => !l.includes('"kind":"trailer"'))
      .join('\n');
    const result = runOffline(truncatedAtLineBoundary, signer.publicKeyPem);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /no trailer/);
  });

  it('an export with zero entries refuses to report green', async () => {
    const signer = makeSigner();
    const jsonl = await serveExport([], [], signer.publicKeyPem);
    const result = runOffline(jsonl, signer.publicKeyPem);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /zero chain entries/);
  });

  it('the reader survives the export round-trip: JSONB payloads hash identically', () => {
    // The export writes payload objects; the offline verifier recomputes from
    // the parsed JSON — assert the canonicalization matches chain.ts by
    // recomputing one entry hash both ways.
    const rows = buildChain(1);
    const viaExportShape = JSON.parse(
      JSON.stringify({
        turnId: rows[0]!.turn_id,
        sessionScope: rows[0]!.session_scope,
        channel: rows[0]!.channel,
        model: rows[0]!.model,
        receipt: rows[0]!.receipt,
      }),
    );
    const recomputed = computeEntryHash({
      streamId: RECEIPT_STREAM_ID,
      seq: 1,
      prevHash: rows[0]!.prev_hash,
      payload: viaExportShape,
    });
    assert.ok(recomputed.equals(rows[0]!.entry_hash));
  });
});
