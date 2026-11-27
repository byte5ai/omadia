import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOILERPLATE = path.resolve(HERE, '..', '..', 'assets', 'boilerplate');
const TEMPLATES = ['integration', 'tool'] as const;

/**
 * #1739 — a failing step of the boilerplate's build script ends with one line
 * on stderr, not an uncaught exception: Node's stack trace carries absolute
 * staging paths, and the Builder's tsc parser used to fold its indented frames
 * into the last TypeScript error.
 */
describe('boilerplate scripts/build-zip.mjs (#1739)', () => {
  it('is identical in every boilerplate', () => {
    const [first, ...rest] = TEMPLATES.map((t) =>
      readFileSync(path.join(BOILERPLATE, t, 'scripts', 'build-zip.mjs'), 'utf-8'),
    );
    for (const other of rest) assert.equal(other, first);
    assert.doesNotMatch(first!, /\bthrow\b/);
  });

  it('exits non-zero with a single line when tsc fails', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'build-zip-1739-'));
    try {
      const pkgRoot = path.join(root, 'pkg');
      mkdirSync(path.join(pkgRoot, 'scripts'), { recursive: true });
      cpSync(
        path.join(BOILERPLATE, 'integration', 'scripts', 'build-zip.mjs'),
        path.join(pkgRoot, 'scripts', 'build-zip.mjs'),
      );
      // A fake `npx` that fails like tsc with type errors.
      const binDir = path.join(root, 'bin');
      mkdirSync(binDir);
      const npx = path.join(binDir, 'npx');
      writeFileSync(npx, '#!/bin/sh\necho "a.ts(1,1): error TS2322: bad"\nexit 2\n');
      chmodSync(npx, 0o755);

      const res = spawnSync(process.execPath, ['scripts/build-zip.mjs'], {
        cwd: pkgRoot,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` },
        encoding: 'utf-8',
      });
      assert.equal(res.status, 1);
      const stderrLines = res.stderr.split('\n').filter((l) => l.trim().length > 0);
      assert.deepEqual(stderrLines, ['✗ build-zip: npx tsc --project ./tsconfig.json failed with code 2']);
      assert.doesNotMatch(res.stderr, /\s+at\s|node:internal|file:\/\/|throw new Error/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
