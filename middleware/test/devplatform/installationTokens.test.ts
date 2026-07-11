import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  JobTokenRegistry,
  mintScopedInstallationToken,
  revokeInstallationToken,
  type TokenEvent,
  type TokenFetch,
} from '../../src/devplatform/githubApp/installationTokens.js';
import type { DevJob } from '../../src/devplatform/types.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** Record every request, answer from a scripted queue. */
function recorder(replies: Array<{ ok: boolean; status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let i = 0;
  const fetchImpl: TokenFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = replies[i++] ?? { ok: false, status: 500 };
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return { calls, fetchImpl };
}

describe('devplatform/installationTokens — mintScopedInstallationToken', () => {
  it('POSTs a scoped body and never mints unscoped', async () => {
    const { calls, fetchImpl } = recorder([
      { ok: true, status: 201, body: { token: 'ghs_scoped', expires_at: '2026-07-10T12:00:00Z' } },
    ]);
    const t = await mintScopedInstallationToken(
      {
        appId: '42',
        privateKey: PEM,
        installationId: '999',
        repositories: ['omadia'],
        permissions: { contents: 'read' },
      },
      () => 0,
      fetchImpl,
    );
    assert.equal(t.token, 'ghs_scoped');
    assert.equal(t.expiresAt.toISOString(), '2026-07-10T12:00:00.000Z');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/app\/installations\/999\/access_tokens$/);
    const body = JSON.parse(calls[0]!.body!) as { repositories: string[]; permissions: Record<string, string> };
    assert.deepEqual(body.repositories, ['omadia'], 'the mint is scoped to one repo');
    assert.deepEqual(body.permissions, { contents: 'read' }, 'and to the least privilege');
    assert.match(calls[0]!.headers['Authorization']!, /^Bearer /, 'authenticated as the App JWT');
  });

  it('refuses to mint without a repository scope (an empty body means ALL permissions)', async () => {
    const { fetchImpl } = recorder([]);
    await assert.rejects(
      () =>
        mintScopedInstallationToken(
          { appId: '1', privateKey: PEM, installationId: '2', repositories: [], permissions: { contents: 'read' } },
          () => 0,
          fetchImpl,
        ),
      /without a repository scope/,
    );
  });

  it('refuses to mint without a permission scope', async () => {
    const { fetchImpl } = recorder([]);
    await assert.rejects(
      () =>
        mintScopedInstallationToken(
          { appId: '1', privateKey: PEM, installationId: '2', repositories: ['r'], permissions: {} },
          () => 0,
          fetchImpl,
        ),
      /without a permission scope/,
    );
  });

  it('never echoes the response body on failure (it can reflect the JWT)', async () => {
    const { fetchImpl } = recorder([{ ok: false, status: 403, body: { message: 'jwt=SECRET-LEAK' } }]);
    await assert.rejects(
      () =>
        mintScopedInstallationToken(
          { appId: '1', privateKey: PEM, installationId: '2', repositories: ['r'], permissions: { contents: 'read' } },
          () => 0,
          fetchImpl,
        ),
      (e: unknown) => e instanceof Error && /status 403/.test(e.message) && !/SECRET-LEAK/.test(e.message),
    );
  });

  it('falls back to a 1-hour expiry when GitHub omits expires_at', async () => {
    const { fetchImpl } = recorder([{ ok: true, status: 201, body: { token: 'ghs_x' } }]);
    const t = await mintScopedInstallationToken(
      { appId: '1', privateKey: PEM, installationId: '2', repositories: ['r'], permissions: { contents: 'read' } },
      () => 1_000_000,
      fetchImpl,
    );
    assert.equal(t.expiresAt.getTime(), 1_000_000 + 60 * 60 * 1000);
  });
});

describe('devplatform/installationTokens — revokeInstallationToken', () => {
  it('DELETEs the token authenticated AS the token', async () => {
    const { calls, fetchImpl } = recorder([{ ok: true, status: 204 }]);
    await revokeInstallationToken('ghs_dead', 'https://api.github.com', fetchImpl);
    assert.equal(calls[0]!.method, 'DELETE');
    assert.match(calls[0]!.url, /\/installation\/token$/);
    assert.equal(calls[0]!.headers['Authorization'], 'token ghs_dead');
  });

  it('treats a 401 as success — the token already expired', async () => {
    const { fetchImpl } = recorder([{ ok: false, status: 401 }]);
    await assert.doesNotReject(() => revokeInstallationToken('ghs_expired', undefined, fetchImpl));
  });

  it('throws on any other non-204 status', async () => {
    const { fetchImpl } = recorder([{ ok: false, status: 500 }]);
    await assert.rejects(() => revokeInstallationToken('ghs_x', undefined, fetchImpl), /status 500/);
  });
});

function fakeJob(id: string): DevJob {
  return { id } as DevJob;
}

