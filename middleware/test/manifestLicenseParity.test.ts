/**
 * #1988 — the Store shows a plugin's manifest `license`, so it must say what
 * the package says. Fourteen bundled manifests read "Proprietary" while their
 * package.json and the repo are MIT.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const PACKAGES = resolve(import.meta.dirname, '../packages');

describe('#1988 — manifest license matches package.json', () => {
  for (const dir of readdirSync(PACKAGES)) {
    const manifestPath = join(PACKAGES, dir, 'manifest.yaml');
    const packagePath = join(PACKAGES, dir, 'package.json');
    if (!existsSync(manifestPath) || !existsSync(packagePath)) continue;
    const declared = /^\s*license:\s*"?([^"\n]+)"?\s*$/m.exec(readFileSync(manifestPath, 'utf8'))?.[1];
    if (declared === undefined) continue;
    it(dir, () => {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { license?: string };
      // A package.json without a license field inherits the repo's (MIT).
      assert.equal(declared.trim(), pkg.license ?? 'MIT', `${dir}/manifest.yaml license`);
    });
  }
});
