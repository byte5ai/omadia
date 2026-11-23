#!/usr/bin/env node
/**
 * Every test that talks to Postgres must be named `*.pg.test.ts`.
 *
 * THE RISK
 * --------
 * CI runs the Postgres suites in exactly one place: `npm run test:pg`, which
 * globs `test/**\/*.pg.test.ts` and is the only step that sets a test DSN.
 * `npm run test` sets none, so there a Postgres suite self-skips (issue #572)
 * and passes green. A Postgres leg in a file named `foo.test.ts` therefore
 * runs nowhere: not in `test:pg` (wrong name), and only as a skip in `test`.
 * PG_TEST_FLOOR cannot catch it, because it counts only what `test:pg` sees.
 * Before this guard, seven files had such legs (27 tests that never ran in CI).
 *
 * THE RULE
 * --------
 * A test reaches Postgres through `test/_helpers/pgTestDb.ts`
 * (`probePgTest` / `resolvePgTestUrl`). A test file that imports it, directly
 * or through another helper, must be named `*.pg.test.ts`. Split a file with
 * both legs: the database-free cases stay in `foo.test.ts`, the Postgres
 * cases go to `foo.pg.test.ts`, shared code to a module that is not a test
 * (as memoryStoreConformance.ts does).
 *
 * Out of scope: the two live-Neon suites gated on DATABASE_URL alone
 * (palaiaHybridRetrievalNeon, neonDatasetFilterEscaping). They need external
 * fixtures and are deliberately not run in CI (see ci.yml, Postgres step).
 *
 *   node scripts/check-pg-test-names.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
const pgHelper = path.join(testDir, '_helpers', 'pgTestDb.ts');

function listTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listTs(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Relative imports only: `from './x.js'`, `import './x.js'`, `import('./x.js')`.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function relativeImports(file) {
  const src = readFileSync(file, 'utf8');
  const targets = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = path.resolve(path.dirname(file), m[1]);
    const candidates = [spec, spec.replace(/\.js$/, '.ts'), `${spec}.ts`];
    const hit = candidates.find((c) => c.endsWith('.ts') && existsSync(c));
    if (hit) targets.push(hit);
  }
  return targets;
}

const files = listTs(testDir);
const imports = new Map(files.map((f) => [f, relativeImports(f)]));

// Files that reach pgTestDb.ts, and the import chain that gets there.
const memo = new Map();
function pgChain(file, seen = new Set()) {
  if (memo.has(file)) return memo.get(file);
  if (seen.has(file)) return null;
  seen.add(file);
  let chain = null;
  for (const dep of imports.get(file) ?? relativeImports(file)) {
    if (dep === pgHelper) {
      chain = [file, dep];
      break;
    }
    const sub = pgChain(dep, seen);
    if (sub) {
      chain = [file, ...sub];
      break;
    }
  }
  memo.set(file, chain);
  return chain;
}

const violations = [];
for (const file of files) {
  if (!file.endsWith('.test.ts') || file.endsWith('.pg.test.ts')) continue;
  const chain = pgChain(file);
  if (chain) violations.push(chain.map((f) => path.relative(root, f)).join(' → '));
}

if (violations.length > 0) {
  console.error(
    `check-pg-test-names: ${violations.length} test file(s) reach Postgres but are not named *.pg.test.ts.\n` +
      'CI runs Postgres suites only in `npm run test:pg` (glob test/**/*.pg.test.ts); everywhere else they\n' +
      'self-skip, so these never run. Move the Postgres cases to a *.pg.test.ts file:\n',
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`check-pg-test-names: OK (${files.length} files under test/ scanned)`);
