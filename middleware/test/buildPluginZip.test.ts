/**
 * #1075 — `scripts/build-plugin-zip.mjs` is the only supported way to cut the
 * Hub ZIP of an in-tree plugin package. `@omadia/plugin-office` 0.1.2 was
 * zipped by hand from an uncommitted tree; these tests pin every guard that
 * would have refused it, plus the artifact shape the Hub has always received.
 *
 * Each case builds a throwaway git repository holding a fixture package whose
 * `build` script writes `dist/plugin.js`, then spawns the real script.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yauzl from 'yauzl';

const SCRIPT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'scripts',
  'build-plugin-zip.mjs',
);

const BUILD_JS = [
  "const fs = require('node:fs');",
  "fs.mkdirSync('dist/lib', { recursive: true });",
  "fs.writeFileSync('dist/plugin.js', 'export const x = 1;\\n');",
  "fs.writeFileSync('dist/lib/util.js', 'export const y = 2;\\n');",
  '',
].join('\n');

interface Fixture {
  manifestVersion?: string;
  pkgVersion?: string;
  pkgName?: string;
  entry?: string;
}

/** Git without the caller's GIT_* env (hooks can set GIT_DIR) and without signing. */
function git(cwd: string, args: string[]): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  const r = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

let root = '';
let counter = 0;

function makeRepo(f: Fixture = {}): { repo: string; pkg: string; out: string } {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  const pkg = join(repo, 'packages', 'demo');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'dist/\nout/\n*.tsbuildinfo\n');
  writeFileSync(
    join(pkg, 'manifest.yaml'),
    [
      'schema_version: "1"',
      'identity:',
      '  id: "@omadia/plugin-demo"',
      `  version: "${f.manifestVersion ?? '1.2.3'}"`,
      'lifecycle:',
      `  entry: "${f.entry ?? 'dist/plugin.js'}"`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify(
      {
        name: f.pkgName ?? '@omadia/plugin-demo',
        version: f.pkgVersion ?? '1.2.3',
        private: true,
        scripts: { build: 'node build.cjs' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(pkg, 'build.cjs'), BUILD_JS);
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  return { repo, pkg, out: join(repo, 'artifacts') };
}

function runScript(pkg: string, out: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, pkg, '--out-dir', out], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

function zipEntries(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names: string[] = [];
      zip.on('entry', (e: yauzl.Entry) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const ZIP_NAME = 'omadia-plugin-demo-1.2.3.zip';

describe('scripts/build-plugin-zip.mjs (#1075)', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'build-plugin-zip-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds a flat ZIP of manifest, package.json and a fresh dist/', async () => {
    const { pkg, out } = makeRepo();
    // Leftovers of an earlier build must not ship: dist/ is wiped first.
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'stale.js'), 'old\n');
    writeFileSync(join(pkg, 'tsconfig.tsbuildinfo'), '{}');

    const r = runScript(pkg, out);
    assert.equal(r.status, 0, r.stderr);
    const names = await zipEntries(join(out, ZIP_NAME));
    assert.deepEqual(names, [
      'dist/lib/util.js',
      'dist/plugin.js',
      'manifest.yaml',
      'package.json',
    ]);
  });

  it('produces byte-identical ZIPs for the same commit', () => {
    const { pkg, out } = makeRepo();
    const sha = (): string => {
      const r = runScript(pkg, out);
      assert.equal(r.status, 0, r.stderr);
      return createHash('sha256').update(readFileSync(join(out, ZIP_NAME))).digest('hex');
    };
    assert.equal(sha(), sha());
  });

  it('refuses a manifest/package.json version drift and names both versions', () => {
    const { pkg, out } = makeRepo({ manifestVersion: '9.9.9' });
    const r = runScript(pkg, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /version drift/);
    assert.match(r.stderr, /9\.9\.9/);
    assert.match(r.stderr, /1\.2\.3/);
  });

  it('refuses a manifest id that differs from the package name', () => {
    const { pkg, out } = makeRepo({ pkgName: '@omadia/plugin-other' });
    const r = runScript(pkg, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /id drift/);
  });

  it('refuses an uncommitted edit under the package', () => {
    const { pkg, out } = makeRepo();
    writeFileSync(join(pkg, 'build.cjs'), `${BUILD_JS}// local edit\n`);
    const r = runScript(pkg, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /uncommitted changes/);
  });

  it('refuses an untracked file under the package', () => {
    const { pkg, out } = makeRepo();
    writeFileSync(join(pkg, 'notes.md'), 'draft\n');
    const r = runScript(pkg, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notes\.md/);
  });

  it('refuses a package outside any git work tree', () => {
    const dir = join(root, 'no-git');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'identity:\n  id: "a"\n  version: "1"\nlifecycle:\n  entry: "dist/plugin.js"\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1' }));
    const r = runScript(dir, join(root, 'no-git-out'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not inside a git work tree/);
  });

  it('refuses a build that does not produce lifecycle.entry', () => {
    const { pkg, out } = makeRepo({ entry: 'dist/missing.js' });
    const r = runScript(pkg, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dist\/missing\.js is missing/);
  });
});
