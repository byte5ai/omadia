/**
 * S3-E — tamper evidence of the receipt chain: every scenario from #1565,
 * #1566, #1567, #1568 and #1584, run against BOTH the server verifier and
 * the offline verifier on the export of the same chain, so the two can never
 * drift apart again.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Pool } from 'pg';

import { HeadHighWater, parseAnchorJsonl, readAnchorFile } from '../src/receipts/anchor.js';
import { RECEIPT_STREAM_ID } from '../src/receipts/chain.js';
import { runCheckpointPass } from '../src/receipts/checkpoints.js';
import { verifyReceiptStream } from '../src/receipts/verify.js';

import {
  type Cp,
  type Row,
  buildChain,
  fakePool,
  makeSigner,
  runOffline,
  serveExport,
  signCheckpoint,
  writeAnchorFile,
} from './_helpers/receiptChainFixtures.js';

const NOW = () => new Date('2026-10-29T00:00:00Z');
const OPTS = { retentionDays: 90, now: NOW };
const at = (day: number): Date => new Date(Date.UTC(2026, 0, day));

/** A healthy signed chain of `n` rows with a checkpoint every 2 rows and on
 *  the head — the state just before the attacker acts. */
function signedChain(n: number) {
  const signer = makeSigner();
  const rows = buildChain(n);
  const cps: Cp[] = [];
  for (const r of rows) {
    if (r.seq % 2 === 0 || r.seq === n) cps.push(signCheckpoint(signer, r.seq, r.entry_hash, at(r.seq)));
  }
  return { signer, rows, cps };
}

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('#1566 newest receipts deleted + head rolled back (checkpoints kept)', () => {
  const { signer, rows, cps } = signedChain(7);
  const kept = rows.filter((r) => r.seq <= 5); // 6, 7 deleted; head → 5

  it('server: the checkpoints above the last row are orphaned, ok=false', async () => {
    const result = await verifyReceiptStream(fakePool(kept, cps, 0, 5), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.verdict, 'broken');
    assert.equal(result.truncated, false);
    const orphans = result.checkpoints.findings.filter((f) => f.kind === 'orphaned').map((f) => f.seq);
    assert.deepEqual(orphans, [6, 7]);
    assert.equal(result.checkpoints.verified, cps.length - 2, 'orphans are never counted as verified');
  });

  it('offline: the export of the same chain is rejected the same way', async () => {
    const out = runOffline(await serveExport(kept, cps, signer.publicKeyPem, servers), signer.publicKeyPem);
    assert.equal(out.status, 1, out.out);
    assert.match(out.out, /orphaned_checkpoint seq 6/);
    assert.match(out.out, /orphaned_checkpoint seq 7/);
  });

  it('server: a head rolled back below the process high-water mark is head_rollback', async () => {
    const highWater = new HeadHighWater();
    highWater.note(7);
    const result = await verifyReceiptStream(fakePool(kept, [], 0, 5), { ...OPTS, highWater });
    assert.equal(result.ok, false);
    assert.equal(result.breakKind, 'head_rollback');
    assert.equal(result.firstBrokenSeq, 6);
  });
});

