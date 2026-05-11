import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  typecheckStaging,
  filterErrorsByFile,
  type TypecheckExecutionContext,
  type TypecheckExecutionResult,
} from '../../src/plugins/builder/typecheck.js';

function fakeExec(canned: TypecheckExecutionResult) {
  return async (_ctx: TypecheckExecutionContext): Promise<TypecheckExecutionResult> => canned;
}

describe('typecheckStaging', () => {
  it('returns ok=true for clean exit + empty output', async () => {
    const result = await typecheckStaging({
      stagingDir: '/tmp/dummy',
      executeTypecheck: fakeExec({ exitCode: 0, stdout: '', stderr: '', reason: 'ok' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.reason, 'ok');
    assert.equal(result.exitCode, 0);
  });

  it('parses tsc errors from stdout (B.6-13.1 path) and surfaces ok=false', async () => {
    const stdout = [
      `src/toolkit.ts(10,3): error TS2304: Cannot find name 'fooBar'.`,
      `src/toolkit.ts(20,5): error TS2314: Generic type 'ToolDescriptor<I, O>' requires 2 type argument(s).`,
    ].join('\n');
    const result = await typecheckStaging({
      stagingDir: '/tmp/dummy',
      executeTypecheck: fakeExec({ exitCode: 1, stdout, stderr: '', reason: 'ok' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0]?.code, 'TS2304');
    assert.equal(result.errors[1]?.code, 'TS2314');
    assert.equal(result.reason, 'tsc');
  });

  it('parses tsc errors from stderr too (legacy path)', async () => {
    const stderr = `src/foo.ts(1,1): error TS2322: bad`;
    const result = await typecheckStaging({
      stagingDir: '/tmp/dummy',
      executeTypecheck: fakeExec({ exitCode: 1, stdout: '', stderr, reason: 'ok' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.reason, 'tsc');
  });

  it('reports reason=unknown when exit non-zero but no parseable errors', async () => {
    const result = await typecheckStaging({
      stagingDir: '/tmp/dummy',
      executeTypecheck: fakeExec({
        exitCode: 1,
        stdout: '',
        stderr: 'tsc died with no diagnostics',
        reason: 'ok',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 0);
    assert.equal(result.reason, 'unknown');
  });

  it('propagates non-ok exec reasons (timeout, abort, spawn) untouched', async () => {
    for (const reason of ['timeout', 'abort', 'spawn'] as const) {
      const result = await typecheckStaging({
        stagingDir: '/tmp/dummy',
        executeTypecheck: fakeExec({
          exitCode: null,
          stdout: '',
          stderr: '',
          reason,
        }),
      });
      assert.equal(result.ok, false, `${reason} must not be ok`);
      assert.equal(result.reason, reason);
    }
  });

  it('truncates output tails to 4096 bytes with leading ellipsis marker', async () => {
    const huge = 'x'.repeat(10_000);
    const result = await typecheckStaging({
      stagingDir: '/tmp/dummy',
      executeTypecheck: fakeExec({ exitCode: 0, stdout: huge, stderr: '', reason: 'ok' }),
    });
    assert.equal(result.stdoutTail.startsWith('…'), true);
    // 4096 chars + 1 ellipsis char
    assert.equal(result.stdoutTail.length, 4097);
  });

  it('still records durationMs even when exec fails fast', async () => {
    const result = await typecheckStaging({
      stagingDir: '/tmp/dummy',
      executeTypecheck: fakeExec({ exitCode: null, stdout: '', stderr: '', reason: 'spawn' }),
    });
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
  });
});

describe('filterErrorsByFile', () => {
  const errors = [
    { path: 'src/toolkit.ts', line: 10, col: 3, code: 'TS2304', message: 'a' },
    { path: 'src/manifest.ts', line: 20, col: 5, code: 'TS2322', message: 'b' },
    { path: './src/toolkit.ts', line: 30, col: 7, code: 'TS7006', message: 'c' },
  ];

  it('returns only errors for the requested file', () => {
    const filtered = filterErrorsByFile(errors, 'src/toolkit.ts');
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0]?.code, 'TS2304');
    assert.equal(filtered[1]?.code, 'TS7006');
  });

  it('normalizes leading "./" so tsc emit-style matches caller-style', () => {
    const filtered = filterErrorsByFile(errors, './src/toolkit.ts');
    assert.equal(filtered.length, 2);
  });

  it('returns empty array when no errors match', () => {
    assert.deepEqual(filterErrorsByFile(errors, 'src/missing.ts'), []);
  });

  it('handles platform-specific path separators via path.normalize', () => {
    const filtered = filterErrorsByFile(errors, 'src/manifest.ts');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.code, 'TS2322');
  });
});
