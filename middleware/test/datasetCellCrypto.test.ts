/**
 * Dataset cells encrypted at rest — real values for the entitled user, a
 * digest for the model (see `datasetCellCrypto.ts`).
 *
 * Covers the primitive, the import pipeline (flagged cells → `enc1:`, sample
 * stays a surrogate, no key ⇒ legacy masking), the two read paths
 * (`query_dataset` reveals only behind a privacy handle and re-masks
 * otherwise; the owner's REST row preview decrypts), and the contract with
 * the v4 layer end to end: interned real values classify as masked (incl. a
 * digits-only phone column via the C0 booster), the digest carries no value,
 * the materializer renders the real e-mail.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { baselineHasIdentityPii } from '@omadia/plugin-privacy-guard';
import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { materialize } from '@omadia/plugin-privacy-guard/dist/v4/materializer.js';

import {
  ENCRYPTED_CELL_PREFIX,
  UNAVAILABLE_CELL,
  decryptCell,
  decryptRows,
  encryptCell,
  isEncryptedCell,
  resolveDatasetCellKey,
} from '../packages/harness-orchestrator/src/datasetCellCrypto.js';
import { LINK_KEY_SECRET_ENV } from '../packages/harness-orchestrator/src/datasetLinkKey.js';
import { buildDatasetFromCsv } from '../packages/harness-orchestrator/src/datasetImport.js';
import { importTabularDataset } from '../packages/harness-orchestrator/src/datasetImportTabular.js';
import { QueryDatasetTool } from '../packages/harness-orchestrator/src/tools/queryDatasetTool.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type { PrivacyTurnHandle } from '../packages/harness-orchestrator/src/privacyHandle.js';
import { createDatasetsRouter } from '../src/routes/datasets.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const KEY = { key: resolveDatasetCellKey({ [LINK_KEY_SECRET_ENV]: SECRET.toString('utf8') })!, ownerOmadiaUserId: 'user-1' };

const CSV =
  'Name,E-Mail,Telefon,Stadt\n' +
  'Anna Schmidt,anna@example.com,01701234567,Berlin\n' +
  'Bernd Meier,bernd@example.com,01709876543,Hamburg\n' +
  'Clara Voss,,,Berlin\n';

describe('cell crypto primitive', () => {
  it('round-trips and marks the token', () => {
    const t = encryptCell(KEY, 'E-Mail', 'anna@example.com');
    assert.ok(isEncryptedCell(t));
    assert.ok(t.startsWith(ENCRYPTED_CELL_PREFIX));
    assert.ok(!t.includes('anna'), 'ciphertext must not contain the plaintext');
    assert.equal(decryptCell(KEY, 'E-Mail', t), 'anna@example.com');
  });

  it('uses a fresh IV per cell — equal plaintexts do not produce equal tokens', () => {
    assert.notEqual(encryptCell(KEY, 'E-Mail', 'x@y.z'), encryptCell(KEY, 'E-Mail', 'x@y.z'));
  });

  it('is bound to owner and column (AAD) and detects tampering', () => {
    const t = encryptCell(KEY, 'E-Mail', 'anna@example.com');
    assert.equal(decryptCell({ ...KEY, ownerOmadiaUserId: 'user-2' }, 'E-Mail', t), undefined);
    assert.equal(decryptCell(KEY, 'Telefon', t), undefined);
    const body = t.slice(ENCRYPTED_CELL_PREFIX.length);
    const flipped = body.slice(0, -2) + (body.endsWith('A') ? 'BB' : 'AA');
    assert.equal(decryptCell(KEY, 'E-Mail', `${ENCRYPTED_CELL_PREFIX}${flipped}`), undefined);
    assert.equal(decryptCell(KEY, 'E-Mail', 'enc1:tooshort'), undefined);
    assert.equal(decryptCell(KEY, 'E-Mail', 'plain'), undefined);
  });

  it('decryptRows: decrypts, passes non-encrypted cells through, marks unreadable ones, never mutates', () => {
    const rows = [
      { a: encryptCell(KEY, 'a', 'real'), b: 'clear', n: 1 },
      { a: 'legacy-surrogate', b: 'x', n: 2 },
    ];
    const out = decryptRows(KEY, rows);
    assert.deepEqual(out[0], { a: 'real', b: 'clear', n: 1 });
    assert.equal(out[1], rows[1], 'a row without encrypted cells is returned as-is');
    assert.ok(isEncryptedCell(rows[0]!.a), 'input untouched');
    const other = decryptRows({ key: randomBytes(32), ownerOmadiaUserId: 'user-1' }, rows);
    assert.equal(other[0]!.a, UNAVAILABLE_CELL);
    assert.equal(decryptRows(undefined, rows)[0]!.a, UNAVAILABLE_CELL);
  });

  it('derives the cell key from the same secret as link keys, under its own label', () => {
    const env = { [LINK_KEY_SECRET_ENV]: SECRET.toString('utf8') };
    const k = resolveDatasetCellKey(env)!;
    assert.equal(k.length, 32);
    assert.equal(k.equals(SECRET), false, 'never the raw secret');
    assert.equal(resolveDatasetCellKey({}), undefined);
  });
});

describe('buildDatasetFromCsv — encryption at rest', () => {
  it('stores flagged cells encrypted, others in clear, sample stays a surrogate', async () => {
    const r = await buildDatasetFromCsv(Buffer.from(CSV, 'utf8'), { cellKey: KEY });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.privacyScan.encryptedAtRest, true);
    assert.equal(r.privacyScan.maskedCells, 4, 'two e-mails + two phones');
    const [row1, , row3] = r.rows;
    assert.ok(isEncryptedCell(row1!['E-Mail']));
    assert.ok(isEncryptedCell(row1!['Telefon']));
    assert.equal(decryptCell(KEY, 'E-Mail', row1!['E-Mail'] as string), 'anna@example.com');
    assert.equal(row1!['Name'], 'Anna Schmidt', 'C0 does not flag names — stored in clear as before');
    assert.equal(row1!['Stadt'], 'Berlin');
    assert.equal(row3!['E-Mail'], '', 'blank cells are not encrypted');
    const sample = String(r.columns.find((c) => c.name === 'E-Mail')!.sample);
    assert.ok(!sample.startsWith(ENCRYPTED_CELL_PREFIX), 'sample is display-safe');
    assert.ok(sample.includes('@'), 'sample is the masked surrogate, not a ciphertext');
    assert.notEqual(sample, 'anna@example.com');
  });

  it('without a cell key masks irreversibly, exactly as before', async () => {
    const r = await buildDatasetFromCsv(Buffer.from(CSV, 'utf8'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.privacyScan.encryptedAtRest, false);
    const email = r.rows[0]!['E-Mail'] as string;
    assert.ok(!isEncryptedCell(email));
    assert.notEqual(email, 'anna@example.com');
  });
});

function withSession(userId: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as unknown as { session?: unknown }).session = { omadia_user_id: userId };
    next();
  };
}

describe('read paths', () => {
  const graph = new InMemoryKnowledgeGraph();
  let datasetId = '';
  let server: Server | undefined;
  let baseUrl = '';
  const savedEnv = process.env[LINK_KEY_SECRET_ENV];

  before(async () => {
    // The tool and the route resolve the key from the environment.
    process.env[LINK_KEY_SECRET_ENV] = SECRET.toString('utf8');
    const imported = await importTabularDataset({
      graph,
      bytes: Buffer.from(CSV, 'utf8'),
      datasetName: 'Kontakte',
      sourceFileName: 'k.csv',
      ownerOmadiaUserId: 'user-1',
      format: 'csv',
      linkKeySecret: SECRET,
    });
    assert.equal(imported.ok, true);
    if (!imported.ok) throw new Error('import failed');
    datasetId = imported.imported[0]!.result.datasetId;
    assert.equal(imported.imported[0]!.privacyScan.encryptedAtRest, true);

    const app = express();
    app.use('/api/v1/datasets', withSession('user-1'), createDatasetsRouter({ graph }));
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/datasets`;
  });

  after(async () => {
    if (savedEnv === undefined) delete process.env[LINK_KEY_SECRET_ENV];
    else process.env[LINK_KEY_SECRET_ENV] = savedEnv;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  function asUser(privacyHandle: PrivacyTurnHandle | undefined, fn: () => Promise<string>) {
    return turnContext.run(
      {
        turnId: 't',
        turnDate: '2026-01-01',
        userId: 'user-1',
        resolvedOmadiaUserId: 'user-1',
        ...(privacyHandle ? { privacyHandle } : {}),
      },
      fn,
    );
  }

  it('query_dataset behind a privacy handle returns REAL values (they are about to be interned)', async () => {
    const tool = new QueryDatasetTool(graph);
    const out = await asUser({} as unknown as PrivacyTurnHandle, () =>
      tool.handle({ query: 'query_rows', dataset_id: datasetId, limit: 10 }),
    );
    const parsed = JSON.parse(out) as { rows: Array<Record<string, unknown>> };
    assert.equal(parsed.rows[0]!['E-Mail'], 'anna@example.com');
    assert.equal(parsed.rows[1]!['Telefon'], '01709876543');
    assert.ok(!out.includes(ENCRYPTED_CELL_PREFIX));
  });

  it('query_dataset WITHOUT a privacy handle re-masks on read — distinct surrogates, no real value, no ciphertext', async () => {
    const tool = new QueryDatasetTool(graph);
    const out = await asUser(undefined, () =>
      tool.handle({ query: 'query_rows', dataset_id: datasetId, limit: 10 }),
    );
    assert.ok(!out.includes('anna@example.com'));
    assert.ok(!out.includes('01709876543'));
    assert.ok(!out.includes(ENCRYPTED_CELL_PREFIX));
    const parsed = JSON.parse(out) as { rows: Array<Record<string, unknown>> };
    const a = parsed.rows[0]!['E-Mail'] as string;
    const b = parsed.rows[1]!['E-Mail'] as string;
    assert.ok(a.includes('@') && b.includes('@'));
    assert.notEqual(a, b, 'one pseudonym map across the page: two people, two surrogates');
  });

  it('the owner\'s REST row preview is decrypted', async () => {
    const res = await fetch(`${baseUrl}/${datasetId}/rows`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    assert.equal(body.rows[0]!['E-Mail'], 'anna@example.com');
  });

  it('end to end: interned real values classify masked (phone via C0 booster), digest is value-free, render shows the real e-mail', async () => {
    const tool = new QueryDatasetTool(graph);
    const out = await asUser({} as unknown as PrivacyTurnHandle, () =>
      tool.handle({ query: 'query_rows', dataset_id: datasetId, limit: 10 }),
    );
    // Exactly the service's store configuration since this change.
    const classify = createShapeClassifier({ detector: baselineHasIdentityPii });
    const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
    const { datasetId: v4Id, digest } = store.internToolResult('query_dataset', out);

    const field = (p: string) => store.get(v4Id)!.schema.fields.find((f) => f.path === p)!;
    assert.equal(field('E-Mail').classification, 'sensitive-masked');
    assert.equal(field('Telefon').classification, 'sensitive-masked', 'digits-only phones must not clear as an id handle');
    assert.equal(field('Name').classification, 'sensitive-masked');
    assert.equal(field('__k_E-Mail').classification, 'safe-cleartext');
    const digestText = JSON.stringify(digest);
    assert.ok(!digestText.includes('anna@example.com'));
    assert.ok(!digestText.includes('01701234567'));
    assert.ok(!digestText.includes('Anna Schmidt'));

    const rendered = materialize(store, {
      datasetId: v4Id,
      columns: [{ field: 'Name', label: 'Name' }, { field: 'E-Mail', label: 'E-Mail' }],
      format: 'table',
    });
    assert.ok(rendered.text.includes('anna@example.com'), 'the entitled user sees the real value');
    assert.ok(rendered.text.includes('bernd@example.com'));
    assert.ok(!rendered.text.includes('lukas.becker@example.net'), 'no identical decoy surrogates');
  });

  it('the identity booster leaves date and amount columns safe (they must stay filterable), masks phones', () => {
    const classify = createShapeClassifier({ detector: baselineHasIdentityPii });
    const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
    const rows = Array.from({ length: 30 }, (_, i) => ({
      invoice_date: `2026-0${String((i % 9) + 1)}-1${String(i % 9)}`,
      amount_text: `${String(100 + i)},00 €`,
      phone: `0170${String(1000000 + i)}`,
      id: String(4000 + i),
    }));
    const { datasetId } = store.internToolResult('odoo.invoices', rows);
    const f = (p: string) => store.get(datasetId)!.schema.fields.find((x) => x.path === p)!;
    assert.equal(f('invoice_date').classification, 'safe-cleartext');
    assert.equal(f('invoice_date').type, 'date');
    assert.equal(f('id').classification, 'safe-cleartext', 'a short numeric id keeps its handle role');
    assert.equal(f('phone').classification, 'sensitive-masked');
    // `amount_text` carries `€` and a comma — not token-shaped anyway; the
    // point is that the booster's `amount` type does not force-mask a column
    // the shape classifier would otherwise clear.
    assert.equal(baselineHasIdentityPii('2026-03-14'), false);
    assert.equal(baselineHasIdentityPii('1.234,56 €'), false);
    assert.equal(baselineHasIdentityPii('01701234567'), true);
    assert.equal(baselineHasIdentityPii('anna@example.com'), true);
  });
});