describe('#1565 newest receipts AND all checkpoints deleted, head rolled back', () => {
  const { signer, rows, cps } = signedChain(7);
  const kept = rows.filter((r) => r.seq <= 5);

  it('server with a key: no signed checkpoint certifies the chain — never green', async () => {
    const result = await verifyReceiptStream(fakePool(kept, [], 0, 5), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.checkpoints.findings.some((f) => f.kind === 'no_signed_checkpoint'));
  });

  it('offline with the pinned key: no_signed_checkpoint, exit 1', async () => {
    const out = runOffline(await serveExport(kept, [], signer.publicKeyPem, servers), signer.publicKeyPem);
    assert.equal(out.status, 1, out.out);
    assert.match(out.out, /no_signed_checkpoint/);
  });

  it('server: the external anchor still holds the deleted checkpoints → findings', async () => {
    const anchor = await readAnchorFile(writeAnchorFile(cps), RECEIPT_STREAM_ID);
    // The worst case from the issue: the worker has since re-signed the
    // rewound head with the real key, so the DB looks self-consistent.
    const resigned = [signCheckpoint(signer, 5, kept[4]!.entry_hash, at(40))];
    const result = await verifyReceiptStream(fakePool(kept, resigned, 0, 5), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      anchor,
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.anchor.configured, true);
    assert.equal(result.anchor.records, cps.length);
    const kinds = new Set(result.anchor.findings.map((f) => `${f.kind}@${String(f.seq)}`));
    for (const seq of [2, 4, 6, 7]) assert.ok(kinds.has(`missing_in_db@${String(seq)}`), [...kinds].join());
    assert.ok(kinds.has('beyond_head@6') && kinds.has('beyond_head@7'));
  });

  it('offline with --anchor: the anchor file proves the truncation, exit 1', async () => {
    const resigned = [signCheckpoint(signer, 5, kept[4]!.entry_hash, at(40))];
    const jsonl = await serveExport(kept, resigned, signer.publicKeyPem, servers);
    // Without the anchor the export is self-consistent — exactly why the
    // docs now require comparing it.
    assert.equal(runOffline(jsonl, signer.publicKeyPem).status, 0);
    const out = runOffline(jsonl, signer.publicKeyPem, writeAnchorFile(cps));
    assert.equal(out.status, 1, out.out);
    assert.match(out.out, /anchor_beyond_export: the anchor certifies seq 7 but the export ends at 5/);
    assert.match(out.out, /anchor_checkpoint_missing: anchored checkpoint seq 6/);
  });

  it('the checkpoint worker refuses to re-sign a head below the anchor', async () => {
    const { pool, inserted } = checkpointPool(5, kept[4]!.entry_hash, undefined);
    const record = await runCheckpointPass(pool, signer, { anchorPath: writeAnchorFile(cps) });
    assert.equal(record, undefined);
    assert.equal(inserted.length, 0, 'the rewound head must not get a valid signature');
  });

  it('the checkpoint worker refuses to re-sign a head below the process high-water mark', async () => {
    const highWater = new HeadHighWater();
    highWater.note(7);
    const { pool, inserted } = checkpointPool(5, kept[4]!.entry_hash, undefined);
    assert.equal(await runCheckpointPass(pool, signer, { highWater }), undefined);
    assert.equal(inserted.length, 0);
  });

  it('a healthy worker pass still signs and raises the high-water mark', async () => {
    const highWater = new HeadHighWater();
    const anchorPath = writeAnchorFile(cps.filter((c) => c.seq <= 4));
    const { pool, inserted } = checkpointPool(7, rows[6]!.entry_hash, 4);
    const record = await runCheckpointPass(pool, signer, { anchorPath, highWater });
    assert.equal(record?.seq, 7);
    assert.equal(inserted.length, 1);
    assert.equal(highWater.value, 7);
    const appended = parseAnchorJsonl(readFileSync(anchorPath, 'utf-8'), RECEIPT_STREAM_ID);
    assert.deepEqual(appended.records.map((r) => r.seq), [2, 4, 7]);
  });
});

describe('#1565 external anchor comparison on a healthy chain', () => {
  const { signer, rows, cps } = signedChain(6);

  it('every anchored checkpoint matches → verified, no anchor findings', async () => {
    const anchor = await readAnchorFile(writeAnchorFile(cps), RECEIPT_STREAM_ID);
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      anchor,
    });
    assert.equal(result.verdict, 'verified', JSON.stringify(result));
    assert.equal(result.anchor.matched, cps.length);
    const out = runOffline(
      await serveExport(rows, cps, signer.publicKeyPem, servers),
      signer.publicKeyPem,
      writeAnchorFile(cps),
    );
    assert.equal(out.status, 0, out.out);
    assert.match(out.out, new RegExp(`anchor: +${String(cps.length)} records, ${String(cps.length)} match`));
  });

  it('a DB checkpoint missing from the anchor is not a finding (append is best-effort)', async () => {
    const anchor = await readAnchorFile(writeAnchorFile(cps.slice(0, 1)), RECEIPT_STREAM_ID);
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      anchor,
    });
    assert.equal(result.verdict, 'verified', JSON.stringify(result));
  });

  it('a missing anchor file is reported as status, not as tamper evidence', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'no-anchor-')), 'absent.jsonl');
    const anchor = await readAnchorFile(path, RECEIPT_STREAM_ID);
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      anchor,
    });
    assert.equal(result.anchor.status, 'missing');
    assert.equal(result.verdict, 'verified');
  });

  it('a checkpoint rewritten in the DB disagrees with the anchor → mismatch', async () => {
    const anchor = await readAnchorFile(writeAnchorFile(cps), RECEIPT_STREAM_ID);
    const forged = cps.map((c) => (c.seq === 2 ? { ...c, head_hash: Buffer.alloc(32, 7) } : c));
    const result = await verifyReceiptStream(fakePool(rows, forged), { ...OPTS, anchor });
    assert.equal(result.ok, false);
    assert.ok(result.anchor.findings.some((f) => f.kind === 'mismatch' && f.seq === 2));
  });

  it('an anchor line that does not verify with the key is a bad_signature finding', async () => {
    const other = makeSigner();
    const anchor = await readAnchorFile(
      writeAnchorFile([signCheckpoint(other, 6, rows[5]!.entry_hash, at(6))]),
      RECEIPT_STREAM_ID,
    );
    const result = await verifyReceiptStream(fakePool(rows, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
      anchor,
    });
    assert.ok(result.anchor.findings.some((f) => f.kind === 'bad_signature'));
    assert.equal(result.ok, false);
  });
});

