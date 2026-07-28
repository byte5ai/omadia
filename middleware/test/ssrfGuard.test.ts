import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { assertPublicHttpsUrl, isInternalHost, isInternalIp, SsrfBlockedError } from '../src/services/ssrfGuard.js';

describe('assertPublicHttpsUrl', () => {
  it('accepts a public https URL', async () => {
    await assertPublicHttpsUrl('https://www.strava.com/api/v3/oauth/token');
  });

  it('refuses non-https', async () => {
    await assert.rejects(assertPublicHttpsUrl('http://www.strava.com/token'), SsrfBlockedError);
  });

  it('refuses literal internal / loopback / metadata hosts', async () => {
    for (const u of [
      'https://127.0.0.1/token',
      'https://10.1.2.3/token',
      'https://192.168.1.1/token',
      'https://169.254.169.254/latest',
      'https://metadata.google.internal/computeMetadata',
      'https://localhost/token',
      'https://foo.internal/token',
      // trailing-dot FQDN — same target, must not slip past the name predicates.
      'https://metadata.google.internal./computeMetadata',
      'https://localhost./token',
      'https://foo.internal./token',
      // IPv4-mapped IPv6. `new URL()` canonicalises the dotted form to hex
      // (`[::ffff:7f00:1]`), which used to slip past the v4 range checks.
      'https://[::ffff:127.0.0.1]/token',
      'https://[::ffff:7f00:1]/token',
      'https://[::ffff:10.1.2.3]/token',
      'https://[::ffff:a9fe:a9fe]/latest',
      'https://[::1]/token',
    ]) {
      await assert.rejects(assertPublicHttpsUrl(u), SsrfBlockedError, `should refuse ${u}`);
    }
  });

  it('classifies IPv4-mapped IPv6 literals in both spellings', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:a9fe:a9fe']) {
      assert.equal(isInternalIp(ip), true, `isInternalIp should flag ${ip}`);
      assert.equal(isInternalHost(ip), true, `isInternalHost should flag ${ip}`);
    }
    // A public address in the same mapped form must still be allowed.
    assert.equal(isInternalIp('::ffff:8.8.8.8'), false);
    assert.equal(isInternalIp('::ffff:808:808'), false);
  });

  it('refuses a malformed URL', async () => {
    await assert.rejects(assertPublicHttpsUrl('not a url'), SsrfBlockedError);
  });
});
