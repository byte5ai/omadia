import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from '../../src/auth/loginEmail.js';

describe('isValidLoginEmail (#1321)', () => {
  it('accepts local@domain, including a dotless intranet domain', () => {
    for (const email of ['a@b', 'admin@example.com', 'first.last+tag@sub.example.de', 'admin@localhost']) {
      assert.equal(isValidLoginEmail(email), true, email);
    }
  });

  it('refuses an empty local part or domain, extra @, whitespace and control characters', () => {
    for (const email of ['', '@', 'a@', '@b', 'a@@b', 'a@b@c', 'a b@c.de', 'a@b\n', 'a\u0000@b', 'a‮@b', 'a​@b']) {
      assert.equal(isValidLoginEmail(email), false, JSON.stringify(email));
    }
  });

  it('refuses addresses longer than the RFC 5321 limit', () => {
    const local = 'a'.repeat(64);
    const domain = `${'d'.repeat(MAX_LOGIN_EMAIL_LENGTH - local.length - 1)}`;
    assert.equal(isValidLoginEmail(`${local}@${domain}`), true);
    assert.equal(isValidLoginEmail(`${local}@${domain}x`), false);
  });
});
