/**
 * #1075 — every in-tree plugin package keeps ONE version.
 *
 * A plugin's version lives in two files: `manifest.yaml` (`identity.version`,
 * which the Hub and the kernel read) and `package.json` (which npm, the
 * lockfile and the Hub's own publish check read). When they disagree, the
 * artifact that ships carries a different version than the repository thinks
 * it cut. `@omadia/plugin-office` 0.1.2 on the Hub came from a tree the repo
 * never had; this suite and `scripts/build-plugin-zip.mjs` are the guards that
 * keep the two files — and the lockfile's workspace entry — in step.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const MIDDLEWARE = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PACKAGES = join(MIDDLEWARE, 'packages');

/** The only packages that ship to the Hub from this repository today. */
const HUB_PUBLISHED = ['@omadia/plugin-office', '@omadia/plugin-web-search'];
const PACKAGE_SCRIPT = 'node ../../scripts/build-plugin-zip.mjs';

interface PluginPackage {
  dir: string;
  manifestId: unknown;
  manifestVersion: unknown;
  pkg: { name?: unknown; version?: unknown; scripts?: Record<string, unknown> } | null;
}

function pluginPackages(): PluginPackage[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((dir) => existsSync(join(PACKAGES, dir, 'manifest.yaml')))
    .map((dir) => {
      const doc = YAML.parse(readFileSync(join(PACKAGES, dir, 'manifest.yaml'), 'utf8')) as {
        identity?: { id?: unknown; version?: unknown };
      };
      const pkgFile = join(PACKAGES, dir, 'package.json');
      const pkg = existsSync(pkgFile)
        ? (JSON.parse(readFileSync(pkgFile, 'utf8')) as PluginPackage['pkg'])
        : null;
      return {
        dir,
        manifestId: doc.identity?.id,
        manifestVersion: doc.identity?.version,
        pkg,
      };
    });
}

test('every plugin package with a manifest.yaml agrees with its package.json', () => {
  const packages = pluginPackages();
  // Guard the guard: an empty glob would make every assertion below vacuous.
  assert.ok(packages.length >= 20, `expected 20+ manifests, found ${packages.length}`);

  const drift: string[] = [];
  for (const { dir, manifestId, manifestVersion, pkg } of packages) {
    if (!pkg) {
      drift.push(`${dir}: manifest.yaml without a package.json`);
      continue;
    }
    if (manifestVersion !== pkg.version) {
      drift.push(
        `${dir}: manifest.yaml identity.version ${String(manifestVersion)} ≠ package.json version ${String(pkg.version)}`,
      );
    }
    if (manifestId !== pkg.name) {
      drift.push(
        `${dir}: manifest.yaml identity.id ${String(manifestId)} ≠ package.json name ${String(pkg.name)}`,
      );
    }
  }
  assert.deepEqual(drift, [], `version/id drift:\n${drift.join('\n')}`);
});

test('the lockfile workspace entry of every plugin package carries the same version', () => {
  const lock = JSON.parse(readFileSync(join(MIDDLEWARE, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { name?: string; version?: string } | undefined>;
  };
  const drift: string[] = [];
  for (const { dir, pkg } of pluginPackages()) {
    const entry = lock.packages[`packages/${dir}`];
    if (!entry) {
      drift.push(`${dir}: no workspace entry in package-lock.json`);
      continue;
    }
    if (entry.version !== pkg?.version) {
      drift.push(
        `${dir}: package-lock.json ${String(entry.version)} ≠ package.json ${String(pkg?.version)}`,
      );
    }
  }
  assert.deepEqual(drift, [], `lockfile drift:\n${drift.join('\n')}`);
});

test('Hub-published plugin packages build their release ZIP through the guarded script', () => {
  const byName = new Map(pluginPackages().map((p) => [p.pkg?.name, p]));
  for (const name of HUB_PUBLISHED) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} not found under packages/`);
    assert.equal(
      entry.pkg?.scripts?.['package'],
      PACKAGE_SCRIPT,
      `${name} must declare "package": "${PACKAGE_SCRIPT}"`,
    );
  }
});
