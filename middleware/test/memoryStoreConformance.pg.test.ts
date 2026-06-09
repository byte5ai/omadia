import { Pool } from 'pg';

import { runMemoryMigrations } from '../packages/harness-memory-postgres/src/migrator.js';
import { PostgresMemoryStore } from '../packages/harness-memory-postgres/src/postgresMemoryStore.js';
import { runMemoryStoreConformance } from './memoryStoreConformance.js';

const PG_URL = process.env['MEMORY_PG_TEST_URL'];

if (!PG_URL) {
  // No throwaway Postgres configured — skip so plain `npm test` stays green.
  console.error(
    '[memoryStoreConformance.pg] MEMORY_PG_TEST_URL unset — skipping PostgresMemoryStore conformance',
  );
} else {
  const url = PG_URL;
  // One shared pool for the whole file; each test gets a TRUNCATE'd table.
  const pool = new Pool({ connectionString: url });
  let migrated = false;

  runMemoryStoreConformance(async () => {
    if (!migrated) {
      await runMemoryMigrations(pool);
      migrated = true;
    }
    await pool.query('TRUNCATE memory_files');
    return {
      store: new PostgresMemoryStore(pool),
      cleanup: async () => {
        // Table is truncated at the start of the next case; pool is shared
        // and closed once after the suite (see process exit hook below).
      },
    };
  }, 'PostgresMemoryStore');

  // Close the shared pool once the test process is about to exit so the
  // node:test runner does not hang on open handles.
  process.on('beforeExit', () => {
    void pool.end();
  });
}
