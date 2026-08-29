/**
 * Test-only module resolution shims, loaded via `node --import`.
 *
 * Two of them, both needed to unit-test the desktop lifecycle code in plain
 * node (#932):
 *
 * 1. `import 'electron'` is redirected to a fake, because the modules under
 *    test reach Electron at import time (`paths.ts` reads `app.isPackaged`).
 * 2. Extensionless relative imports (`./paths`) are resolved to their `.ts`
 *    file. The production sources are compiled by tsc in Node16/CommonJS mode
 *    where extensionless specifiers are correct, but node's ESM resolver
 *    requires the extension. Shimming it here keeps the shipped code idiomatic
 *    for its own build instead of contorting it for the tests.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const fakeElectron = pathToFileURL(path.join(import.meta.dirname, 'electron-fake.mjs')).href;

const CANDIDATE_SUFFIXES = ['.ts', '.mts', '/index.ts'];

function resolveExtensionless(specifier, parentURL) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (path.extname(specifier) !== '') return null;
  if (parentURL === undefined) return null;
  const parentDir = path.dirname(fileURLToPath(parentURL));
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = path.resolve(parentDir, `${specifier}${suffix}`);
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: fakeElectron, shortCircuit: true };
    const resolved = resolveExtensionless(specifier, context.parentURL);
    if (resolved !== null) return { url: resolved, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
