/**
 * #1526 — the receipt chain is walked in NUMERIC seq order against a real
 * Postgres.
 *
 * The bug lived in SQL, so `provenanceVerify.test.ts` (whose fake pool hands
 * rows back pre-sorted) could not see it: the chain queries select
 * `seq::text AS seq` and a bare `ORDER BY seq` binds to that text alias, so
 * Postgres returned 1, 10, 11, 12, 2, … and every chain of ten or more rows
 * reported a false `seq_gap` at seq 10. This suite writes twelve receipts
 * through the real `PgTurnReceiptStore`, signs checkpoints at seq 2 and 12
 * (text order would put "12" before "2"), and checks that both the verifier
 * and the export walk the chain 1 … 12.
 *
 * Runs in its own schema (search_path pinned per connection) on the actual
 * migrations, each applied twice. Skips cleanly when no test Postgres is
 * reachable.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { loadCheckpointSigner, runCheckpointPass } from '../src/receipts/checkpoints.js';
import { PgTurnReceiptStore } from '../src/receipts/store.js';
import { verifyReceiptStream } from '../src/receipts/verify.js';
import { createProvenanceRoutes } from '../src/receipts/verifyRoutes.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'receiptChainOrder',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `receipt_chain_order_${String(process.pid)}`;
const RECEIPT_COUNT = 12;
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

describe('#1526 receipt chain order against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let server: Server | undefined;
  const signer = makeSigner();

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({
      connectionString: PG_URL,
      max: 2,
      options: `-c search_path=${SCHEMA},public`,
    });
    for (const file of [
      '0039_turn_receipts.sql',
      '0041_receipt_hash_chain.sql',
      '0057_turn_receipts_attribution.sql',
    ]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
      await pool.query(sql);
    }

    const store = new PgTurnReceiptStore(pool);
    for (let i = 1; i <= RECEIPT_COUNT; i++) {
      await store.record({ turnId: `t-${String(i)}`, sessionScope: 's', receipt: RECEIPT });
      // Checkpoints at seq 2 and 12: as text, '12' sorts before '2'.
      if (i === 2 || i === RECEIPT_COUNT) {
        const cp = await runCheckpointPass(pool, signer, {});
        assert.equal(cp?.seq, i);
      }
    }
  });

  after(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('verifies an intact chain of more than ten receipts as ok', async () => {
    const result = await verifyReceiptStream(pool, {
      publicKeyPem: signer.publicKeyPem,
      retentionDays: 90,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checkedEntries, RECEIPT_COUNT);
    assert.equal(result.headSeq, RECEIPT_COUNT);
    assert.equal(result.breakKind, undefined);
    assert.equal(result.checkpoints.verified, 2);
  });

  it('exports entries and checkpoints in numeric seq order', async () => {
    const app = express();
    app.use(
      '/api/v1/operator/provenance',
      createProvenanceRoutes(pool, {
        publicKeyPem: signer.publicKeyPem,
        publicKeyFingerprint: signer.publicKeyFingerprint,
        retentionDays: 90,
      }),
    );
    server = await new Promise<Server>((done) => {
      const s = app.listen(0, '127.0.0.1', () => done(s));
    });
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1/operator/provenance/export`);
    assert.equal(res.status, 200);
    const lines = (await res.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; seq?: number });
    const seqsOf = (kind: string): number[] =>
      lines.filter((l) => l.kind === kind).map((l) => l.seq as number);
    assert.deepEqual(
      seqsOf('entry'),
      Array.from({ length: RECEIPT_COUNT }, (_, i) => i + 1),
    );
    assert.deepEqual(seqsOf('checkpoint'), [2, RECEIPT_COUNT]);
  });
});
