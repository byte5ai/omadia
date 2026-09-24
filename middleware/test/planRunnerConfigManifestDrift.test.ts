/**
 * #1103 — config-drift guard for the plan-runner plugin.
 *
 * The plugin reads setup values via `ctx.config.get('<key>')`; the store only
 * renders fields the manifest declares under `setup.fields`. When the two drift
 * apart — code reads a key the manifest never declares — the value becomes
 * silently unreachable from the UI (the bug in #1103: `reuseProcesses` and
 * `processReuseThreshold` were read but never declared).
 *
 * This test pins the invariant: every key the plugin source reads through
 * `ctx.config.get(...)` or `ctx.config.require(...)` is declared in the
 * plugin's manifest. It scans the package's `src/` so it also covers keys
 * added in future files. `require()` matters as much as `get()`: an
 * undeclared key there throws `MissingConfigError` at activation time rather
 * than returning undefined, i.e. the louder version of the same drift.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_MODE_CONFIG_KEY,
} from '@omadia/plugin-api';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const PKG_ROOT = new URL(
  '../packages/harness-plugin-plan-runner/',
  import.meta.url,
);

/** Kernel-injected synthetic setup fields — read by plugins but never declared
 *  in their own manifest (the kernel adds them to every plugin's schema; see
 *  `installService.ts` → privacy fields). Imported rather than spelled out so a
 *  kernel-side rename can't silently re-open the drift this test closes. */
const KERNEL_INJECTED_KEYS = new Set<string>([
  PRIVACY_MODE_CONFIG_KEY,
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
]);

/** Recursively collect every `.ts` file under a directory. */
function collectTsFiles(dir: URL): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(`${dirent.name}${dirent.isDirectory() ? '/' : ''}`, dir);
    if (dirent.isDirectory()) out.push(...collectTsFiles(child));
    else if (dirent.name.endsWith('.ts')) out.push(fileURLToPath(child));
  }
  return out;
}

/** Every distinct key read via `ctx.config.get(...)` / `.require(...)` across
 *  the given sources. */
function configKeysReadIn(files: readonly string[]): Set<string> {
  // Matches `.config.get('key')` / `.config.require('key')` and their
  // `<T>`-annotated forms, single or double quotes. Deliberately narrow: only
  // literal-string keys are checked (a dynamic key can't be validated
  // statically anyway).
  const re = /\.config\.(?:get|require)(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g;
  const keys = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const key = m[1];
      if (key) keys.add(key);
    }
  }
  return keys;
}

describe('plan-runner — setup keys read in code are declared in the manifest', () => {
  it('has no config-key drift between src/ and manifest.yaml', async () => {
    const entry = await loadManifestFromPath(
      fileURLToPath(new URL('manifest.yaml', PKG_ROOT)),
    );
    assert.ok(entry, 'manifest loads as a valid schema-v1 document');

    const declared = new Set(entry.plugin.setup_fields.map((f) => f.key));
    const read = configKeysReadIn(collectTsFiles(new URL('src/', PKG_ROOT)));

    // Sanity: the scan actually found the known reads, so a regex regression
    // can't make this test vacuously pass.
    for (const known of ['enabled', 'reuseProcesses', 'processReuseThreshold']) {
      assert.ok(read.has(known), `expected src/ to read config key '${known}'`);
    }

    const undeclared = [...read].filter(
      (k) => !declared.has(k) && !KERNEL_INJECTED_KEYS.has(k),
    );
    assert.deepEqual(
      undeclared,
      [],
      `these config keys are read in code but not declared in manifest.yaml ` +
        `(add them to setup.fields, or stop reading them): ${undeclared.join(', ')}`,
    );
  });
});
