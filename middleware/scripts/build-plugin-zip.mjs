#!/usr/bin/env node
/**
 * build-plugin-zip.mjs — cut the Hub release ZIP of an in-tree plugin package.
 *
 *     cd middleware && npm run build          # the package's peers need dist/
 *     npm run package -w @omadia/plugin-office
 *     # → <repo>/out/omadia-plugin-office-<version>.zip
 *
 *     node scripts/build-plugin-zip.mjs [<package-dir>] [--out-dir <dir>]
 *                                       [--allow-unpushed-commit]
 *
 * ## Why this exists (#1075)
 *
 * `@omadia/plugin-office` 0.1.2 on the Hub was zipped by hand from a working
 * tree that was never committed: its setup guide existed nowhere in the
 * repository, and the repo stayed on 0.1.1 while three months of fixes landed
 * without a bump. This script is the only supported way to cut such a ZIP, and
 * it refuses every input that allowed that:
 *
 *   - **Version drift.** The version lives in `manifest.yaml`
 *     (`identity.version`, read by the Hub and the kernel) and in
 *     `package.json`. They must agree, and so must `identity.id` and `name`.
 *     Both files are PARSED, not regex-matched.
 *   - **Uncommitted source.** The package directory must sit in a git work
 *     tree with nothing modified or untracked under it, so every artifact can
 *     be traced to the commit printed at the end. Gitignored files count too
 *     (the repo ignores `tmp/`, `build/`, `logs/` anywhere, and `tsc` would
 *     still compile `src/tmp/*.ts`); only build output (`dist/`,
 *     `node_modules/`, `*.tsbuildinfo`) and `.DS_Store` may be ignored.
 *   - **Unpushed commit.** HEAD must be reachable from a remote-tracking ref,
 *     otherwise the printed SHA is provenance nobody else can check out.
 *     `--allow-unpushed-commit` builds anyway for a dry run and marks the
 *     output NOT PUBLISHABLE.
 *   - **Stale build output.** `dist/` and any `*.tsbuildinfo` are deleted and
 *     the package's own `npm run build` runs fresh. The packages are
 *     `composite: true`; a leftover tsbuildinfo would make `tsc` skip emitting
 *     into a deleted `dist/`. The manifest's `lifecycle.entry` must exist
 *     afterwards and must be an entry of the written archive. Symlinks and
 *     other non-regular files under `dist/` are refused, not dropped.
 *
 * ## Archive layout
 *
 * FLAT: `manifest.yaml`, `package.json` and `dist/` at the archive root — the
 * shape of every `plugin-office` / `plugin-web-search` ZIP the Hub serves.
 * Written with `yazl` (already a middleware dependency) instead of shelling out
 * to zip/7z/PowerShell, with sorted entries, a fixed DOS timestamp and a fixed
 * mode, so the same commit produces the same bytes on every machine.
 *
 * Publishing is NOT part of this script — see docs/creating-plugins.md §8.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import YAML from 'yaml';
import yazl from 'yazl';

/** Local-time constructor on purpose: yazl writes DOS fields from local getters. */
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const FILE_MODE = 0o100644;
const EXCLUDED_NAMES = new Set(['.DS_Store']);
const EXCLUDED_SUFFIXES = ['.tsbuildinfo'];
/** Gitignored paths (relative to the package) that are build output, not source. */
const IGNORED_OK_DIRS = ['dist/', 'node_modules/'];

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

function parseArgs(argv) {
  let pkgDir;
  let outDir;
  let allowUnpushed = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      outDir = argv[i + 1];
      if (!outDir) fail('--out-dir needs a directory');
      i += 1;
    } else if (arg === '--allow-unpushed-commit') {
      allowUnpushed = true;
    } else if (arg.startsWith('--')) {
      fail(`unknown option ${arg}`);
    } else if (pkgDir === undefined) {
      pkgDir = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  return {
    pkgDir: resolve(pkgDir ?? process.cwd()),
    outDir: outDir === undefined ? undefined : resolve(outDir),
    allowUnpushed,
  };
}

