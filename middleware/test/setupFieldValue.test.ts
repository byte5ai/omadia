/**
 * #1958 — typed setup values: one parser for every path a `boolean` / `integer`
 * value takes (manifest default, install submission, post-install edit, a
 * legacy string read back through `ctx.config.get`), and the field-level
 * conversion the install and the post-install edit share.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { InstallSetupField } from '../src/api/admin-v1.js';
import { coerceSetupFieldValue } from '../src/plugins/installService.js';
import {
  normalizeTypedSetupValue,
  parseBooleanSetupValue,
  parseIntegerSetupValue,
} from '../src/plugins/setupFieldValue.js';

describe('parseIntegerSetupValue', () => {
  it('reads numbers and whole-number strings', () => {
    assert.equal(parseIntegerSetupValue(1800), 1800);
    assert.equal(parseIntegerSetupValue('1800'), 1800);
    assert.equal(parseIntegerSetupValue(' 1800 '), 1800);
    assert.equal(parseIntegerSetupValue('-60'), -60);
  });

  it('refuses everything that is not a whole number', () => {
    for (const raw of ['', ' ', '1.5', '1e3', '0x10', 'lots', 1.5, true, null, undefined]) {
      assert.equal(parseIntegerSetupValue(raw), undefined, `accepted ${String(raw)}`);
    }
    assert.equal(parseIntegerSetupValue(String(Number.MAX_SAFE_INTEGER + 2)), undefined);
  });
});

describe('parseBooleanSetupValue', () => {
  it("reads booleans and 'true' / 'false'", () => {
    assert.equal(parseBooleanSetupValue(true), true);
    assert.equal(parseBooleanSetupValue('false'), false);
    assert.equal(parseBooleanSetupValue('yes'), undefined);
    assert.equal(parseBooleanSetupValue(1), undefined);
  });
});

describe('normalizeTypedSetupValue', () => {
  it('converts parseable values of typed fields and leaves everything else', () => {
    assert.equal(normalizeTypedSetupValue('integer', '1800'), 1800);
    assert.equal(normalizeTypedSetupValue('boolean', 'false'), false);
    assert.equal(normalizeTypedSetupValue('integer', 'lots'), 'lots');
    assert.equal(normalizeTypedSetupValue('string', '1800'), '1800');
  });
});

describe('coerceSetupFieldValue — integer', () => {
  const ttl: InstallSetupField = {
    key: 'signed_url_ttl_sec',
    type: 'integer',
    label: { en: 'Signed URL TTL (seconds)', de: 'Signed-URL-TTL (Sekunden)' },
    required: false,
    min: 1,
  };

  it('returns a number for a valid value, from a string or a number', () => {
    assert.deepEqual(coerceSetupFieldValue(ttl, '1800'), { value: 1800 });
    assert.deepEqual(coerceSetupFieldValue(ttl, 1), { value: 1 });
  });

  it('refuses a value below `min` with code below_min and the bound as a param', () => {
    for (const raw of ['0', '-60', -60]) {
      const out = coerceSetupFieldValue(ttl, raw);
      assert.ok('error' in out, `accepted ${String(raw)}`);
      assert.equal(out.error.code, 'below_min');
      assert.deepEqual(out.error.params, { min: '1' });
    }
  });

  it('refuses a non-integer with wrong_type (empty string is not 0)', () => {
    for (const raw of ['', '1.5', 'abc']) {
      const out = coerceSetupFieldValue(ttl, raw);
      assert.ok('error' in out, `accepted ${JSON.stringify(raw)}`);
      assert.equal(out.error.code, 'wrong_type');
    }
  });

  it('accepts any integer when no `min` is declared', () => {
    const { min: _min, ...unbounded } = ttl;
    assert.deepEqual(coerceSetupFieldValue(unbounded, '-60'), { value: -60 });
  });
});
