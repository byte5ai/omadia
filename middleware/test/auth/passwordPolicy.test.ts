import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  checkNewPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '../../src/auth/passwordPolicy.js';
import { MAX_LOGIN_PASSWORD_LENGTH } from '../../src/auth/providers/LocalPasswordProvider.js';

describe('passwordPolicy', () => {
  it('sign-in and every setter share one maximum', () => {
    assert.equal(MAX_PASSWORD_LENGTH, 1024);
    assert.equal(MAX_LOGIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    assert.equal(MIN_PASSWORD_LENGTH, 8);
  });

  it('accepts 8 to 1024 code units and names what is wrong otherwise', () => {
    assert.equal(checkNewPassword('p'.repeat(7)), 'too_short');
    assert.equal(checkNewPassword('p'.repeat(8)), null);
    assert.equal(checkNewPassword('p'.repeat(1024)), null);
    assert.equal(checkNewPassword('p'.repeat(1025)), 'too_long');
  });

  it('counts UTF-16 code units, as sign-in does', () => {
    // One astral character is two code units: 512 of them are 1024 units.
    assert.equal(checkNewPassword('\u{1F511}'.repeat(512)), null);
    assert.equal(checkNewPassword(`${'\u{1F511}'.repeat(512)}p`), 'too_long');
  });
});
