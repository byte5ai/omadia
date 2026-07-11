import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  checkBranchProtection,
  type BranchProtectionFetch,
} from '../../src/devplatform/branchProtectionCheck.js';

const TOKEN = 'gho_branchProtectionSecret';

interface Capture {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(status: number, capture?: Capture): BranchProtectionFetch {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.headers = init.headers;
    }
    return { ok: status >= 200 && status < 300, status };
  };
}

const base = {
  owner: 'byte5ai',
  repo: 'omadia',
  branch: 'main',
  token: TOKEN,
  apiBaseUrl: 'https://api.example.test',
};

describe('checkBranchProtection', () => {
  it('200 -> ok: true', async () => {
    const r = await checkBranchProtection({ ...base, fetchImpl: fakeFetch(200) });
    assert.equal(r.ok, true);
    assert.ok(r.checkedAt instanceof Date);
  });

  it('404 -> ok: false (unprotected)', async () => {
    const r = await checkBranchProtection({ ...base, fetchImpl: fakeFetch(404) });
    assert.equal(r.ok, false);
  });

  it('403 -> ok: null (could not verify)', async () => {
    const r = await checkBranchProtection({ ...base, fetchImpl: fakeFetch(403) });
    assert.equal(r.ok, null);
  });

  it('any other status throws without echoing the token', async () => {
    await assert.rejects(
      () => checkBranchProtection({ ...base, fetchImpl: fakeFetch(500) }),
      (err: Error) => {
        assert.match(err.message, /status 500/);
        assert.ok(!err.message.includes(TOKEN));
        return true;
      },
    );
  });

  it('hits the protection endpoint with a Bearer token', async () => {
    const cap = { url: '', headers: {} as Record<string, string> };
    await checkBranchProtection({ ...base, fetchImpl: fakeFetch(200, cap) });
    assert.equal(
      cap.url,
      'https://api.example.test/repos/byte5ai/omadia/branches/main/protection',
    );
    assert.equal(cap.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('preserves slashes in a feature-branch name', async () => {
    const cap = { url: '', headers: {} as Record<string, string> };
    await checkBranchProtection({
      ...base,
      branch: 'release/2026-07',
      fetchImpl: fakeFetch(200, cap),
    });
    assert.match(cap.url, /\/branches\/release\/2026-07\/protection$/);
  });
});
