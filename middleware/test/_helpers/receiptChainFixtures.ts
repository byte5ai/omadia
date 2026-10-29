/**
 * Shared fixtures for the receipt-chain verification suites (#761, #1565–
 * #1568, #1584): an in-memory chain builder, checkpoint signing, a scripted
 * fake pool, and an export + offline-verifier runner.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { Pool } from 'pg';

import type { AnchorRecord } from '../../src/receipts/anchor.js';
import { RECEIPT_STREAM_ID, computeEntryHash, genesisHash } from '../../src/receipts/chain.js';
import { checkpointSigningInput, loadCheckpointSigner } from '../../src/receipts/checkpoints.js';
import { receiptChainPayload } from '../../src/receipts/store.js';
import { createProvenanceRoutes } from '../../src/receipts/verifyRoutes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECEIPT = {
  datasetsInterned: 1,
  fieldsMasked: 2,
  fieldsCleartext: 1,
  verbsExecuted: [],
  pseudonymProjectionUsed: false,
};

export type Signer = ReturnType<typeof loadCheckpointSigner>;

export function makeSigner(): Signer {
  const { privateKey } = generateKeyPairSync('ed25519');
  return loadCheckpointSigner(
    privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  );
}

export interface Row {
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

export interface Cp {
  seq: number;
  head_hash: Buffer;
  signed_at: Date;
  signature: Buffer;
  public_key_fingerprint: string;
}

export function buildChain(count: number): Row[] {
  const rows: Row[] = [];
  let prev = genesisHash(RECEIPT_STREAM_ID);
  for (let seq = 1; seq <= count; seq++) {
    const turnId = `t-${String(seq)}`;
    const payload = receiptChainPayload({ turnId, sessionScope: 's', receipt: RECEIPT });
    const entryHash = computeEntryHash({
      streamId: RECEIPT_STREAM_ID,
      seq,
      prevHash: prev,
      payload,
    });
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

export function signCheckpoint(signer: Signer, seq: number, headHash: Buffer, signedAt: Date): Cp {
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

/** The anchor line `runCheckpointPass` would have appended for `cp`. */
export function anchorRecordOf(cp: Cp): AnchorRecord {
  return {
    streamId: RECEIPT_STREAM_ID,
    seq: cp.seq,
    headHashHex: cp.head_hash.toString('hex'),
    signedAtIso: cp.signed_at.toISOString(),
    signatureBase64: cp.signature.toString('base64'),
    publicKeyFingerprint: cp.public_key_fingerprint,
  };
}

export function writeAnchorFile(cps: readonly Cp[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'audit-anchor-')), 'anchors.jsonl');
  writeFileSync(path, cps.map((c) => `${JSON.stringify(anchorRecordOf(c))}\n`).join(''), 'utf-8');
  return path;
}

/** Fake pool; default recorded head = the last stored row (healthy state).
 *  Speaks the snapshot protocol (connect/BEGIN/COMMIT) and keyset paging. */
export function fakePool(rows: Row[], checkpoints: Cp[], preChain = 0, headSeq?: number): Pool {
  const recordedHead = headSeq ?? (rows.length > 0 ? rows[rows.length - 1]!.seq : 0);
  const headHash = rows.find((r) => r.seq === recordedHead)?.entry_hash ?? Buffer.alloc(32, 9);
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('stream_id IS NULL')) {
      return { rows: [{ n: String(preChain) }], rowCount: 1 };
    }
    if (sql.includes('FROM audit_stream_heads')) {
      return recordedHead > 0
        ? { rows: [{ head_seq: String(recordedHead), head_hash: headHash }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM turn_receipts')) {
      const after = Number(params[1] ?? 0);
      const limit = Number(params[2] ?? Infinity);
      const page = rows.filter((r) => r.seq > after).slice(0, limit);
      return { rows: page.map((r) => ({ ...r, seq: String(r.seq) })), rowCount: page.length };
    }
    if (sql.includes('FROM audit_checkpoints')) {
      return {
        rows: checkpoints.map((c) => ({ ...c, seq: String(c.seq) })),
        rowCount: checkpoints.length,
      };
    }
    throw new Error(`fakePool: unscripted SQL: ${sql.slice(0, 60)}`);
  };
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;
}

