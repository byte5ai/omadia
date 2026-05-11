// Post-tsc step: copies the .sql migration files from src/migrations/
// to dist/migrations/ so that the compiled `migrator.js` (which
// resolves the migrations directory relative to its own URL via
// `fileURLToPath(import.meta.url)`) finds them at runtime.
//
// tsc itself does not copy non-.ts assets — that's why this step exists.
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src', 'migrations');
const destDir = join(here, '..', 'dist', 'migrations');

if (!existsSync(srcDir)) {
  console.error(`[copy-sql-assets] no source dir at ${srcDir} — skipping`);
  process.exit(0);
}

await mkdir(dirname(destDir), { recursive: true });
await cp(srcDir, destDir, { recursive: true });
console.error(`[copy-sql-assets] copied ${srcDir} -> ${destDir}`);
