import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  build,
  type BuildExecutionContext,
  type BuildExecutionResult,
} from '../../src/plugins/builder/buildSandbox.js';

describe('buildSandbox.build', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'build-sandbox-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function freshStagingDir(name: string): string {
    const dir = path.join(tmp, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writePackageJson(dir: string, name = 'de.byte5.agent.weather', version = '0.1.0') {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version, type: 'module' }),
    );
  }

  function writeStubZip(dir: string, name: string, version: string) {
    mkdirSync(path.join(dir, 'out'), { recursive: true });
    writeFileSync(path.join(dir, 'out', `${name}-${version}.zip`), Buffer.from('PK-stub'));
  }

  beforeEach(() => {});

  it('returns the zip buffer when build succeeds', async () => {
    const stagingDir = freshStagingDir('ok-1');
    writePackageJson(stagingDir);
    writeStubZip(stagingDir, 'de.byte5.agent.weather', '0.1.0');
    mkdirSync(path.join(stagingDir, 'node_modules'));

    const result = await build({
      stagingDir,
      executeBuild: async () => ({ exitCode: 0, stdout: '✓ built', stderr: '', reason: 'ok' }),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(Buffer.isBuffer(result.zip));
      assert.equal(result.zip.toString(), 'PK-stub');
      assert.match(result.zipPath, /weather-0\.1\.0\.zip$/);
    }
  });

  it('cleans up node_modules and out after a successful build', async () => {
    const stagingDir = freshStagingDir('ok-2');
    writePackageJson(stagingDir);
    writeStubZip(stagingDir, 'de.byte5.agent.weather', '0.1.0');
    mkdirSync(path.join(stagingDir, 'node_modules'));

    await build({
      stagingDir,
      executeBuild: async () => ({ exitCode: 0, stdout: '', stderr: '', reason: 'ok' }),
    });

    assert.equal(existsSync(path.join(stagingDir, 'node_modules')), false);
    assert.equal(existsSync(path.join(stagingDir, 'out')), false);
  });

  it('returns parsed BuildErrors when tsc fails', async () => {
    const stagingDir = freshStagingDir('tsc-err');
    writePackageJson(stagingDir);

    const stderr = [
      `src/foo.ts(10,3): error TS2304: Cannot find name 'fooBar'.`,
      `src/bar.ts(20,5): error TS2322: Type 'X' is not assignable to type 'Y'.`,
    ].join('\n');

    const result = await build({
      stagingDir,
      executeBuild: async () => ({ exitCode: 1, stdout: '▶ tsc', stderr, reason: 'ok' }),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'tsc');
      assert.equal(result.errors.length, 2);
      assert.equal(result.errors[0]?.code, 'TS2304');
      assert.equal(result.errors[1]?.code, 'TS2322');
    }
  });

  it('reports zip_missing when build succeeds but the zip is not on disk', async () => {
    const stagingDir = freshStagingDir('zip-missing');
    writePackageJson(stagingDir);
    // No zip is written.
    const result = await build({
      stagingDir,
      executeBuild: async () => ({ exitCode: 0, stdout: '', stderr: '', reason: 'ok' }),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'zip_missing');
    }
  });

  it('reports package_json_missing when package.json cannot be read', async () => {
    const stagingDir = freshStagingDir('pkg-missing');
    // No package.json
    const result = await build({
      stagingDir,
      executeBuild: async () => ({ exitCode: 0, stdout: '', stderr: '', reason: 'ok' }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'package_json_missing');
  });

  it('propagates a timeout reason from the executor', async () => {
    const stagingDir = freshStagingDir('timeout');
    writePackageJson(stagingDir);
    const result = await build({
      stagingDir,
      executeBuild: async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        reason: 'timeout',
      }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timeout');
  });

  it('propagates an abort reason from the executor', async () => {
    const stagingDir = freshStagingDir('abort');
    writePackageJson(stagingDir);
    const result = await build({
      stagingDir,
      executeBuild: async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        reason: 'abort',
      }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'abort');
  });

  it('forwards the stagingDir + timeout + maxOutputBytes to the executor', async () => {
    const stagingDir = freshStagingDir('forward');
    writePackageJson(stagingDir);

    let captured: BuildExecutionContext | null = null;
    await build({
      stagingDir,
      timeoutMs: 1234,
      maxOutputBytes: 5678,
      executeBuild: async (ctx): Promise<BuildExecutionResult> => {
        captured = ctx;
        return { exitCode: 0, stdout: '', stderr: '', reason: 'ok' };
      },
    });

    assert.ok(captured);
    assert.equal(captured!.stagingDir, path.resolve(stagingDir));
    assert.equal(captured!.timeoutMs, 1234);
    assert.equal(captured!.maxOutputBytes, 5678);
  });

  it('reports unknown reason when exitCode is non-zero with no parseable errors', async () => {
    const stagingDir = freshStagingDir('unknown');
    writePackageJson(stagingDir);
    const result = await build({
      stagingDir,
      executeBuild: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'random failure with no TS error format',
        reason: 'ok',
      }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'unknown');
      assert.equal(result.errors.length, 0);
    }
  });
});
