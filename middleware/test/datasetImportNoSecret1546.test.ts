/**
 * #1546 — on an install without `DATASET_LINK_KEY_SECRET` and `VAULT_KEY` (the
 * default Compose stack, which runs on the dev key file), a dataset import
 * stored the SAME surrogate in every flagged cell of a column: 60 different
 * e-mails became one address. Two fixes:
 *
 *   - the import shares one surrogate map across the whole table, so distinct
 *     values keep distinct surrogates when there is no key at all;
 *   - the middleware hands its dev master key to the dataset resolvers, so
 *     such an install encrypts flagged cells (real values kept) like any
 *     other.
 */

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { resolveDatasetCellKey } from '../packages/harness-orchestrator/src/datasetCellCrypto.js';
import { buildDatasetFromCsv } from '../packages/harness-orchestrator/src/datasetImport.js';
import {
  VAULT_KEY_ENV,
  resolveDatasetLinkKeySecret,
  setDatasetVaultKeyFallback,
} from '../packages/harness-orchestrator/src/datasetLinkKey.js';

function contactsCsv(rows: number): Buffer {
  const lines = ['Name,E-Mail,Telefon'];
  for (let i = 1; i <= rows; i++) {
    lines.push(`Person ${String(i)},person${String(i)}@example.org,+49 30 1234${String(i).padStart(4, '0')}`);
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

afterEach(() => setDatasetVaultKeyFallback(undefined));

describe('#1546 — dataset import without a dataset secret', () => {
  it('keeps distinct values distinct when cells are masked irreversibly', async () => {
    const built = await buildDatasetFromCsv(contactsCsv(60));
    assert.ok(built.ok);
    assert.equal(built.privacyScan.encryptedAtRest, false);
    assert.equal(built.privacyScan.maskedCells, 120);
    const emails = new Set(built.rows.map((r) => r['E-Mail']));
    const phones = new Set(built.rows.map((r) => r['Telefon']));
    assert.equal(emails.size, 60, 'every e-mail keeps a surrogate of its own');
    assert.equal(phones.size, 60, 'every phone number keeps a surrogate of its own');
    for (const row of built.rows) {
      assert.ok(!String(row['E-Mail']).includes('example.org'), 'a real address was stored');
    }
  });

  it('derives the dataset keys from the dev master key the middleware loaded', () => {
    if ((process.env[VAULT_KEY_ENV] ?? '') !== '') return; // an operator key wins anyway
    assert.equal(resolveDatasetCellKey(), undefined, 'no key before the hand-over');
    setDatasetVaultKeyFallback(randomBytes(32));
    assert.ok(resolveDatasetLinkKeySecret(), 'link keys available');
    assert.ok(resolveDatasetCellKey(), 'cell encryption available');
    assert.equal(
      resolveDatasetLinkKeySecret({}),
      undefined,
      'an explicit environment never sees the process fallback',
    );
  });
});
