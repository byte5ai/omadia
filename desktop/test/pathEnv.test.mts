/**
 * Unit tests for the desktop PATH augmentation (#925, follow-on from #906).
 *
 * They run on Node's native TypeScript type stripping (Node >= 22.18; the
 * repo's `.nvmrc` pins 22.22.3), so the desktop package needs no test
 * dependency at all. The `.mts` extension keeps this file unambiguously ESM —
 * `desktop/package.json` declares no `"type"`.
 *
 * Every case builds a throwaway home and passes `platform` and `homeDir`
 * explicitly, so nothing here depends on the machine the suite runs on.
 */
import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAugmentedPath } from '../src/pathEnv.ts';

const BASE_PATH = '/usr/bin:/bin';
const NVM_VERSIONS_MARKER = path.join('.nvm', 'versions', 'node');

const createdHomes: string[] = [];

function makeHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-pathenv-'));
  createdHomes.push(homeDir);
  return homeDir;
}

function makeDir(...segments: string[]): string {
  const dir = path.join(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAlias(homeDir: string, aliasName: string, aliasValue: string): void {
  const aliasPath = path.join(homeDir, '.nvm', 'alias', aliasName);
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, `${aliasValue}\n`, 'utf8');
}

function entriesOf(pathValue: string): string[] {
  return pathValue.split(path.delimiter);
}

after(() => {
  for (const homeDir of createdHomes) {
    // The unreadable-`~/.local` fixture has to be made readable again first.
    try {
      fs.chmodSync(path.join(homeDir, '.local'), 0o755);
    } catch {
      /* the other fixtures need no repair */
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

describe('resolveAugmentedPath — ~/.local tool installs', () => {
  it('discovers every ~/.local/<tool>/bin, not just ~/.local/bin', () => {
    const homeDir = makeHome();
    const nodeBin = makeDir(homeDir, '.local', 'node', 'bin');
    const otherBin = makeDir(homeDir, '.local', 'somethingelse', 'bin');
    makeDir(homeDir, '.local', 'share'); // no `bin` child → contributes nothing

    const entries = entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir));

    assert.ok(entries.includes(nodeBin), `missing ${nodeBin}`);
    assert.ok(entries.includes(otherBin), `missing ${otherBin}`);
    assert.ok(!entries.includes(path.join(homeDir, '.local', 'share', 'bin')));
    assert.ok(!entries.includes(path.join(homeDir, '.local', 'share')));
  });

  it('still adds ~/.local/bin itself (#906 regression guard)', () => {
    const homeDir = makeHome();
    const localBin = makeDir(homeDir, '.local', 'bin');

    assert.ok(entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir)).includes(localBin));
  });

  it('appends after the inherited PATH and never duplicates an entry', () => {
    const homeDir = makeHome();
    const nodeBin = makeDir(homeDir, '.local', 'node', 'bin');
    const otherBin = makeDir(homeDir, '.local', 'somethingelse', 'bin');
    // The base PATH already contains one of the discovered dirs, so this also
    // pins the dedupe behaviour: it keeps the earlier, inherited position.
    const baseEntries = ['/usr/bin', '/bin', nodeBin];

    const entries = entriesOf(
      resolveAugmentedPath(baseEntries.join(path.delimiter), 'darwin', homeDir),
    );

    assert.equal(new Set(entries).size, entries.length, 'PATH must not repeat an entry');
    assert.deepEqual(entries.slice(0, baseEntries.length), baseEntries);
    const lastBaseIndex = Math.max(...baseEntries.map((entry) => entries.indexOf(entry)));
    assert.ok(
      entries.indexOf(otherBin) > lastBaseIndex,
      'discovered dirs must come after every inherited entry',
    );
  });
});

describe('resolveAugmentedPath — nvm default alias', () => {
  it('follows a transitive chain: default → lts/* → lts/krypton → v24.19.0', () => {
    const homeDir = makeHome();
    writeAlias(homeDir, 'default', 'lts/*');
    writeAlias(homeDir, path.join('lts', '*'), 'lts/krypton');
    writeAlias(homeDir, path.join('lts', 'krypton'), 'v24.19.0');
    const nvmBin = makeDir(homeDir, '.nvm', 'versions', 'node', 'v24.19.0', 'bin');

    assert.ok(entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir)).includes(nvmBin));
  });

  it('resolves the `node` alias numerically, so v22 beats v8', () => {
    const homeDir = makeHome();
    writeAlias(homeDir, 'default', 'node');
    const oldBin = makeDir(homeDir, '.nvm', 'versions', 'node', 'v8.17.0', 'bin');
    const newBin = makeDir(homeDir, '.nvm', 'versions', 'node', 'v22.22.3', 'bin');

    const entries = entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir));

    assert.ok(entries.includes(newBin), `missing ${newBin}`);
    assert.ok(!entries.includes(oldBin), `must not fall back to ${oldBin}`);
  });

  it('keeps resolving a literal version alias (unchanged behaviour)', () => {
    const homeDir = makeHome();
    writeAlias(homeDir, 'default', '24.19.0');
    const nvmBin = makeDir(homeDir, '.nvm', 'versions', 'node', 'v24.19.0', 'bin');

    assert.ok(entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir)).includes(nvmBin));
  });

  it('terminates on an alias cycle without adding an nvm dir', () => {
    const homeDir = makeHome();
    writeAlias(homeDir, 'default', 'a');
    writeAlias(homeDir, 'a', 'default');
    makeDir(homeDir, '.nvm', 'versions', 'node', 'v24.19.0', 'bin');

    const result = resolveAugmentedPath(BASE_PATH, 'darwin', homeDir);

    assert.ok(!result.includes(NVM_VERSIONS_MARKER), result);
  });

  it('rejects an absolute or escaping alias value instead of following it', () => {
    for (const hostileValue of ['/etc/passwd', '../../../../etc']) {
      const homeDir = makeHome();
      writeAlias(homeDir, 'default', hostileValue);
      makeDir(homeDir, '.nvm', 'versions', 'node', 'v24.19.0', 'bin');

      const result = resolveAugmentedPath(BASE_PATH, 'darwin', homeDir);

      assert.ok(!result.includes(NVM_VERSIONS_MARKER), `${hostileValue} → ${result}`);
    }
  });
});

describe('resolveAugmentedPath — probing never breaks boot', () => {
  it('keeps the inherited PATH first for a home with nothing installed', () => {
    const homeDir = makeHome();

    const entries = entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir));

    assert.deepEqual(entries.slice(0, 2), ['/usr/bin', '/bin']);
  });

  it('swallows an unreadable ~/.local instead of propagating the scan failure', () => {
    const homeDir = makeHome();
    fs.chmodSync(makeDir(homeDir, '.local'), 0o000);

    const entries = entriesOf(resolveAugmentedPath(BASE_PATH, 'darwin', homeDir));

    assert.deepEqual(entries.slice(0, 2), ['/usr/bin', '/bin']);
  });

  it('returns the base PATH verbatim on win32', () => {
    const homeDir = makeHome();
    makeDir(homeDir, '.local', 'node', 'bin');

    assert.equal(resolveAugmentedPath(BASE_PATH, 'win32', homeDir), BASE_PATH);
  });
});
