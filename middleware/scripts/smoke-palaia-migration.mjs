// Idempotency smoke for migration 0007_palaia_schema_uplift.sql.
// Runs the migrator twice — first call should be a no-op (already applied
// at boot), second call must also be a no-op without errors.
import { createNeonPool, runGraphMigrations } from '@omadia/knowledge-graph-neon';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');

const pool = createNeonPool(url, 2);
console.log('— first re-run (should be a no-op) —');
await runGraphMigrations(pool, (m) => console.log(m));
console.log('— second re-run (should also be a no-op) —');
await runGraphMigrations(pool, (m) => console.log(m));
await pool.end();
console.log('OK — migration is idempotent');
