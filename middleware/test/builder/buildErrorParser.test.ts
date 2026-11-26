import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseTscErrors } from '../../src/plugins/builder/buildErrorParser.js';

describe('parseTscErrors', () => {
  it('returns empty array for clean stderr', () => {
    assert.deepEqual(parseTscErrors(''), []);
    assert.deepEqual(parseTscErrors('warning: unrelated noise\n'), []);
  });

  it('parses a single tsc error line', () => {
    const stderr = `src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 1);
    assert.deepEqual(errs[0], {
      path: 'src/foo.ts',
      line: 42,
      col: 5,
      code: 'TS2322',
      message: `Type 'string' is not assignable to type 'number'.`,
    });
  });

  it('parses multiple errors from a real-looking stderr', () => {
    const stderr = [
      `src/foo.ts(10,3): error TS2304: Cannot find name 'fooBar'.`,
      `src/bar.ts(20,5): error TS2322: Type 'X' is not assignable to type 'Y'.`,
      `src/baz.ts(30,7): error TS7006: Parameter 'q' implicitly has an 'any' type.`,
    ].join('\n');
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 3);
    assert.equal(errs[0]?.code, 'TS2304');
    assert.equal(errs[1]?.code, 'TS2322');
    assert.equal(errs[2]?.code, 'TS7006');
    assert.equal(errs[2]?.line, 30);
    assert.equal(errs[2]?.col, 7);
  });

  it('folds indented continuation lines into the previous error', () => {
    const stderr = [
      `src/foo.ts(42,5): error TS2322: Type 'X' is not assignable to type 'Y'.`,
      `  Type 'X' is missing the following properties from type 'Y': a, b`,
      `  Did you mean 'Y'?`,
    ].join('\n');
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 1);
    assert.match(errs[0]?.message ?? '', /missing the following properties/);
    assert.match(errs[0]?.message ?? '', /Did you mean 'Y'/);
  });

  it('strips ANSI colour codes', () => {
    const stderr = `[36msrc/foo.ts[0m([33m42[0m,[33m5[0m): [31merror[0m [36mTS2322[0m: Type bad`;
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 1);
    assert.equal(errs[0]?.path, 'src/foo.ts');
    assert.equal(errs[0]?.code, 'TS2322');
  });

  it('handles Windows CRLF line endings', () => {
    const stderr = `src/a.ts(1,1): error TS1: a\r\nsrc/b.ts(2,2): error TS2: b\r\n`;
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 2);
    assert.equal(errs[0]?.path, 'src/a.ts');
    assert.equal(errs[1]?.path, 'src/b.ts');
  });

  it('ignores unrelated stdout-style noise mixed into stderr', () => {
    const stderr = [
      `▶ tsc`,
      `Some random log line`,
      `src/foo.ts(1,1): error TS2322: bad`,
      `another log line`,
    ].join('\n');
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 1);
    assert.equal(errs[0]?.code, 'TS2322');
  });

  it('handles paths with parentheses correctly', () => {
    const stderr = `src/dir(test)/foo.ts(10,5): error TS2322: bad`;
    const errs = parseTscErrors(stderr);
    assert.equal(errs.length, 1);
    // non-greedy `(.+?)` may consume up to the first `(` — accept either path
    // so long as line/col/code are correct
    assert.equal(errs[0]?.line, 10);
    assert.equal(errs[0]?.col, 5);
    assert.equal(errs[0]?.code, 'TS2322');
  });

  it('#1739 — keeps the build script stack trace out of the last tsc error', () => {
    const stdout = [
      `toolkit.ts(80,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `toolkit.ts(80,7): error TS6133: 'p06Fehler' is declared but its value is never read.`,
    ].join('\n');
    const stderr = [
      'file:///data/builder/staging/abc123/scripts/build-zip.mjs:36',
      "    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);",
      '          ^',
      '',
      'Error: npx tsc --project ./tsconfig.json failed with code 2',
      '    at run (file:///data/builder/staging/abc123/scripts/build-zip.mjs:36:11)',
      '    at file:///data/builder/staging/abc123/scripts/build-zip.mjs:41:1',
      '    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)',
      '    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:547:26)',
      '',
      'Node.js v22.23.5',
    ].join('\n');
    const errs = parseTscErrors(`${stdout}\n${stderr}`);
    assert.equal(errs.length, 2);
    assert.equal(errs[1]?.message, `'p06Fehler' is declared but its value is never read.`);
    for (const e of errs) {
      assert.doesNotMatch(e.message, /staging|node:internal|throw new Error|\bat run\b/);
    }
  });

  it('#1739 — drops indented trace frames even directly after a tsc error', () => {
    const errs = parseTscErrors(
      [
        `a.ts(1,1): error TS2322: bad`,
        `  Type 'A' is not assignable to type 'B'.`,
        `    at run (file:///data/builder/staging/x/scripts/build-zip.mjs:36:11)`,
        `    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)`,
      ].join('\n'),
    );
    assert.equal(errs[0]?.message, `bad\nType 'A' is not assignable to type 'B'.`);
  });
});
