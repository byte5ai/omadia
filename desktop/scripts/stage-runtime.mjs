// Stages the built omadia runtime (middleware + web-ui) into desktop/runtime so
// electron-builder can ship it as unpacked extraResources.
//
// Run AFTER building middleware and web-ui:
//   (repo) $ cd middleware && npm run build
//   (repo) $ cd web-ui && npm run build
//   (repo) $ cd desktop && node scripts/stage-runtime.mjs
//
// node_modules are copied with symlinks dereferenced so the omadia workspace
// packages (linked as @omadia/* → ../packages/*) become real directories in the
// shipped bundle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const runtime = path.join(here, '..', 'runtime');

const mwSrc = path.join(repo, 'middleware');
const uiStandalone = path.join(repo, 'web-ui', '.next', 'standalone');
const uiStatic = path.join(repo, 'web-ui', '.next', 'static');
const uiPublic = path.join(repo, 'web-ui', 'public');

function requireDir(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`[stage-runtime] missing ${p}\n  → ${hint}`);
    process.exit(1);
  }
}

requireDir(path.join(mwSrc, 'dist'), 'build the middleware first: (cd middleware && npm run build)');
requireDir(uiStandalone, 'build web-ui first with output:"standalone": (cd web-ui && npm run build)');

fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtime, { recursive: true });

// --- middleware: copy the pieces the kernel needs at runtime ---
const mwDest = path.join(runtime, 'middleware');
for (const entry of ['dist', 'node_modules', 'packages', 'migrations', 'assets', 'package.json']) {
  const from = path.join(mwSrc, entry);
  if (!fs.existsSync(from)) continue;
  const to = path.join(mwDest, entry);
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

// fs.cpSync({dereference:true}) does NOT reliably materialise the npm-workspace
// symlinks `node_modules/@omadia/* → packages/*` — on CI runners they're ABSOLUTE
// (`/Users/runner/.../packages/x`), so the shipped bundle ends up with DANGLING
// symlinks to the build machine and the kernel can't resolve any @omadia/* package
// at runtime (ERR_MODULE_NOT_FOUND → kernel crash). Replace each @omadia symlink
// with a real copy of the package it resolves to. (Each package's own nested
// @omadia symlinks may stay dangling but are unused: Node resolves up to this
// top-level real dir.)
const scope = path.join(mwDest, 'node_modules', '@omadia');
if (fs.existsSync(scope)) {
  let materialised = 0;
  for (const name of fs.readdirSync(scope)) {
    const link = path.join(scope, name);
    if (!fs.lstatSync(link).isSymbolicLink()) continue;
    let target;
    try {
      target = fs.realpathSync(link);
    } catch {
      console.error(`[stage-runtime] FATAL: dangling @omadia/${name} symlink — build the middleware first`);
      process.exit(1);
    }
    fs.rmSync(link, { force: true });
    fs.cpSync(target, link, { recursive: true });
    materialised++;
  }
  console.log(`[stage-runtime] materialised ${materialised} @omadia workspace package(s)`);
}
console.log('[stage-runtime] staged middleware');

// --- web-ui: flatten the Next standalone output into runtime/web-ui ---
const uiDest = path.join(runtime, 'web-ui');
fs.cpSync(uiStandalone, uiDest, { recursive: true, dereference: true });
// Standalone does not include static assets or public/ — copy them into place.
if (fs.existsSync(uiStatic)) {
  fs.cpSync(uiStatic, path.join(uiDest, '.next', 'static'), { recursive: true });
}
if (fs.existsSync(uiPublic)) {
  fs.cpSync(uiPublic, path.join(uiDest, 'public'), { recursive: true });
}
console.log('[stage-runtime] staged web-ui');

// --- embedded Postgres engine: stage the platform's PG binaries (+ pgvector,
// which CI copies into native/ before staging) into runtime/omadia-pg. The kernel
// connects to a real bundled PostgreSQL 17; embeddedDb.ts resolves this at
// resourcesPath/omadia-pg in the packaged app. ---
const pgOs = process.platform === 'win32' ? 'windows' : process.platform;
const pgPlat = `${pgOs}-${process.arch}`;
const pgNative = path.join(here, '..', 'node_modules', '@embedded-postgres', pgPlat, 'native');
requireDir(
  pgNative,
  `install embedded-postgres so the @embedded-postgres/${pgPlat} binary is present`,
);
const stagedPg = path.join(runtime, 'omadia-pg');
fs.cpSync(pgNative, stagedPg, { recursive: true, dereference: true });

// fs.cpSync({dereference:true}) does NOT preserve the engine's RELATIVE same-dir
// symlinks (e.g. libicudata.68.dylib -> libicudata.68.2.dylib). It rewrites them
// into ABSOLUTE links pointing at THIS build machine's node_modules. They resolve
// on the build box (so a local build boots — masking the bug) but DANGLE anywhere
// else: on CI the link targets `/Users/runner/work/...`, so dyld can't find
// `@loader_path/../lib/libicudata.68.dylib` and initdb/postgres fail to launch.
// Restore the engine's own relative symlinks verbatim from the source tree so the
// dylib chain resolves wherever the installer lands. (All source links are
// relative + in-tree — verified — so copying their readlink value is sufficient.)
let relinked = 0;
const restoreLinks = (srcDir) => {
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    if (ent.isSymbolicLink()) {
      const dest = path.join(stagedPg, path.relative(pgNative, src));
      fs.rmSync(dest, { force: true, recursive: true });
      fs.symlinkSync(fs.readlinkSync(src), dest);
      relinked++;
    } else if (ent.isDirectory()) {
      restoreLinks(src);
    }
  }
};
restoreLinks(pgNative);
console.log(`[stage-runtime] restored ${relinked} relative symlink(s) in the Postgres engine`);

// Sanity: pgvector must have been FULLY provisioned into the engine (CI step) —
// not just the control file. `CREATE EXTENSION vector` needs all three: the
// control descriptor, the loadable module, and at least one install SQL script.
// Checking only vector.control would let a half-copied payload pass staging and
// fail at runtime when the first migration runs `CREATE EXTENSION vector`.
const extDir = path.join(runtime, 'omadia-pg', 'share', 'postgresql', 'extension');
const libDir = path.join(runtime, 'omadia-pg', 'lib', 'postgresql');
const moduleName = { win32: 'vector.dll', darwin: 'vector.dylib' }[process.platform] ?? 'vector.so';
const missing = [];
if (!fs.existsSync(path.join(extDir, 'vector.control'))) missing.push('share/.../vector.control');
if (!fs.existsSync(path.join(libDir, moduleName))) missing.push(`lib/postgresql/${moduleName}`);
const hasInstallSql =
  fs.existsSync(extDir) && fs.readdirSync(extDir).some((f) => /^vector--.*\.sql$/.test(f));
if (!hasInstallSql) missing.push('share/.../vector--*.sql');
if (missing.length) {
  console.error(
    `[stage-runtime] FATAL: pgvector not fully provisioned — missing: ${missing.join(', ')}. ` +
      'CI must place the matching vector.control + module + vector--*.sql into the engine before staging.',
  );
  process.exit(1);
}
console.log(`[stage-runtime] staged Postgres engine (${pgPlat}) + pgvector (control + ${moduleName} + install SQL)`);

console.log('[stage-runtime] done →', runtime);
