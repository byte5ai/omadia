import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Epic #470 C1 — the `@omadia/plugin-api` type surface is machine-checked.
 *
 * This package is the contract the kernel and every plugin compile against.
 * While all consumers live in this repo, a breaking change to `PluginContext`
 * compiles clean because everything is rebuilt in the same commit — the break
 * only surfaces once a plugin ships from its own repo, at install time.
 *
 * The snapshot closes that gap: any change to the emitted declarations turns
 * into a diff in the PR that causes it. The real work is in
 * `scripts/api-snapshot.mjs`; this file is the gate that makes CI run it.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'api-snapshot.mjs');

test('public .d.ts surface matches the committed golden snapshot', () => {
  let stdout: string;

  try {
    stdout = execFileSync(process.execPath, [SNAPSHOT_SCRIPT, '--check'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const { stdout: out = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    assert.fail(
      `The public type surface of @omadia/plugin-api drifted from ` +
        `api-snapshot/plugin-api.d.ts.snap.\n\n${`${out}${stderr}`.trim()}`,
    );
  }

  assert.match(
    stdout,
    /API snapshot up to date/,
    'The check reported success without confirming the snapshot — a snapshot gate ' +
      'that passes on an unexpected message is a gate that passes on nothing.',
  );
});