describe('#1567 retention with a signing key: server and offline agree', () => {
  it('an unaligned reaped prefix is anchored by a certifying checkpoint — both green', async () => {
    const { signer, rows, cps } = signedChain(9);
    // Reap 1..3 — no checkpoint sits at seq 3; checkpoints at 4, 6, 8, 9
    // survive in the suffix.
    const survivors = rows.filter((r) => r.seq > 3);
    const result = await verifyReceiptStream(fakePool(survivors, cps), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.verdict, 'verified', JSON.stringify(result));
    assert.equal(result.prefix.anchored, true);
    assert.equal(result.prefix.reapedUpToSeq, 3);
    const out = runOffline(await serveExport(survivors, cps, signer.publicKeyPem, servers), signer.publicKeyPem);
    assert.equal(out.status, 0, out.out);
    assert.doesNotMatch(out.out, /unanchored_prefix/);
    assert.match(out.out, /rows 1\.\.3 removed by retention — anchored/);
  });

  it('a reaped prefix with no certifying checkpoint stays broken on both sides', async () => {
    const { signer, rows, cps } = signedChain(5);
    const survivors = rows.filter((r) => r.seq > 2);
    const belowOnly = cps.filter((c) => c.seq <= 2);
    const result = await verifyReceiptStream(fakePool(survivors, belowOnly), {
      ...OPTS,
      publicKeyPem: signer.publicKeyPem,
    });
    assert.equal(result.ok, false);
    assert.equal(result.prefix.anchored, false);
    assert.equal(result.prefix.unanchoredReason, undefined);
    const out = runOffline(await serveExport(survivors, belowOnly, signer.publicKeyPem, servers), signer.publicKeyPem);
    assert.equal(out.status, 1, out.out);
    assert.match(out.out, /unanchored_prefix: rows 1\.\.2/);
  });
});

describe('#1568 retention without a signing key', () => {
  const rows = buildChain(8);
  const survivors = rows.filter((r) => r.seq > 3);

  it('server: the reaped prefix is unsigned information, ok stays true, never "verified"', async () => {
    const result = await verifyReceiptStream(fakePool(survivors, []), OPTS);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verdict, 'unsigned');
    assert.equal(result.prefix.anchored, false);
    assert.equal(result.prefix.unanchoredReason, 'no_signing_key');
    assert.equal(result.breakKind, undefined);
  });

  it('offline: no unanchored_prefix failure — UNSIGNED, exit 3', async () => {
    const out = runOffline(await serveExport(survivors, [], undefined, servers));
    assert.equal(out.status, 3, out.out);
    assert.match(out.out, /NOT anchored: no signing key/);
    assert.match(out.out, /UNSIGNED/);
    assert.doesNotMatch(out.out, /chain verified/);
  });

  it('a real break inside the surviving rows is still BROKEN on both sides', async () => {
    const tampered: Row[] = survivors.map((r) =>
      r.seq === 6 ? { ...r, receipt: { ...(r.receipt as object), fieldsMasked: 999 } } : r,
    );
    const result = await verifyReceiptStream(fakePool(tampered, []), OPTS);
    assert.equal(result.verdict, 'broken');
    assert.equal(result.breakKind, 'hash_mismatch');
    const out = runOffline(await serveExport(tampered, [], undefined, servers));
    assert.equal(out.status, 1, out.out);
    assert.match(out.out, /hash_mismatch at seq 6/);
  });

  it('the reaper keeps the newest checkpointed row and degrades to age-only without checkpoints', async () => {
    const { startTurnReceiptReaper } = await import('../src/receipts/store.js');
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const reaper = startTurnReceiptReaper(pool, { retentionDays: 30, intervalMs: 60_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(queries[0] ?? '', /seq < COALESCE\(\s*\(SELECT MAX\(seq\) FROM audit_checkpoints[^)]*\),\s*seq \+ 1\)/);
    } finally {
      reaper.stop();
    }
  });
});

