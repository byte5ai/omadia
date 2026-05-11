import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  annotateAll,
  annotateWithHint,
  hintFor,
} from '../../src/plugins/builder/tscErrorHints.js';

describe('tscErrorHints.hintFor', () => {
  it('returns ToolDescriptor-specific hint for TS2314 with ToolDescriptor in message', () => {
    const hint = hintFor('TS2314', `Generic type 'ToolDescriptor<I, O>' requires 2 type argument(s).`);
    assert.ok(hint);
    assert.match(hint!, /ToolDescriptor needs explicit generics/);
    assert.match(hint!, /seo-analyst/);
  });

  it('falls back to generic TS2314 hint when ToolDescriptor is not the offender', () => {
    const hint = hintFor('TS2314', `Generic type 'OtherType' requires 1 type argument(s).`);
    assert.ok(hint);
    assert.match(hint!, /generic type is missing its type arguments/i);
  });

  it('returns implicit-any hint for TS7006', () => {
    const hint = hintFor('TS7006', `Parameter 'rawInput' implicitly has an 'any' type.`);
    assert.ok(hint);
    assert.match(hint!, /z\.infer<typeof inputSchema>/);
  });

  it('returns import-guidance hint for TS2304', () => {
    const hint = hintFor('TS2304', `Cannot find name 'foo'.`);
    assert.ok(hint);
    assert.match(hint!, /Identifier not found/);
    assert.match(hint!, /imports come from the boilerplate/);
  });

  it('returns type-mismatch hint for TS2322', () => {
    const hint = hintFor('TS2322', `Type 'X' is not assignable to type 'Y'.`);
    assert.ok(hint);
    assert.match(hint!, /Type mismatch/);
  });

  it('returns null for unknown codes', () => {
    assert.equal(hintFor('TS9999', 'unknown'), null);
    assert.equal(hintFor('TS2554', 'wrong arg count'), null);
  });

  it('messageContains match is case-insensitive', () => {
    const hint = hintFor('TS2314', `'TOOLDESCRIPTOR' requires 2 type argument(s).`);
    assert.match(hint ?? '', /seo-analyst/);
  });
});

describe('tscErrorHints.annotateWithHint', () => {
  const baseError = {
    path: 'src/toolkit.ts',
    line: 10,
    col: 3,
    code: 'TS2314',
    message: `Generic type 'ToolDescriptor<I, O>' requires 2 type argument(s).`,
  };

  it('appends a Hint: line to the message when a hint matches', () => {
    const annotated = annotateWithHint(baseError);
    assert.match(annotated.message, /Generic type 'ToolDescriptor<I, O>' requires/);
    assert.match(annotated.message, /\nHint: ToolDescriptor needs explicit generics/);
  });

  it('preserves all other fields verbatim', () => {
    const annotated = annotateWithHint(baseError);
    assert.equal(annotated.path, baseError.path);
    assert.equal(annotated.line, baseError.line);
    assert.equal(annotated.col, baseError.col);
    assert.equal(annotated.code, baseError.code);
  });

  it('returns the original error unchanged when no hint matches', () => {
    const noMatch = { ...baseError, code: 'TS9999', message: 'unknown error' };
    const annotated = annotateWithHint(noMatch);
    assert.equal(annotated, noMatch);
  });
});

describe('tscErrorHints.annotateAll', () => {
  it('annotates each error in an array independently', () => {
    const errors = [
      { path: 'a.ts', line: 1, col: 1, code: 'TS2314', message: `'ToolDescriptor<I, O>' requires` },
      { path: 'b.ts', line: 2, col: 2, code: 'TS9999', message: 'no hint' },
      { path: 'c.ts', line: 3, col: 3, code: 'TS7006', message: `Parameter 'x' implicitly has an 'any' type.` },
    ];
    const annotated = annotateAll(errors);
    assert.equal(annotated.length, 3);
    assert.match(annotated[0]!.message, /Hint: ToolDescriptor/);
    assert.equal(annotated[1]!.message, 'no hint');
    assert.match(annotated[2]!.message, /Hint:.*z\.infer/);
  });

  it('returns an empty array when given an empty input', () => {
    assert.deepEqual(annotateAll([]), []);
  });
});
