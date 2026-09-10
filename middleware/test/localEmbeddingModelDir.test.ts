import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  LEGACY_MODEL_DIR,
  MODEL_DIR_ENV,
  MODEL_DIR_LEAF,
  PLATFORM_DATA_DIR_ENV,
  adoptLegacyModelDir,
  defaultModelDir,
  modelPath,
} from '@omadia/embedding-adapter-local';

/**
 * OM-97 — the keyless adapter's weights must never default into the signed
 * application bundle.
 *
 * The regression this locks down is not a crash: writing ~129 MB under
 * `Resources/omadia/middleware/var/` SUCCEEDS, and then macOS Gatekeeper
 * refuses the NEXT launch because the code signature no longer matches. The
 * user's only recovery is a reinstall, and nothing in the app says why.
 */

const REQUIRED = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  path.join('onnx', 'model_quantized.onnx'),
];

const tempRoots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om97-'));
  tempRoots.push(dir);
  return dir;
}

/** Lay down the four files `missingModelFiles` probes for. */
function seedModel(modelDir: string): void {
  const root = modelPath(modelDir);
  for (const file of REQUIRED) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x');
  }
}

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OM-97 default model directory', () => {
  it('never resolves under the adapter package itself', () => {
    // The package directory is inside the app bundle in a packaged desktop
    // build, and `var/embedding-models` used to resolve relative to it.
    const packageDir = path.resolve(
      import.meta.dirname,
      '..',
      'packages',
      'embedding-adapter-local',
    );
    const resolved = path.resolve(
      defaultModelDir({ [PLATFORM_DATA_DIR_ENV]: '/var/omadia/data' }),
    );
    assert.equal(resolved, path.join('/var/omadia/data', MODEL_DIR_LEAF));
    assert.ok(
      !resolved.startsWith(packageDir + path.sep),
      `expected the default outside ${packageDir}, got ${resolved}`,
    );
  });

  it('lets the explicit env override win over the data-dir convention', () => {
    const resolved = defaultModelDir({
      [MODEL_DIR_ENV]: '/Users/x/Library/Application Support/omadia/embedding-models',
      [PLATFORM_DATA_DIR_ENV]: '/var/omadia/data',
    });
    assert.equal(
      resolved,
      '/Users/x/Library/Application Support/omadia/embedding-models',
    );
  });

  it('falls back to the legacy path only when neither is set', () => {
    // Kept so a plain `npm run dev` checkout behaves exactly as before. Every
    // packaged deployment sets at least one of the two.
    assert.equal(defaultModelDir({}), LEGACY_MODEL_DIR);
  });

  it('ignores a blank env value rather than resolving to an empty path', () => {
    assert.equal(
      defaultModelDir({ [MODEL_DIR_ENV]: '   ', [PLATFORM_DATA_DIR_ENV]: '' }),
      LEGACY_MODEL_DIR,
    );
  });
});

describe('OM-97 legacy weight adoption', () => {
  it('moves a complete model out of the old location exactly once', async () => {
    const root = tempRoot();
    const legacy = path.join(root, 'bundle', 'var', 'embedding-models');
    const target = path.join(root, 'userData', 'embedding-models');
    seedModel(legacy);

    const first = await adoptLegacyModelDir({
      targetDir: target,
      legacyDir: legacy,
      log: () => undefined,
    });
    assert.equal(first.moved, true);
    for (const file of REQUIRED) {
      assert.ok(fs.existsSync(path.join(modelPath(target), file)), file);
    }
    // The source is gone, so a second activation has nothing left to adopt and
    // must not report a move it did not make.
    const second = await adoptLegacyModelDir({
      targetDir: target,
      legacyDir: legacy,
      log: () => undefined,
    });
    assert.equal(second.moved, false);
  });

  it('leaves a target that already holds a model untouched', async () => {
    const root = tempRoot();
    const legacy = path.join(root, 'legacy');
    const target = path.join(root, 'target');
    seedModel(legacy);
    seedModel(target);
    fs.writeFileSync(path.join(modelPath(target), 'config.json'), 'mine');

    const result = await adoptLegacyModelDir({
      targetDir: target,
      legacyDir: legacy,
      log: () => undefined,
    });
    assert.equal(result.moved, false);
    assert.equal(
      fs.readFileSync(path.join(modelPath(target), 'config.json'), 'utf8'),
      'mine',
    );
  });

  it('refuses to adopt a half-finished download', async () => {
    const root = tempRoot();
    const legacy = path.join(root, 'legacy');
    const target = path.join(root, 'target');
    seedModel(legacy);
    // An interrupted fetch: the directory exists, one required file does not.
    fs.rmSync(path.join(modelPath(legacy), 'tokenizer.json'));

    const result = await adoptLegacyModelDir({
      targetDir: target,
      legacyDir: legacy,
      log: () => undefined,
    });
    assert.equal(result.moved, false);
    assert.ok(!fs.existsSync(modelPath(target)));
  });

  it('still reports success when the copy lands but the source cannot be deleted', async () => {
    // THE REGRESSION. Removing the legacy copy is tidy-up that runs AFTER the
    // weights are safely at the new location — and it is the step most likely
    // to fail on its own, because the legacy location is a read-only
    // application bundle, which is the entire premise of OM-97. Sharing a
    // `try` with the copy turned that EPERM into "adoption failed" and sent
    // the operator off to re-download 129 MB they already had.
    const root = tempRoot();
    const legacy = path.join(root, 'legacy');
    const target = path.join(root, 'target');
    seedModel(legacy);
    // Force the cpSync fallback rather than the rename: a non-empty
    // destination makes `rename` fail exactly as a cross-volume move does.
    // The target stays INCOMPLETE, so the adoption is not skipped.
    fs.mkdirSync(modelPath(target), { recursive: true });
    fs.writeFileSync(path.join(modelPath(target), 'config.json'), 'stale');
    // Read-only parent: the copy can still read out of it, the unlink cannot.
    const legacyParent = path.dirname(modelPath(legacy));
    fs.chmodSync(legacyParent, 0o555);

    try {
      const logged: string[] = [];
      const result = await adoptLegacyModelDir({
        targetDir: target,
        legacyDir: legacy,
        log: (msg) => logged.push(msg),
      });

      assert.equal(result.moved, true, 'the weights ARE at the new location');
      for (const file of REQUIRED) {
        assert.ok(fs.existsSync(path.join(modelPath(target), file)), file);
      }
      // Said out loud rather than swallowed — it is dead disk space, and the
      // operator is the only one who can reclaim it.
      assert.ok(logged.some((m) => /could not be removed/.test(m)));
    } finally {
      fs.chmodSync(legacyParent, 0o755);
    }
  });
});
