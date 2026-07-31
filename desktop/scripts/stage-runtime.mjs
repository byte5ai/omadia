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

// The @embedded-postgres tarball ships ZERO real symlinks — it records the
// engine's intra-lib links (e.g. libicudata.68.dylib -> libicudata.68.2.dylib) in
// pg-symlinks.json and its postinstall materialises them. cpSync({dereference:true})
// then turns whatever real symlinks exist into ABSOLUTE links pointing at THIS
// build machine's node_modules: they resolve on the build box (so a local build
// boots — masking the bug) but DANGLE anywhere else (CI: `/Users/runner/work/...`),
// so dyld/ld.so can't find `@loader_path/../lib/libicudata.68.dylib` and
// initdb/postgres fail to launch. Recreate the links RELATIVE + in-tree straight
// from the manifest — independent of whether postinstall ran — so the dylib chain
// resolves wherever the installer lands. (Windows manifest is empty: flat DLLs.)
let relinked = 0;
const manifest = path.join(pgNative, 'pg-symlinks.json');
if (fs.existsSync(manifest)) {
  const stripNative = (p) => p.replace(/^native[\\/]/, '');
  for (const { source, target } of JSON.parse(fs.readFileSync(manifest, 'utf8'))) {
    const realFile = path.join(stagedPg, stripNative(source));
    const linkPath = path.join(stagedPg, stripNative(target));
    if (!fs.existsSync(realFile)) continue; // nothing to point at — skip silently
    fs.rmSync(linkPath, { force: true, recursive: true });
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(linkPath), realFile), linkPath);
    relinked++;
  }
}
console.log(`[stage-runtime] restored ${relinked} relative symlink(s) in the Postgres engine`);

// Sanity: pgvector must have been FULLY provisioned into the engine (CI step) —
// not just the control file. `CREATE EXTENSION vector` needs all three: the
// control descriptor, the loadable module, and at least one install SQL script.
// Checking only vector.control would let a half-copied payload pass staging and
// fail at runtime when the first migration runs `CREATE EXTENSION vector`.
// Layout differs by platform: Windows keeps extension modules flat in lib/ and
// control/SQL in share/extension/; macOS + Linux nest them under postgresql/.
const isWin = process.platform === 'win32';
const extDir = path.join(stagedPg, 'share', ...(isWin ? ['extension'] : ['postgresql', 'extension']));
const libDir = path.join(stagedPg, 'lib', ...(isWin ? [] : ['postgresql']));
const moduleName = { win32: 'vector.dll', darwin: 'vector.dylib' }[process.platform] ?? 'vector.so';
const relLib = path.relative(stagedPg, path.join(libDir, moduleName));
const missing = [];
if (!fs.existsSync(path.join(extDir, 'vector.control'))) missing.push('share/.../vector.control');
if (!fs.existsSync(path.join(libDir, moduleName))) missing.push(relLib);
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

// --- drop build-time-only files from the staged tree ---------------------
// The staged middleware ships its FULL node_modules as unpacked extraResources,
// which is ~34k files — and over half of them can never be loaded at runtime:
// the kernel runs compiled JS (`middleware/dist/index.js`), so TypeScript
// declarations, TypeScript sources and source maps are pure ballast.
//
// This is not just about size. macOS signing hashes EVERY file in the bundle,
// and the kernel caps concurrent open files per process at `kern.maxfilesperproc`
// REGARDLESS of `ulimit -n` — so on a ~44k-file bundle electron-builder dies with
// "EMFILE: too many open files" and the app cannot be signed at all. Raising the
// fd limit does not help (setting it to `unlimited` on macOS actually lowers the
// effective ceiling); cutting the file count does.
//
// Deliberately does NOT touch *.md — LICENSE.md and friends must ship.
const BALLAST = /\.(ts|mts|cts|map)$/;
function pruneBuildTimeOnlyFiles(root) {
  let pruned = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // handled by the dangling sweep below
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && BALLAST.test(entry.name)) {
        fs.rmSync(p, { force: true });
        pruned++;
      }
    }
  };
  walk(root);
  return pruned;
}

console.log(
  `[stage-runtime] pruned ${pruneBuildTimeOnlyFiles(mwDest)} build-time-only file(s) (*.d.ts, *.ts, *.map)`,
);

// --- prune symlinks that escape the staged tree --------------------------
// `fs.cpSync({ dereference: true })` does not materialise EVERY symlink: npm's
// `node_modules/.bin/*` entries survive the copy as ABSOLUTE links back into the
// BUILD machine's checkout (on CI: `/Users/runner/work/omadia/omadia/...`).
// There are 58 of them; nothing execs any of them at runtime.
//
// They are FATAL to macOS signing, in two different ways depending on where you
// look from — which is what makes them easy to misdiagnose:
//   • ON THE BUILD MACHINE the targets still exist, so the links RESOLVE. They
//     point outside the .app, and `codesign --verify` rejects the bundle with
//     "invalid destination for symbolic link in bundle".
//   • ANYWHERE ELSE the targets are gone, so they DANGLE, and codesign aborts
//     walking the tree with "No such file or directory".
// Testing "does the target exist?" therefore passes on CI and prunes nothing —
// the check has to be "does the target stay INSIDE the staged tree?".
//
// Either way the .app ends up with no valid signature and Gatekeeper refuses to
// launch it ("omadia is damaged and can't be opened") — exactly how v0.56.0 and
// v0.57.0 shipped.
//
// Runs LAST, after every stage step (including the Postgres relink above). The
// 31 legitimate in-tree links — Electron's `Versions/Current` framework layout
// and the engine's relative `libicudata.68.dylib` chain — resolve inside the
// tree and are kept.
function pruneEscapingSymlinks(root) {
  const rootReal = fs.realpathSync(root);
  const inside = (p) => p === rootReal || p.startsWith(rootReal + path.sep);
  let pruned = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      // Dirent flags are lstat-based, so a symlink is never mistaken for a dir.
      if (entry.isSymbolicLink()) {
        let keep = false;
        try {
          // realpathSync throws on a dangling link and fully resolves an
          // absolute or `../`-escaping one — both are handled by this branch.
          keep = inside(fs.realpathSync(p));
        } catch {
          keep = false;
        }
        if (!keep) {
          fs.rmSync(p, { force: true });
          pruned++;
        }
        continue; // never descend THROUGH a symlink — avoids cycles
      }
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return pruned;
}

console.log(`[stage-runtime] pruned ${pruneEscapingSymlinks(runtime)} escaping symlink(s)`);

// Hard gate: re-scan and require a clean tree. A second pass must find nothing —
// if it does, the prune itself is broken and we must not ship a tree that
// `codesign` (and therefore notarization) will choke on.
const stillDangling = pruneEscapingSymlinks(runtime);
if (stillDangling !== 0) {
  console.error(
    `[stage-runtime] FATAL: ${stillDangling} escaping symlink(s) survived the prune — ` +
      'refusing to stage a tree that macOS codesign cannot walk.',
  );
  process.exit(1);
}

console.log('[stage-runtime] done →', runtime);