describe('#1584 checkpoint counts without a signing key', () => {
  it('checkpoints present but no key: verified 0, all unchecked, verdict unsigned', async () => {
    const { rows, cps } = signedChain(6);
    const result = await verifyReceiptStream(fakePool(rows, cps), OPTS);
    assert.equal(result.checkpoints.total, cps.length);
    assert.equal(result.checkpoints.verified, 0);
    assert.equal(result.checkpoints.unchecked, cps.length);
    assert.equal(result.checkpoints.signaturesChecked, false);
    assert.equal(result.verdict, 'unsigned');
    assert.equal(result.ok, true);
  });

  it('a reaped checkpoint row without a key is not counted as verified either', async () => {
    const { rows, cps } = signedChain(6);
    const result = await verifyReceiptStream(fakePool(rows.filter((r) => r.seq > 2), cps), OPTS);
    assert.equal(result.checkpoints.verified, 0);
    assert.equal(result.prefix.unanchoredReason, 'no_signing_key');
  });

  it('without a key the row comparison still runs: an orphaned checkpoint is still a finding', async () => {
    const { rows, cps } = signedChain(6);
    const result = await verifyReceiptStream(fakePool(rows.filter((r) => r.seq <= 4), cps, 0, 4), OPTS);
    assert.equal(result.verdict, 'broken');
    assert.ok(result.checkpoints.findings.some((f) => f.kind === 'orphaned' && f.seq === 6));
  });

  it('offline without a key prints no verified count', async () => {
    const { rows, cps } = signedChain(4);
    const out = runOffline(await serveExport(rows, cps, undefined, servers));
    assert.equal(out.status, 3, out.out);
    assert.match(out.out, /signatures NOT checked — no key/);
  });
});

describe('anchor parsing', () => {
  it('skips other streams and reports malformed lines by number', () => {
    const { records, malformedLines } = parseAnchorJsonl(
      [
        JSON.stringify({ streamId: 'other', seq: 1, headHashHex: 'a'.repeat(64), signedAtIso: 'x', signatureBase64: 'x', publicKeyFingerprint: 'f' }),
        '{not json',
        JSON.stringify({ streamId: RECEIPT_STREAM_ID, seq: 'two' }),
        JSON.stringify({ streamId: RECEIPT_STREAM_ID, seq: 2, headHashHex: 'b'.repeat(64), signedAtIso: 'x', signatureBase64: 'x', publicKeyFingerprint: 'f' }),
        '',
      ].join('\n'),
      RECEIPT_STREAM_ID,
    );
    assert.deepEqual(records.map((r) => r.seq), [2]);
    assert.deepEqual(malformedLines, [2, 3]);
  });
});

/** Fake pool for one checkpoint pass: head at `headSeq`, newest DB
 *  checkpoint at `lastCp` (undefined = none). */
function checkpointPool(
  headSeq: number,
  headHash: Buffer,
  lastCp: number | undefined,
): { pool: Pool; inserted: unknown[][] } {
  const inserted: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM audit_stream_heads')) {
        return { rows: [{ head_seq: String(headSeq), head_hash: headHash }], rowCount: 1 };
      }
      if (sql.includes('MAX(seq)')) {
        return { rows: [{ seq: lastCp === undefined ? null : String(lastCp) }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_checkpoints')) {
        inserted.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`checkpointPool: unscripted SQL: ${sql.slice(0, 60)}`);
    },
  } as unknown as Pool;
  return { pool, inserted };
}