describe('devplatform/installationTokens — JobTokenRegistry (finalizeDevJob revocation)', () => {
  it('revokes every unexpired token of a job and appends metadata-only events', async () => {
    const events: Array<{ jobId: string; event: TokenEvent }> = [];
    const revoked: string[] = [];
    const reg = new JobTokenRegistry(
      (jobId, event) => void events.push({ jobId, event }),
      () => 1000,
      async (token) => void revoked.push(token),
    );
    await reg.record('job-1', { token: 'ghs_a', expiresAt: new Date(999_999) }, {
      installationId: '5',
      scope: 'contents:read',
      apiBaseUrl: 'https://api.github.com',
    });
    await reg.record('job-1', { token: 'ghs_b', expiresAt: new Date(999_999) }, {
      installationId: '5',
      scope: 'contents:write',
      apiBaseUrl: 'https://api.github.com',
    });
    assert.equal(reg.liveCount('job-1'), 2);

    await reg.revoker(fakeJob('job-1'));

    assert.deepEqual(revoked.sort(), ['ghs_a', 'ghs_b']);
    assert.equal(reg.liveCount('job-1'), 0);
    // Mint + revoke events, never a token value.
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('ghs_a') && !serialized.includes('ghs_b'), 'no token value in any event');
    assert.equal(events.filter((e) => e.event.action === 'mint').length, 2);
    assert.equal(events.filter((e) => e.event.action === 'revoke').length, 2);
  });

  it('skips an already-expired token but records the skip honestly', async () => {
    const events: TokenEvent[] = [];
    let revokeCalls = 0;
    const reg = new JobTokenRegistry(
      (_jobId, event) => void events.push(event),
      () => 10_000,
      async () => void revokeCalls++,
    );
    await reg.record('job-2', { token: 'ghs_old', expiresAt: new Date(5_000) }, {
      installationId: '7',
      scope: 'contents:read',
      apiBaseUrl: 'https://api.github.com',
    });
    await reg.revoker(fakeJob('job-2'));
    assert.equal(revokeCalls, 0, 'an expired token is not sent to GitHub');
    const skip = events.find((e) => e.action === 'revoke_skipped');
    assert.equal(skip?.reason, 'already_expired');
  });

  it('records a failed revoke as a skip, never throws (the token self-expires)', async () => {
    const events: TokenEvent[] = [];
    const reg = new JobTokenRegistry(
      (_jobId, event) => void events.push(event),
      () => 1000,
      async () => {
        throw new Error('github down');
      },
    );
    await reg.record('job-3', { token: 'ghs_c', expiresAt: new Date(999_999) }, {
      installationId: '9',
      scope: 'contents:read',
      apiBaseUrl: 'https://api.github.com',
    });
    await assert.doesNotReject(() => reg.revoker(fakeJob('job-3')));
    const skip = events.find((e) => e.action === 'revoke_skipped');
    assert.match(skip?.reason ?? '', /revoke_failed: github down/);
  });

  it('revokes LATER tokens even when the audit sink throws on an EXPIRED-token skip (Forge #3)', async () => {
    // The expired-token skip appends OUTSIDE any try/catch. If that append throws
    // and is not guarded, it aborts the loop and every later, still-live token is
    // never revoked — leaked until GitHub's 1-hour self-expiry.
    const revoked: string[] = [];
    const reg = new JobTokenRegistry(
      (_jobId, event) => {
        if (event.action === 'revoke_skipped' && event.reason === 'already_expired') {
          throw new Error('audit sink down');
        }
      },
      () => 10_000,
      async (token) => void revoked.push(token),
    );
    // Token 1 is EXPIRED (skip path); token 2 is live and must still be revoked.
    await reg.record('job-x', { token: 'ghs_expired', expiresAt: new Date(1_000) }, {
      installationId: '1', scope: 'contents:read', apiBaseUrl: 'https://api.github.com',
    });
    await reg.record('job-x', { token: 'ghs_live', expiresAt: new Date(999_999) }, {
      installationId: '1', scope: 'contents:read', apiBaseUrl: 'https://api.github.com',
    });
    await assert.doesNotReject(() => reg.revoker(fakeJob('job-x')));
    assert.deepEqual(revoked, ['ghs_live'], 'the live token is revoked despite the skip-event audit failure');
  });

  it('is idempotent — a second revoke of the same job is a no-op', async () => {
    let revokeCalls = 0;
    const reg = new JobTokenRegistry(
      () => {},
      () => 1000,
      async () => void revokeCalls++,
    );
    await reg.record('job-4', { token: 'ghs_d', expiresAt: new Date(999_999) }, {
      installationId: '1',
      scope: 'contents:read',
      apiBaseUrl: 'https://api.github.com',
    });
    await reg.revoker(fakeJob('job-4'));
    await reg.revoker(fakeJob('job-4'));
    assert.equal(revokeCalls, 1, 'the token is revoked exactly once');
  });
});
