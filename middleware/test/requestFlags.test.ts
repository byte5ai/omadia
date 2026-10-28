import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { isTruthyFlag } from '../src/http/requestFlags.js';

/**
 * #1455 — the consent flag behind `allow_downgrade`. What counts as consent is
 * the whole point: too narrow and an operator cannot confirm a deliberate
 * rollback, too wide and a form field nobody filled in authorises replacing a
 * running plugin with an older one.
 */
describe('isTruthyFlag', () => {
  it('accepts the spellings a client actually sends', () => {
    for (const value of ['1', 'true', 'yes', 'TRUE', 'Yes', ' true ']) {
      assert.equal(isTruthyFlag(value), true, value);
    }
  });

  it('rejects everything that is not consent', () => {
    for (const value of ['0', 'false', 'no', 'maybe', 'null', '2']) {
      assert.equal(isTruthyFlag(value), false, value);
    }
  });

  it('treats an empty value as consent only for a bare query flag', () => {
    // A multipart field left alone arrives empty — that is not a confirmation.
    assert.equal(isTruthyFlag(''), false);
    assert.equal(isTruthyFlag('  '), false);
    // `?allow_downgrade` with no `=` reaches express as an empty string, and on
    // a hand-typed URL that is the operator writing the flag.
    assert.equal(isTruthyFlag('', { bareFlag: true }), true);
    // The exception is only about emptiness; a real value still has to qualify.
    assert.equal(isTruthyFlag('false', { bareFlag: true }), false);
  });

  it('rejects non-strings, including the array a repeated parameter produces', () => {
    assert.equal(isTruthyFlag(['1', '1']), false);
    assert.equal(isTruthyFlag(['1'], { bareFlag: true }), false);
    assert.equal(isTruthyFlag(undefined), false);
    assert.equal(isTruthyFlag(null), false);
    assert.equal(isTruthyFlag(1), false);
    assert.equal(isTruthyFlag(true), false);
    assert.equal(isTruthyFlag({ allow: true }), false);
  });
});
