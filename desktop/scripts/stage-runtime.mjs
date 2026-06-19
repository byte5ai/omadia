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
console.log('[stage-runtime] done →', runtime);
