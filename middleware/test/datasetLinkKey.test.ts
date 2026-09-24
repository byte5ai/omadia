/**
 * Dataset link keys — the per-column `__k_*` keys that make two uploads of
 * the same people joinable/de-duplicable without ever holding a cleartext
 * identity (see `datasetLinkKey.ts` for the why).
 *
 * Covers the keyer's properties (stable, per-user, token-shaped, tolerant),
 * secret resolution, the import pipeline writing the columns, and the
 * end-to-end contract with the privacy-guard v4 layer: an imported key
 * column classifies `safe-cleartext` and is accepted by `distinct`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { hkdfSync, randomBytes } from 'node:crypto';


import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { createVerbEngine } from '@omadia/plugin-privacy-guard/dist/v4/verbs/index.js';

import {
  LINK_KEY_LENGTH,
  LINK_KEY_SECRET_ENV,
  MIN_SECRET_CHARS,
  VAULT_KEY_ENV,
  createDatasetLinkKeyer,
  ensureTokenShaped,
  isLinkKeyColumn,
  linkKeyColumnName,
  normalizeLinkValue,
  resolveDatasetLinkKeySecret,
} from '../packages/harness-orchestrator/src/datasetLinkKey.js';
import { buildDatasetFromCsv } from '../packages/harness-orchestrator/src/datasetImport.js';
import { importTabularDataset } from '../packages/harness-orchestrator/src/datasetImportTabular.js';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const TOKEN = new RegExp(`^[0-9a-f]{${String(LINK_KEY_LENGTH)}}$`);

describe('createDatasetLinkKeyer', () => {
  const key = createDatasetLinkKeyer({ secret: SECRET, ownerOmadiaUserId: 'user-1' });

  it('is stable: the same value keys identically every time', () => {
    assert.equal(key('Anna Schmidt'), key('Anna Schmidt'));
  });

  it('is tolerant: case, surrounding and inner whitespace, NFKC forms', () => {
    const base = key('Anna Schmidt');
    assert.equal(key('anna schmidt'), base);
    assert.equal(key('  Anna   Schmidt '), base);
    assert.equal(key('Anna Schmidt'), base, 'NBSP folds to a space');
    assert.equal(key('Ａnna Schmidt'), base, 'fullwidth A folds via NFKC');
  });

  it('separates different values and different users', () => {
    assert.notEqual(key('Anna Schmidt'), key('Anna Schmitt'));
    const other = createDatasetLinkKeyer({ secret: SECRET, ownerOmadiaUserId: 'user-2' });
    assert.notEqual(key('Anna Schmidt'), other('Anna Schmidt'));
  });

  it('depends on the secret', () => {
    const other = createDatasetLinkKeyer({
      secret: Buffer.from('another-secret-another-secret!!', 'utf8'),
      ownerOmadiaUserId: 'user-1',
    });
    assert.notEqual(key('Anna Schmidt'), other('Anna Schmidt'));
  });

  it('returns null for a blank cell', () => {
    assert.equal(key(''), null);
    assert.equal(key('   '), null);
  });

  it('every key is a fixed-length hex token carrying a digit (v4 S5 shape)', () => {
    // Enough values that an all-letter 16-hex prefix would be expected to
    // appear a few times without the digit guarantee: (6/16)^16 ≈ 2e-7 per
    // value is rare, so also probe the guarantee directly below.
    for (let i = 0; i < 5000; i++) {
      const k = key(`value-${String(i)}`);
      assert.ok(k !== null && TOKEN.test(k), `bad token ${String(k)}`);
      assert.match(k, /\d/);
      assert.equal(/\s/.test(k), false);
    }
  });

  it('forces a digit into a key whose hex prefix happens to be all letters', () => {
    // An all-letter 16-hex prefix (≈ 2e-7 per value) would make the whole
    // column fall out of the v4 S5 `id` rule and get masked — so the digit
    // is borrowed deterministically from the next hash byte.
    const allLetters = 'abcdefabcdefabcd' + 'a7' + 'ff'.repeat(23);
    const k = ensureTokenShaped(allLetters);
    assert.equal(k.length, LINK_KEY_LENGTH);
    assert.equal(k, 'abcdefabcdefabc7', '0xa7 = 167 → 167 % 10 = 7 in the last slot');
    // A prefix that already carries a digit is left untouched.
    const withDigit = '0bcdefabcdefabcd' + 'ff'.repeat(24);
    assert.equal(ensureTokenShaped(withDigit), '0bcdefabcdefabcd');
    // Both stay the same shape under normalisation of the input value.
    assert.equal(normalizeLinkValue('  A  b '), 'a b');
  });

  it('rejects an empty secret or owner', () => {
    assert.throws(() =>
      createDatasetLinkKeyer({ secret: Buffer.alloc(0), ownerOmadiaUserId: 'u' }),
    );
    assert.throws(() => createDatasetLinkKeyer({ secret: SECRET, ownerOmadiaUserId: '' }));
  });
});

describe('link-key column naming', () => {
  it('prefixes with __k_ and recognises its own columns', () => {
    assert.equal(linkKeyColumnName('E-Mail'), '__k_E-Mail');
    assert.equal(isLinkKeyColumn('__k_E-Mail'), true);
    assert.equal(isLinkKeyColumn('E-Mail'), false);
  });
});

describe('resolveDatasetLinkKeySecret', () => {
  it('uses the explicit secret verbatim', () => {
    const s = resolveDatasetLinkKeySecret({ [LINK_KEY_SECRET_ENV]: 'x'.repeat(MIN_SECRET_CHARS) });
    assert.ok(s);
    assert.equal(s.toString('utf8'), 'x'.repeat(MIN_SECRET_CHARS));
  });

  it('rejects a too-short explicit secret instead of accepting a guessable key', () => {
    assert.throws(() => resolveDatasetLinkKeySecret({ [LINK_KEY_SECRET_ENV]: 'short' }));
  });

  it('derives from VAULT_KEY via HKDF with a fixed label when no explicit secret is set', () => {
    const ikm = randomBytes(32);
    const s = resolveDatasetLinkKeySecret({ [VAULT_KEY_ENV]: ikm.toString('base64') });
    assert.ok(s);
    const expected = Buffer.from(
      hkdfSync('sha256', ikm, Buffer.alloc(0), 'omadia/dataset-link-key/v1', 32),
    );
    assert.ok(s.equals(expected));
    assert.equal(s.equals(ikm), false, 'the vault key itself is never used raw');
  });

  it('explicit secret wins over VAULT_KEY', () => {
    const s = resolveDatasetLinkKeySecret({
      [LINK_KEY_SECRET_ENV]: 'y'.repeat(MIN_SECRET_CHARS),
      [VAULT_KEY_ENV]: randomBytes(32).toString('base64'),
    });
    assert.equal(s?.toString('utf8'), 'y'.repeat(MIN_SECRET_CHARS));
  });

  it('is undefined when neither variable is set (or VAULT_KEY is empty)', () => {
    assert.equal(resolveDatasetLinkKeySecret({}), undefined);
    assert.equal(resolveDatasetLinkKeySecret({ [VAULT_KEY_ENV]: '' }), undefined);
  });
});

describe('buildDatasetFromCsv — link-key columns', () => {
  const csv =
    'Name,E-Mail,Alter,Status\n' +
    'Anna Schmidt,anna@example.com,34,aktiv\n' +
    'anna  schmidt,ANNA@example.com,34,aktiv\n' +
    ',,,aktiv\n';
  const linkKey = createDatasetLinkKeyer({ secret: SECRET, ownerOmadiaUserId: 'user-1' });

  it('writes no key columns when no keyer is supplied (byte-identical legacy output)', async () => {
    const r = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.columns.map((c) => c.name), ['Name', 'E-Mail', 'Alter', 'Status']);
    assert.deepEqual(r.linkKeys.columns, []);
    assert.equal(Object.keys(r.rows[0]!).some(isLinkKeyColumn), false);
  });

  it('adds a __k_ column right after every string column, none for number columns', async () => {
    const r = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'), { linkKey });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(
      r.columns.map((c) => c.name),
      ['Name', '__k_Name', 'E-Mail', '__k_E-Mail', 'Alter', 'Status', '__k_Status'],
    );
    assert.deepEqual(r.linkKeys.columns, ['__k_Name', '__k_E-Mail', '__k_Status']);
    for (const c of r.columns.filter((x) => isLinkKeyColumn(x.name))) {
      assert.equal(c.type, 'string');
    }
  });

  it('keys the RAW value, so two spellings of one person share a key while the e-mail is masked', async () => {
    const r = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'), { linkKey });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const [row1, row2, row3] = r.rows as Array<Record<string, unknown>>;
    assert.equal(row1!['__k_Name'], row2!['__k_Name']);
    assert.equal(row1!['__k_E-Mail'], row2!['__k_E-Mail']);
    assert.equal(row1!['__k_E-Mail'], linkKey('anna@example.com'));
    // The e-mail itself was masked at rest…
    assert.notEqual(row1!['E-Mail'], 'anna@example.com');
    // …and the key never reveals it.
    assert.match(String(row1!['__k_E-Mail']), TOKEN);
    // A blank cell keys to null, not ''.
    assert.equal(row3!['__k_Name'], null);
    assert.equal(row3!['__k_E-Mail'], null);
  });

  it('refuses a file whose header uses the reserved __k_ prefix — with and without link keys', async () => {
    const tricky = 'Name,__k_Name\nAda,already\n';
    const withKeys = await buildDatasetFromCsv(Buffer.from(tricky, 'utf8'), { linkKey });
    assert.equal(withKeys.ok, false);
    if (withKeys.ok) return;
    assert.match(withKeys.reason, /__k_Name/);
    assert.match(withKeys.reason, /reserved/);
    const withoutKeys = await buildDatasetFromCsv(Buffer.from(tricky, 'utf8'));
    assert.equal(withoutKeys.ok, false);
  });

  it('key columns carry no schema sample', async () => {
    const r = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'), { linkKey });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    for (const c of r.columns.filter((x) => isLinkKeyColumn(x.name))) {
      assert.equal(c.sample, undefined);
    }
    assert.ok(r.columns.find((c) => c.name === 'Name')?.sample);
  });

  it('ensureTokenShaped refuses a digest too short to borrow a digit from', () => {
    assert.throws(() => ensureTokenShaped('abcdef'));
  });
});

describe('importTabularDataset — link keys end to end', () => {
  const csvA = 'Name,E-Mail\nAnna Schmidt,anna@example.com\nBernd Meier,bernd@example.com\n';
  const csvB = 'Name,E-Mail\nANNA SCHMIDT,Anna@Example.com\nClara Voss,clara@example.com\n';

  async function importBoth(secret: Buffer | null) {
    const graph = new InMemoryKnowledgeGraph();
    const common = { graph, ownerOmadiaUserId: 'user-1', format: 'csv' as const, linkKeySecret: secret };
    const a = await importTabularDataset({
      ...common,
      bytes: Buffer.from(csvA, 'utf8'),
      datasetName: 'A',
      sourceFileName: 'a.csv',
    });
    const b = await importTabularDataset({
      ...common,
      bytes: Buffer.from(csvB, 'utf8'),
      datasetName: 'B',
      sourceFileName: 'b.csv',
    });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) throw new Error('import failed');
    return { graph, a: a.imported[0]!, b: b.imported[0]! };
  }

  it('reports the key columns per table and writes them through the KnowledgeGraph', async () => {
    const { graph, a } = await importBoth(SECRET);
    assert.deepEqual(a.linkKeys.columns, ['__k_Name', '__k_E-Mail']);
    const page = await graph.queryDatasetRows(a.result.datasetId, 'user-1', { limit: 10 });
    assert.ok(page?.rows);
    assert.equal(page.rows.length, 2);
    assert.match(String(page.rows[0]!['__k_Name']), TOKEN);
  });

  it('linkKeySecret: null disables keys and says so in the report', async () => {
    const { a } = await importBoth(null);
    assert.deepEqual(a.linkKeys.columns, []);
  });

  it('a query_dataset page interns with the key column safe-cleartext, and distinct de-duplicates across files', async () => {
    const { graph, a, b } = await importBoth(SECRET);
    const pageA = await graph.queryDatasetRows(a.result.datasetId, 'user-1', { limit: 10 });
    const pageB = await graph.queryDatasetRows(b.result.datasetId, 'user-1', { limit: 10 });
    assert.ok(pageA && pageB);

    // Exactly what the orchestrator does with a `query_dataset` result: the
    // JSON string is interned; the store promotes `{rows:[…]}` to row shape.
    const classify = createShapeClassifier();
    const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
    const engine = createVerbEngine({ store, classify });
    const dsA = store.internToolResult('query_dataset', JSON.stringify(pageA));
    const dsB = store.internToolResult('query_dataset', JSON.stringify(pageB));

    const keyField = store.get(dsA.datasetId)!.schema.fields.find((f) => f.path === '__k_E-Mail');
    assert.ok(keyField);
    assert.equal(keyField.classification, 'safe-cleartext');
    const nameField = store.get(dsA.datasetId)!.schema.fields.find((f) => f.path === 'Name');
    assert.equal(nameField?.classification, 'sensitive-masked', 'the name itself stays masked');

    const u = engine.union(dsA.datasetId, dsB.datasetId);
    assert.equal(u.digest.rowCount, 4);
    const d = engine.distinct(u.datasetId, ['__k_E-Mail']);
    assert.equal(d.digest.rowCount, 3, 'Anna appears in both files and collapses to one row');
    const byName = engine.distinct(u.datasetId, ['__k_Name']);
    assert.equal(byName.digest.rowCount, 3, 'the same holds keyed by name despite the casing');
  });
});
