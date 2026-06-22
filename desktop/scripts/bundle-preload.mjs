// Bundles the preload into a single self-contained dist/preload.js.
//
// WHY: the BrowserWindow runs with `sandbox: true` (main.ts). A sandboxed
// preload only gets a limited `require` (electron + a small polyfill set) — it
// CANNOT `require('./ipcTypes')` or any other local module. tsc emits a preload
// that does exactly that, so the script fails to load with
// "Error: module not found: ./ipcTypes", `window.omadia` is never exposed, and
// every wizard/loading bridge call silently hangs (key test stuck on "Testing…",
// folder picker never opens, completion stalls).
//
// esbuild inlines the local imports (ipcTypes constants + erased types) into one
// file with `electron` left external (provided by the runtime), so the preload
// loads cleanly under the sandbox while keeping a single source of truth for the
// channel names. Runs AFTER tsc (overwriting tsc's broken dist/preload.js).
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, '..', 'src', 'preload.ts')],
  outfile: path.join(here, '..', 'dist', 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'warning',
});

console.log('[bundle-preload] dist/preload.js bundled (self-contained, sandbox-safe)');