function git(pkgDir, args) {
  const r = spawnSync('git', args, { cwd: pkgDir, encoding: 'utf8' });
  if (r.error) fail(`git is not available: ${r.error.message}`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function readIdentity(pkgDir) {
  for (const rel of ['manifest.yaml', 'package.json']) {
    if (!existsSync(join(pkgDir, rel))) fail(`${pkgDir} has no ${rel}`);
  }
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const manifest = YAML.parse(readFileSync(join(pkgDir, 'manifest.yaml'), 'utf8')) ?? {};
  const identity = manifest.identity ?? {};
  const entry = manifest.lifecycle?.entry;

  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    fail('package.json needs a string "name" and "version"');
  }
  if (identity.version !== pkg.version) {
    fail(
      `version drift: manifest.yaml identity.version is ${String(identity.version)}, ` +
        `package.json version is ${pkg.version}. The Hub reads the manifest — bump both.`,
    );
  }
  if (identity.id !== pkg.name) {
    fail(
      `id drift: manifest.yaml identity.id is ${String(identity.id)}, ` +
        `package.json name is ${pkg.name}.`,
    );
  }
  if (typeof entry !== 'string' || entry.length === 0) {
    fail('manifest.yaml declares no lifecycle.entry');
  }
  return { name: pkg.name, version: pkg.version, entry: normalizeEntry(entry) };
}

/** `./dist/index.js` and `dist/index.js` name the same archive entry. */
function normalizeEntry(entry) {
  const norm = entry.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (norm.startsWith('/') || norm.split('/').includes('..')) {
    fail(`lifecycle.entry ${entry} must be a path inside the package`);
  }
  return norm;
}

function isIgnoredBuildOutput(rel) {
  const base = rel.replace(/\/$/, '').split('/').pop() ?? '';
  return (
    IGNORED_OK_DIRS.some((d) => rel.startsWith(d)) ||
    EXCLUDED_NAMES.has(base) ||
    EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

function assertCleanTree(pkgDir) {
  const top = git(pkgDir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    fail(`${pkgDir} is not inside a git work tree — a release must come from a commit (${top.err})`);
  }
  const status = git(pkgDir, ['status', '--porcelain', '--untracked-files=all', '--', '.']);
  if (!status.ok) fail(`git status failed: ${status.err}`);
  if (status.out.length > 0) {
    fail(
      `uncommitted changes under ${pkgDir} — commit or discard them first; ` +
        `a release must be reproducible from a commit:\n${status.out}`,
    );
  }
  const ignored = git(pkgDir, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', '.',
  ]);
  if (!ignored.ok) fail(`git ls-files failed: ${ignored.err}`);
  const strays = ignored.out
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((rel) => !isIgnoredBuildOutput(rel));
  if (strays.length > 0) {
    fail(
      `gitignored files under ${pkgDir} that are not build output — tsc could compile ` +
        `them into the artifact without any commit carrying them; delete or move them:\n` +
        strays.join('\n'),
    );
  }
  const head = git(pkgDir, ['rev-parse', 'HEAD']);
  if (!head.ok) fail(`the work tree has no commit yet (${head.err})`);
  return { repoRoot: top.out, headSha: head.out };
}

/** True when some remote-tracking ref contains HEAD, i.e. others can check it out. */
function isPushed(pkgDir) {
  const r = git(pkgDir, ['branch', '-r', '--contains', 'HEAD']);
  if (!r.ok) fail(`git branch -r --contains failed: ${r.err}`);
  return r.out.length > 0;
}

function freshBuild(pkgDir, entry) {
  rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });
  for (const name of readdirSync(pkgDir)) {
    if (name.endsWith('.tsbuildinfo')) rmSync(join(pkgDir, name), { force: true });
  }
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: pkgDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (r.error) fail(`could not run npm run build: ${r.error.message}`);
  if (r.status !== 0) fail(`npm run build exited ${String(r.status)}`);
  if (!existsSync(join(pkgDir, entry))) {
    fail(`lifecycle.entry ${entry} is missing after the build — the artifact would not load`);
  }
}

function listFiles(root, dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (EXCLUDED_NAMES.has(e.name)) return [];
    if (EXCLUDED_SUFFIXES.some((s) => e.name.endsWith(s))) return [];
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (e.isDirectory()) return listFiles(root, abs);
    if (!e.isFile()) fail(`${rel} is a symlink or other non-regular file — refusing to drop it silently`);
    return [rel];
  });
}

function writeZip(pkgDir, zipPath) {
  const entries = ['manifest.yaml', 'package.json', ...listFiles(pkgDir, join(pkgDir, 'dist'))]
    .sort();
  const zip = new yazl.ZipFile();
  for (const rel of entries) {
    zip.addBuffer(readFileSync(join(pkgDir, rel)), rel, {
      mtime: FIXED_MTIME,
      mode: FILE_MODE,
      forceDosTimestamp: true,
    });
  }
  zip.end();
  return new Promise((resolveDone, reject) => {
    const out = createWriteStream(zipPath);
    out.on('close', () => resolveDone(entries));
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
  });
}

async function main() {
  const { pkgDir, outDir, allowUnpushed } = parseArgs(process.argv.slice(2));
  const { name, version, entry } = readIdentity(pkgDir);
  const { repoRoot, headSha } = assertCleanTree(pkgDir);
  const pushed = isPushed(pkgDir);
  if (!pushed && !allowUnpushed) {
    fail(
      `HEAD ${headSha} is on no remote-tracking ref — build from the merge commit on main ` +
        '(or pass --allow-unpushed-commit for a dry run that is not publishable)',
    );
  }

  freshBuild(pkgDir, entry);

  const target = outDir ?? join(repoRoot, 'out');
  mkdirSync(target, { recursive: true });
  const zipPath = join(target, `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.zip`);
  rmSync(zipPath, { force: true });
  const entries = await writeZip(pkgDir, zipPath);
  if (!entries.includes(entry)) {
    rmSync(zipPath, { force: true });
    fail(`lifecycle.entry ${entry} is not an entry of the archive — the artifact would not load`);
  }

  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  process.stdout.write(
    `✓ ${zipPath}\n` +
      `  ${name}@${version} · ${entries.length} files\n` +
      `  commit ${headSha}${pushed ? '' : ' (NOT on any remote — NOT PUBLISHABLE)'}\n` +
      `  sha256 ${sha256}\n`,
  );
}

main().catch((err) => {
  const message = err instanceof BuildError ? err.message : (err?.stack ?? String(err));
  process.stderr.write(`build-plugin-zip: ${message}\n`);
  process.exit(1);
});
