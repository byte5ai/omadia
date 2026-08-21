/**
 * Epic #470 C11 — the donor ledger name is a fact about ANOTHER file.
 *
 * `CORE_MIGRATION_DONOR_LEDGER` is core's knowledge of where core records the
 * migrations in `middleware/migrations/`. Nothing in the type system connects
 * the constant to the migrator that actually creates that table, so a rename
 * over there would leave this string pointing at a table that no longer
 * exists — and the handoff would then report "no donor rows" on every
 * installation, which is indistinguishable from a fresh install and therefore
 * silent.
 *
 * The witness rule still saves the installation (the schema objects are there,
 * so the files are seeded anyway), but the operator loses the one number that
 * makes a restore visible: the DISAGREEMENT between what core recorded and
 * what the catalog shows. So the link is asserted rather than assumed.
 *
 * No database needed — this is a fact about the source tree.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CORE_MIGRATION_DONOR_ID_COLUMN,
  CORE_MIGRATION_DONOR_LEDGER,
  migrationStem,
} from '../src/platform/pluginMigrationHandoff.js';

const MIDDLEWARE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_MIGRATOR = join(
  MIDDLEWARE_DIR,
  'packages/harness-orchestrator/src/registry/migrator.ts',
);

describe('#470 C11 donor ledger identity', () => {
  it('names a ledger the core migrator for middleware/migrations actually creates', async () => {
    const source = await readFile(CORE_MIGRATOR, 'utf8');
    assert.ok(
      source.includes(`CREATE TABLE IF NOT EXISTS ${CORE_MIGRATION_DONOR_LEDGER}`),
      `${CORE_MIGRATOR} no longer creates '${CORE_MIGRATION_DONOR_LEDGER}' — ` +
        'the handoff would read a table that does not exist and report "no donor rows" on every installation',
    );
    assert.ok(
      source.includes(`INSERT INTO ${CORE_MIGRATION_DONOR_LEDGER} (${CORE_MIGRATION_DONOR_ID_COLUMN})`),
      `the donor's filename column is no longer '${CORE_MIGRATION_DONOR_ID_COLUMN}'`,
    );
  });

  it('is not inside the kernel-owned plugin ledger namespace', () => {
    assert.ok(
      !CORE_MIGRATION_DONOR_LEDGER.startsWith('plg_'),
      'a donor is a CORE table; the plg_ namespace belongs to plugins',
    );
  });
});

describe('#470 C11 migrationStem', () => {
  it('makes a codegen JS file and the SQL it came from the same migration', () => {
    assert.equal(migrationStem('0022_widget.js'), migrationStem('0022_widget.sql'));
    assert.equal(migrationStem('0022_widget.mjs'), '0022_widget');
  });

  it('leaves a name with no extension alone', () => {
    assert.equal(migrationStem('0022_widget'), '0022_widget');
  });

  it('does not strip a leading dot, which is not an extension', () => {
    assert.equal(migrationStem('.keep'), '.keep');
  });

  it('strips only the LAST extension', () => {
    assert.equal(migrationStem('0022_widget.sql.js'), '0022_widget.sql');
  });
});
