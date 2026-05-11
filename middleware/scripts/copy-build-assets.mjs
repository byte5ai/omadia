#!/usr/bin/env node
// Copies non-TypeScript runtime assets from src/ to dist/ after `tsc`.
//
// `tsc` emits only compiled .js — any sibling file that the compiled code
// loads at runtime (SQL migrations, .md templates, JSON fixtures, …) must be
// mirrored into dist/ manually, otherwise the production image misses them.
//
// Entries below use paths RELATIVE TO THE MIDDLEWARE ROOT. Keep the list
// explicit so it is obvious what ends up in the runtime image.

import { cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const middlewareRoot = resolve(here, '..');

/** @type {Array<{ from: string; to: string }>} */
const ASSETS = [
  {
    from: 'src/services/graph/migrations',
    to: 'dist/services/graph/migrations',
  },
];

async function main() {
  for (const { from, to } of ASSETS) {
    const src = resolve(middlewareRoot, from);
    const dst = resolve(middlewareRoot, to);
    if (!existsSync(src)) {
      console.warn(`[copy-build-assets] missing source: ${from} (skipped)`);
      continue;
    }
    await cp(src, dst, { recursive: true, force: true });
    console.log(`[copy-build-assets] ${from} → ${to}`);
  }
}

main().catch((err) => {
  console.error('[copy-build-assets] failed:', err);
  process.exit(1);
});
