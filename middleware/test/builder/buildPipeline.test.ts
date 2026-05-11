import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generate } from '../../src/plugins/builder/codegen.js';
import { parseAgentSpec } from '../../src/plugins/builder/agentSpec.js';
import { _resetCacheForTests } from '../../src/plugins/builder/boilerplateSource.js';
import {
  ensureBuildTemplate,
  prepareStagingDir,
} from '../../src/plugins/builder/buildTemplate.js';
import {
  build,
  type BuildExecutionResult,
} from '../../src/plugins/builder/buildSandbox.js';
import { BuildQueue } from '../../src/plugins/builder/buildQueue.js';

/**
 * End-to-end smoke test for the Builder pipeline:
 *
 *   AgentSpec → codegen → prepareStagingDir → buildSandbox.build → ZIP
 *
 * Real `npm install` + `tsc` + `zip` are not run; the executeBuild override
 * simulates a successful build by writing a stub zip into `out/` so the
 * sandbox's post-build read path is exercised end-to-end. The point is to
 * prove that B.1 + B.2 wire together — not to validate tsc itself.
 */

describe('Builder pipeline (B.1 codegen → B.2 build)', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'builder-pipeline-test-'));
    _resetCacheForTests();
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs end-to-end and produces a zip buffer routed through the queue', async () => {
    // 1. Spec → codegen → file map
    const minimalSpec = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, 'fixtures', 'minimal-spec.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const slots = minimalSpec['slots'] as Record<string, string>;
    const { slots: _ignored, ...specInput } = minimalSpec;
    void _ignored;
    const spec = parseAgentSpec(specInput);

    const files = await generate({ spec, slots });
    assert.ok(files.size > 0);
    assert.ok(files.has('manifest.yaml'));
    assert.ok(files.has('package.json'));
    assert.ok(files.has('skills/weather-expert.md'));

    // 2. Build template (skipNpmInstall — workspace deps only)
    const templateRoot = path.join(tmp, 'build-template');
    const wsPkg = path.join(tmp, 'fake-plugin-api');
    mkdirSync(wsPkg, { recursive: true });
    writeFileSync(
      path.join(wsPkg, 'package.json'),
      JSON.stringify({ name: '@omadia/plugin-api', version: '0.1.0' }),
    );

    const ensureResult = await ensureBuildTemplate({
      templateRoot,
      npmDeps: {},
      workspaceDeps: { '@omadia/plugin-api': wsPkg },
      skipNpmInstall: true,
    });
    assert.equal(ensureResult.ready, true);

    // 3. prepareStagingDir → writes files + symlinks node_modules
    const stagingDir = await prepareStagingDir({
      templateRoot,
      draftId: 'pipeline-d1',
      buildN: 1,
      files,
      stagingBaseDir: path.join(tmp, 'staging'),
    });
    assert.ok(existsSync(path.join(stagingDir, 'package.json')));
    assert.ok(existsSync(path.join(stagingDir, 'manifest.yaml')));
    assert.ok(existsSync(path.join(stagingDir, 'node_modules')));

    // 4. Build via the queue with a stub executor that writes a fake zip.
    const queue = new BuildQueue({ concurrency: 1 });
    const buildResult = await queue.enqueue('pipeline-d1', async (signal) => {
      return build({
        stagingDir,
        signal,
        executeBuild: async (ctx): Promise<BuildExecutionResult> => {
          // Simulate a real build by reading package.json + producing the zip.
          const pkg = JSON.parse(
            readFileSync(path.join(ctx.stagingDir, 'package.json'), 'utf-8'),
          ) as { name: string; version: string };
          const outDir = path.join(ctx.stagingDir, 'out');
          mkdirSync(outDir, { recursive: true });
          writeFileSync(
            path.join(outDir, `${pkg.name}-${pkg.version}.zip`),
            Buffer.from('PK-stub-zip-bytes'),
          );
          return { exitCode: 0, stdout: '✓ built', stderr: '', reason: 'ok' };
        },
      });
    });

    // 5. Assert end-to-end success
    assert.equal(buildResult.ok, true);
    if (buildResult.ok) {
      assert.ok(Buffer.isBuffer(buildResult.zip));
      assert.equal(buildResult.zip.toString('utf-8'), 'PK-stub-zip-bytes');
      assert.match(buildResult.zipPath, /weather-0\.1\.0\.zip$/);
    }

    // node_modules + out cleanup happened after success
    assert.equal(existsSync(path.join(stagingDir, 'out')), false);
    assert.equal(existsSync(path.join(stagingDir, 'node_modules')), false);
  });

  it('surfaces tsc errors through the full pipeline', async () => {
    const minimalSpec = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, 'fixtures', 'minimal-spec.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const slots = minimalSpec['slots'] as Record<string, string>;
    const { slots: _ignored, ...specInput } = minimalSpec;
    void _ignored;
    const spec = parseAgentSpec(specInput);

    const files = await generate({ spec, slots });

    const templateRoot = path.join(tmp, 'tsc-fail-template');
    await ensureBuildTemplate({
      templateRoot,
      npmDeps: {},
      workspaceDeps: {},
      skipNpmInstall: true,
    });

    const stagingDir = await prepareStagingDir({
      templateRoot,
      draftId: 'pipeline-tsc-fail',
      buildN: 1,
      files,
      stagingBaseDir: path.join(tmp, 'staging-tsc-fail'),
    });

    const queue = new BuildQueue({ concurrency: 1 });
    const buildResult = await queue.enqueue('pipeline-tsc-fail', async (signal) => {
      return build({
        stagingDir,
        signal,
        executeBuild: async () => ({
          exitCode: 1,
          stdout: '▶ tsc',
          stderr:
            `client.ts(15,3): error TS2304: Cannot find name 'foo'.\n` +
            `toolkit.ts(8,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
          reason: 'ok',
        }),
      });
    });

    assert.equal(buildResult.ok, false);
    if (!buildResult.ok) {
      assert.equal(buildResult.reason, 'tsc');
      assert.equal(buildResult.errors.length, 2);
      assert.equal(buildResult.errors[0]?.code, 'TS2304');
      assert.equal(buildResult.errors[1]?.code, 'TS2322');
    }
  });

  it('classifies tsc errors when they land on STDOUT (default tsc behaviour)', async () => {
    // B.6-13.1 regression: tsc writes diagnostics to stdout by default;
    // pre-fix, parseTscErrors only looked at stderr → reason='unknown'.
    const minimalSpec = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, 'fixtures', 'minimal-spec.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const slots = minimalSpec['slots'] as Record<string, string>;
    const { slots: _ignored, ...specInput } = minimalSpec;
    void _ignored;
    const spec = parseAgentSpec(specInput);
    const files = await generate({ spec, slots });

    const templateRoot = path.join(tmp, 'tsc-stdout-template');
    await ensureBuildTemplate({
      templateRoot,
      npmDeps: {},
      workspaceDeps: {},
      skipNpmInstall: true,
    });
    const stagingDir = await prepareStagingDir({
      templateRoot,
      draftId: 'pipeline-tsc-stdout',
      buildN: 1,
      files,
      stagingBaseDir: path.join(tmp, 'staging-tsc-stdout'),
    });

    const queue = new BuildQueue({ concurrency: 1 });
    const buildResult = await queue.enqueue('pipeline-tsc-stdout', async (signal) => {
      return build({
        stagingDir,
        signal,
        executeBuild: async () => ({
          exitCode: 1,
          // Mirror real tsc: error lines on STDOUT, build-zip's exception
          // trace on STDERR.
          stdout:
            `▶ tsc\n` +
            `toolkit.ts(169,53): error TS2314: Generic type 'ToolDescriptor<I, O>' requires 2 type argument(s).\n` +
            `toolkit.ts(179,17): error TS7006: Parameter 'rawInput' implicitly has an 'any' type.`,
          stderr: `Error: npx tsc --project ./tsconfig.json failed with code 2`,
          reason: 'ok',
        }),
      });
    });

    assert.equal(buildResult.ok, false);
    if (!buildResult.ok) {
      assert.equal(buildResult.reason, 'tsc');
      assert.equal(buildResult.errors.length, 2);
      assert.equal(buildResult.errors[0]?.code, 'TS2314');
      assert.equal(buildResult.errors[1]?.code, 'TS7006');
      assert.equal(buildResult.errors[0]?.path, 'toolkit.ts');
      assert.equal(buildResult.errors[0]?.line, 169);
    }
  });
});
