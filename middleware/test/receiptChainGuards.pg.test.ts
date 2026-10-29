/**
 * #1565 / #1566 — the receipt-chain tamper scenarios against a real
 * Postgres: the 0064 guard triggers reject deleting checkpoints and rolling
 * the head back, and when an attacker drops those triggers first (they are
 * defence in depth, not the proof) the verifier still reports the
 * truncation — via orphaned checkpoints and via the external anchor file
 * the real checkpoint worker wrote.
 *
 * Runs in its own schema on the actual migrations, each applied twice.
 * Skips cleanly when no test Postgres is reachable.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';
import { RECEIPT, makeSigner } from './_helpers/receiptChainFixtures.js';

import { readAnchorFile } from '../src/receipts/anchor.js';
import { RECEIPT_STREAM_ID } from '../src/receipts/chain.js';
import { runCheckpointPass } from '../src/receipts/checkpoints.js';
import { PgTurnReceiptStore } from '../src/receipts/store.js';
import { verifyReceiptStream } from '../src/receipts/verify.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'receiptChainGuards',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `receipt_chain_guards_${String(process.pid)}`;

describe('#1565/#1566 receipt chain guards against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const signer = makeSigner();
  const anchorPath = join(mkdtempSync(join(tmpdir(), 'chain-guards-')), 'anchors.jsonl');

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
      '0064_audit_chain_guards.sql',
    ]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
      await pool.query(sql);
    }
    const store = new PgTurnReceiptStore(pool);
    for (let i = 1; i <= 6; i++) {
      await store.record({ turnId: `t-${String(i)}`, sessionScope: 's', receipt: RECEIPT });
      if (i % 2 === 0)
        assert.equal((await runCheckpointPass(pool, signer, { anchorPath }))?.seq, i);
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  const verify = async () =>
    verifyReceiptStream(pool, {
      publicKeyPem: signer.publicKeyPem,
      retentionDays: 90,
      anchor: await readAnchorFile(anchorPath, RECEIPT_STREAM_ID),
    });

  it('the healthy chain verifies, and the anchor matches every checkpoint', async () => {
    const result = await verify();
    assert.equal(result.verdict, 'verified', JSON.stringify(result));
    assert.equal(result.anchor.records, 3);
    assert.equal(result.anchor.matched, 3);
  });

  it('deleting checkpoints and rolling the head back are rejected by the guards', async () => {
    await assert.rejects(pool.query(`DELETE FROM audit_checkpoints`), /append-only/);
    await assert.rejects(
      pool.query(`UPDATE audit_checkpoints SET head_hash = '\\x00'`),
      /append-only/,
    );
    await assert.rejects(
      pool.query(
        `UPDATE audit_stream_heads SET head_seq = head_seq - 2 WHERE stream_id = 'receipts'`,
      ),
      /only moves forward/,
    );
    await assert.rejects(pool.query(`DELETE FROM audit_stream_heads`), /cannot be removed/);
    await assert.rejects(pool.query(`TRUNCATE audit_checkpoints`), /append-only/);
    await assert.rejects(pool.query(`TRUNCATE audit_stream_heads`), /cannot be removed/);
    await assert.rejects(
      pool.query(`UPDATE audit_stream_heads SET head_hash = '\\x00' WHERE stream_id = 'receipts'`),
      /cannot change without head_seq/,
    );
    // Forward moves stay allowed — the store's own append path.
    await new PgTurnReceiptStore(pool).record({
      turnId: 't-7',
      sessionScope: 's',
      receipt: RECEIPT,
    });
    assert.equal((await runCheckpointPass(pool, signer, { anchorPath }))?.seq, 7);
  });

  it('with the guards dropped, deleting the newest receipts + checkpoints is still caught', async () => {
    // The issue's attack, as a superuser who removes the triggers first.
    await pool.query(`DROP TRIGGER audit_checkpoints_append_only ON audit_checkpoints`);
    await pool.query(`DROP TRIGGER audit_stream_heads_no_rollback ON audit_stream_heads`);
    await pool.query(`DROP TRIGGER audit_checkpoints_no_truncate ON audit_checkpoints`);
    await pool.query('BEGIN');
    await pool.query(`DELETE FROM turn_receipts WHERE stream_id = 'receipts' AND seq > 5`);
    await pool.query(
      `UPDATE audit_stream_heads
          SET head_seq = 5,
              head_hash = (SELECT entry_hash FROM turn_receipts WHERE stream_id = 'receipts' AND seq = 5)
        WHERE stream_id = 'receipts'`,
    );
    await pool.query(`DELETE FROM audit_checkpoints WHERE stream_id = 'receipts'`);
    await pool.query('COMMIT');

    // The worker must not launder the rewound head with the real key.
    assert.equal(await runCheckpointPass(pool, signer, { anchorPath }), undefined);

    const result = await verify();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.checkedEntries, 5);
    // The rows are minutes old, so the grace window holds back
    // `no_signed_checkpoint` — the anchor is what proves the deletion here.
    assert.equal(result.checkpoints.awaitingFirstCheckpoint, true);
    const missing = result.anchor.findings
      .filter((f) => f.kind === 'missing_in_db')
      .map((f) => f.seq);
    assert.deepEqual(missing, [2, 4, 6, 7]);
    assert.ok(result.anchor.findings.some((f) => f.kind === 'beyond_head' && f.seq === 7));
  });
});
