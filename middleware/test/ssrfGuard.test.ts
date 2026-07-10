import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { assertPublicHttpsUrl, SsrfBlockedError } from '../src/services/ssrfGuard.js';

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
    ]) {
      await assert.rejects(assertPublicHttpsUrl(u), SsrfBlockedError, `should refuse ${u}`);
    }
  });

  it('refuses a malformed URL', async () => {
    await assert.rejects(assertPublicHttpsUrl('not a url'), SsrfBlockedError);
  });
});