/** Serves the export route over `rows`/`cps`; close via the returned server. */
export async function serveExport(
  rows: Row[],
  cps: Cp[],
  publicKeyPem: string | undefined,
  servers: Server[],
): Promise<string> {
  const app = express();
  app.use(
    '/api/v1/operator/provenance',
    createProvenanceRoutes(fakePool(rows, cps), {
      ...(publicKeyPem ? { publicKeyPem, publicKeyFingerprint: 'test-fingerprint' } : {}),
      retentionDays: 90,
      checkpointIntervalMinutes: 60,
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

/** Runs the zero-dependency offline verifier as an auditor would. */
export function runOffline(
  jsonl: string,
  pubkeyPem?: string,
  anchorPath?: string,
): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-export-'));
  const file = join(dir, 'export.jsonl');
  writeFileSync(file, jsonl, 'utf-8');
  const extra: string[] = [];
  if (pubkeyPem) {
    const keyFile = join(dir, 'key.pem');
    writeFileSync(keyFile, pubkeyPem, 'utf-8');
    extra.push('--pubkey', keyFile);
  }
  if (anchorPath) extra.push('--anchor', anchorPath);
  const out = spawnSync(
    process.execPath,
    [join(HERE, '..', '..', 'scripts', 'verify-audit-export.mjs'), file, ...extra],
    { encoding: 'utf-8', timeout: 60_000 },
  );
  return { status: out.status, out: `${out.stdout}\n${out.stderr}` };
}

/**
 * Fake pool for one checkpoint pass: the head at `headSeq`/`headHash`, the
 * stored receipt at the head (`rowHash`, default = `headHash`; null = no
 * row), and the stored checkpoints. INSERTs append to `checkpoints`.
 */
export function checkpointPool(opts: {
  headSeq: number | undefined;
  headHash: Buffer;
  rowHash?: Buffer | null;
  checkpoints?: Cp[];
  insertLoses?: boolean;
}): { pool: Pool; inserted: unknown[][]; checkpoints: Cp[] } {
  const inserted: unknown[][] = [];
  const checkpoints = [...(opts.checkpoints ?? [])];
  const rowHash = opts.rowHash === undefined ? opts.headHash : opts.rowHash;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM audit_stream_heads')) {
        return opts.headSeq === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ head_seq: String(opts.headSeq), head_hash: opts.headHash }], rowCount: 1 };
      }
      if (sql.includes('SELECT entry_hash FROM turn_receipts')) {
        return rowHash && params[1] === opts.headSeq
          ? { rows: [{ entry_hash: rowHash }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('ORDER BY audit_checkpoints.seq DESC')) {
        const below = params[1] === null ? Infinity : Number(params[1]);
        const page = checkpoints
          .filter((c) => c.seq < below)
          .sort((a, b) => b.seq - a.seq)
          .slice(0, Number(params[2]));
        return { rows: page.map((c) => ({ ...c, seq: String(c.seq) })), rowCount: page.length };
      }
      if (sql.includes('SELECT head_hash FROM audit_checkpoints')) {
        const cp = checkpoints.find((c) => c.seq === params[1]);
        return cp
          ? { rows: [{ head_hash: cp.head_hash }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO audit_checkpoints')) {
        if (opts.insertLoses) return { rows: [], rowCount: 0 };
        inserted.push(params);
        checkpoints.push({
          seq: params[1] as number,
          head_hash: params[2] as Buffer,
          signed_at: new Date(params[3] as string),
          signature: params[4] as Buffer,
          public_key_fingerprint: params[5] as string,
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`checkpointPool: unscripted SQL: ${sql.slice(0, 60)}`);
    },
  } as unknown as Pool;
  return { pool, inserted, checkpoints };
}
