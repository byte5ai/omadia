import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  __clearVerificationCache,
  decodeVerifiedRecord,
  encodeVerifiedRecord,
  getCachedVerification,
  invalidate,
  keyFingerprint,
  providerIdFromApiKeyVaultKey,
  providerVerifiedAtVaultKey,
  verifyProviderCredential,
} from '../src/platform/providerCredentialVerifier.js';

/**
 * The credential probe (OM-02/03/04). The load-bearing properties under test:
 *
 *  - STATUS MAPPING. Only an outright 401 (or a 403 that says in its body it is
 *    an authentication error) may be reported as `invalid`. A 5xx, a timeout, an
 *    offline machine, or a plain 403 region/permission block must degrade to
 *    `unverified` — accusing an operator's perfectly good key of being broken
 *    during an outage is the same class of lie as the bug this module fixes.
 *  - A 2xx IS NOT PROOF. A corporate proxy answers 200 text/html for a blocked
 *    host; that must never render as a green `verified` badge.
 *  - NO REDIRECTS. `x-api-key` is a custom header, so the Fetch spec would
 *    forward it verbatim to whatever host a redirect names.
 *  - CACHE ISOLATION. Two keys for one provider id must coexist in the cache.
 *
 * Only the redirect leak test touches the network, and only 127.0.0.1 —
 * everywhere else `fetchImpl` is injected.
 */

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  init?: RequestInit;
}

/** The shape a real `models` endpoint answers with. */
function modelListResponse(status = 200): Response {
  return new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(
  responder: (url: string) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init === undefined ? {} : { init }),
    });
    return responder(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ANTHROPIC = {
  providerId: 'anthropic',
  apiKey: 'sk-ant-test-key',
  wireFormat: 'anthropic',
  baseURL: 'https://api.anthropic.com',
} as const;

describe('verifyProviderCredential — status mapping', () => {
  beforeEach(() => {
    __clearVerificationCache();
  });
  afterEach(() => {
    __clearVerificationCache();
  });

  it('maps 200 to verified and stamps verifiedAt', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'verified');
    assert.ok(v.verifiedAt, 'verifiedAt must be set on success');
    assert.ok(v.checkedAt);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/models?limit=1');
    assert.equal(calls[0]?.headers['x-api-key'], ANTHROPIC.apiKey);
    assert.equal(calls[0]?.headers['anthropic-version'], '2023-06-01');
  });

  it('maps 401 to invalid with a user-facing message', async () => {
    const { impl } = stubFetch(() => new Response('', { status: 401 }));
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'invalid');
    assert.ok(v.error && v.error.length > 0, 'invalid must explain itself');
    assert.equal(v.verifiedAt, undefined);
  });

  // OM-09 — the English `error` sentence was the ONLY thing the providers
  // panel had, so it rendered verbatim in every locale. The code is what a
  // localized catalogue can key on; `error` stays as the fallback.
  it('carries the machine code providers.key_rejected on a 401', async () => {
    const { impl } = stubFetch(() => new Response('', { status: 401 }));
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'invalid');
    assert.equal(v.code, 'providers.key_rejected');
  });

  it('sets no code on a verdict that does not accuse the key', async () => {
    for (const [label, responder] of [
      ['verified', () => modelListResponse()],
      ['unverified (500)', () => new Response('', { status: 500 })],
      ['unverified (bare 403)', () => new Response('', { status: 403 })],
    ] as const) {
      // One key, several verdicts in one test: the probe caches per key, so
      // without this the second iteration would assert against the first.
      __clearVerificationCache();
      const { impl } = stubFetch(responder);
      const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
      assert.notEqual(v.status, 'invalid', label);
      assert.equal(v.code, undefined, `${label} must carry no code`);
    }

    __clearVerificationCache();
    const { impl } = stubFetch(() => modelListResponse());
    const noKey = await verifyProviderCredential({
      ...ANTHROPIC,
      apiKey: '  ',
      fetchImpl: impl,
    });
    assert.equal(noKey.status, 'no_key');
    assert.equal(noKey.code, undefined);
  });

  // F6 — a bare 403 is NOT a credential verdict. OpenAI answers 403 for
  // "Country, region, or territory not supported"; Anthropic for org-permission
  // and region blocks. Calling any of those "your key is wrong" sends the
  // operator to rotate a key that was never the problem.
  it('maps a bare 403 to unverified — a region/permission block is not a bad key', async () => {
    const { impl } = stubFetch(() => new Response('', { status: 403 }));
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.equal(v.error, undefined, 'must not render a rejection message');
    assert.equal(v.reason, 'forbidden');
  });

  it('maps a 403 that self-identifies as an authentication error to invalid', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'invalid');
    assert.ok(v.error && v.error.length > 0);
  });

  it('maps 500 to unverified — an outage is not a bad key', async () => {
    const { impl } = stubFetch(() => new Response('', { status: 500 }));
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.equal(v.error, undefined);
  });

  it('maps 429 to unverified — a rate limit is not a bad key', async () => {
    const { impl } = stubFetch(() => new Response('', { status: 429 }));
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
  });

  it('maps a thrown network error / timeout to unverified', async () => {
    const { impl } = stubFetch(() => {
      throw new Error('The operation was aborted due to timeout');
    });
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.equal(v.error, undefined);
  });

  it('maps a 401 with an HTML body to invalid — the status is enough', async () => {
    const { impl } = stubFetch(
      () =>
        new Response('<html>nope</html>', {
          status: 401,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'invalid');
  });

  it('returns no_key for an empty key without probing', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    const v = await verifyProviderCredential({
      ...ANTHROPIC,
      apiKey: '   ',
      fetchImpl: impl,
    });
    assert.equal(v.status, 'no_key');
    assert.equal(calls.length, 0);
  });
});

/**
 * F5 — "any 2xx counts as verified" was the highest-impact defect in this
 * module. The concrete failure: an operator behind a corporate proxy that
 * answers `200 text/html` block pages for non-allowlisted hosts. A bogus key
 * probes `api.anthropic.com/v1/models`, gets the proxy's 200 HTML, and the admin
 * dashboard renders a green `verified` badge — while every chat turn fails with
 * `invalid x-api-key`. A success verdict must be earned by the BODY, not the
 * status line.
 */
describe('verifyProviderCredential — a 2xx must actually be a model list', () => {
  beforeEach(() => {
    __clearVerificationCache();
  });
  afterEach(() => {
    __clearVerificationCache();
  });

  it('does NOT verify a 200 text/html proxy block page', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(
          '<html><body>Access to this site is blocked by your organisation.</body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(
      v.status,
      'unverified',
      'a proxy block page must never read as a working credential',
    );
    assert.notEqual(v.status, 'verified');
    assert.equal(v.verifiedAt, undefined);
    assert.equal(v.reason, 'non_json_response');
  });

  it('does NOT verify a 200 with no content type at all', async () => {
    const { impl } = stubFetch(() => new Response('', { status: 200 }));
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
  });

  it('does NOT verify 200 application/json that is not a model list', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'upstream unavailable' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.equal(v.reason, 'unexpected_body');
  });

  it('does NOT verify 200 application/json that is unparseable', async () => {
    const { impl } = stubFetch(
      () =>
        new Response('{"data": [', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.equal(v.reason, 'unexpected_body');
  });

  it('verifies a genuine 200 JSON model list (no regression)', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'claude-sonnet-4-5', type: 'model' }],
            has_more: false,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'verified');
    assert.ok(v.verifiedAt);
  });

  it('verifies an Ollama-style `{ models: [...] }` list', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'verified');
  });

  it('does NOT verify an oversized body — the read is bounded, not buffered whole', async () => {
    // 128 KiB of valid JSON: past the 64 KiB cap, so the read is cut off and the
    // verdict degrades instead of the probe swallowing an endless stream.
    const huge = JSON.stringify({
      data: [{ id: 'x', pad: 'a'.repeat(128 * 1024) }],
    });
    const { impl } = stubFetch(
      () =>
        new Response(huge, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.equal(v.reason, 'unexpected_body');
  });
});

/**
 * F7 — `fetch` defaults to `redirect: 'follow'`. The Fetch spec strips
 * `Authorization` and `Cookie` on a cross-origin redirect but NOT custom
 * headers, and the anthropic probe authenticates with `x-api-key`. A followed
 * redirect therefore hands the operator's raw API key to whatever host the
 * redirect names.
 */
describe('verifyProviderCredential — never follows a redirect', () => {
  beforeEach(() => {
    __clearVerificationCache();
  });
  afterEach(() => {
    __clearVerificationCache();
  });

  it('passes redirect: "error" to fetch', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(calls[0]?.init?.redirect, 'error');
  });

  it('a 3xx degrades to unverified rather than being chased', async () => {
    const { impl } = stubFetch(
      () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example/v1/models' },
        }),
    );
    const v = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(v.status, 'unverified');
    assert.notEqual(v.status, 'verified');
  });

  it('the real fetch never forwards x-api-key across a 302 (two local servers)', async () => {
    // The stub above proves the init we pass; this proves the runtime honours it.
    // Server B records every header it is ever asked for — with `redirect:
    // "follow"` (the old behaviour) it would receive the key verbatim.
    const seen: (string | undefined)[] = [];
    let redirector: Server | undefined;
    let target: Server | undefined;
    try {
      target = createServer((req, res) => {
        seen.push(req.headers['x-api-key'] as string | undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      });
      await new Promise<void>((resolve) => {
        target?.listen(0, '127.0.0.1', resolve);
      });
      const targetPort = (target.address() as AddressInfo).port;

      redirector = createServer((_req, res) => {
        res.writeHead(302, {
          location: `http://127.0.0.1:${String(targetPort)}/v1/models`,
        });
        res.end();
      });
      await new Promise<void>((resolve) => {
        redirector?.listen(0, '127.0.0.1', resolve);
      });
      const redirectPort = (redirector.address() as AddressInfo).port;

      const v = await verifyProviderCredential({
        providerId: 'anthropic',
        apiKey: 'sk-ant-leak-canary',
        wireFormat: 'anthropic',
        baseURL: `http://127.0.0.1:${String(redirectPort)}`,
      });

      assert.equal(v.status, 'unverified', 'a redirect proves nothing');
      assert.deepEqual(
        seen,
        [],
        'the redirect target must never be contacted, let alone handed the key',
      );
      assert.ok(
        !seen.includes('sk-ant-leak-canary'),
        'the API key must never cross a redirect',
      );
    } finally {
      await new Promise<void>((resolve) => {
        if (redirector === undefined) return resolve();
        redirector.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        if (target === undefined) return resolve();
        target.close(() => resolve());
      });
    }
  });
});

describe('verifyProviderCredential — wire formats', () => {
  beforeEach(() => {
    __clearVerificationCache();
  });
  afterEach(() => {
    __clearVerificationCache();
  });

  it('probes an openai-compatible provider at {baseURL}/models with a bearer token', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    const v = await verifyProviderCredential({
      providerId: 'mistral',
      apiKey: 'mistral-key',
      wireFormat: 'openai-compatible',
      baseURL: 'https://api.mistral.ai/v1',
      fetchImpl: impl,
    });
    assert.equal(v.status, 'verified');
    assert.equal(calls[0]?.url, 'https://api.mistral.ai/v1/models');
    assert.equal(calls[0]?.headers['Authorization'], 'Bearer mistral-key');
  });

  it('falls back to the OpenAI default base URL when none is supplied', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({
      providerId: 'openai',
      apiKey: 'sk-openai',
      wireFormat: 'openai-compatible',
      fetchImpl: impl,
    });
    assert.equal(calls[0]?.url, 'https://api.openai.com/v1/models');
  });

  it('returns unverified without probing for an unprobeable wire format', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    const v = await verifyProviderCredential({
      providerId: 'weird',
      apiKey: 'some-key',
      wireFormat: 'something-else',
      fetchImpl: impl,
    });
    assert.equal(v.status, 'unverified');
    assert.equal(calls.length, 0);
  });

  it('short-circuits a keyless provider to verified with ZERO fetches', async () => {
    const { impl, calls } = stubFetch(() => new Response('', { status: 500 }));
    const v = await verifyProviderCredential({
      providerId: 'ollama',
      apiKey: 'unused',
      wireFormat: 'openai-compatible',
      requiresApiKey: false,
      fetchImpl: impl,
    });
    assert.equal(v.status, 'verified');
    assert.equal(calls.length, 0, 'a local provider must never be probed');
  });

  it('reads wireFormat / baseURL / requiresApiKey from an injected catalog', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    const catalog = {
      get: (id: string) =>
        id === 'custom'
          ? {
              wireFormat: 'openai-compatible',
              baseURL: 'https://llm.internal/v1',
              policy: { requiresApiKey: true },
            }
          : undefined,
    };
    const v = await verifyProviderCredential({
      providerId: 'custom',
      apiKey: 'k',
      catalog,
      fetchImpl: impl,
    });
    assert.equal(v.status, 'verified');
    assert.equal(calls[0]?.url, 'https://llm.internal/v1/models');
  });
});

describe('verifyProviderCredential — caching', () => {
  beforeEach(() => {
    __clearVerificationCache();
  });
  afterEach(() => {
    __clearVerificationCache();
  });

  it('serves a second call from cache without a second fetch', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    const second = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(second.status, 'verified');
    assert.equal(calls.length, 1, 'cached verdict must not re-probe');
  });

  it('force: true bypasses the cache', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    await verifyProviderCredential({ ...ANTHROPIC, force: true, fetchImpl: impl });
    assert.equal(calls.length, 2);
  });

  it('invalidate() drops the cached verdict', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    invalidate('anthropic');
    assert.equal(getCachedVerification('anthropic', ANTHROPIC.apiKey), undefined);
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(calls.length, 2);
  });

  it('a DIFFERENT key is a cache miss — a replaced key never inherits a verdict', async () => {
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(
      getCachedVerification('anthropic', 'sk-ant-a-completely-different-key'),
      undefined,
    );
    await verifyProviderCredential({
      ...ANTHROPIC,
      apiKey: 'sk-ant-a-completely-different-key',
      fetchImpl: impl,
    });
    assert.equal(calls.length, 2);
  });

  /**
   * F8 — the cache was keyed on `providerId` alone, and a fingerprint mismatch
   * DELETED the entry instead of ignoring it. Two vault scopes holding different
   * keys for one provider id therefore evicted each other on every read, so the
   * 300 s TTL never took effect and the dashboard re-probed on every render.
   */
  it('two keys for one provider id coexist — neither read evicts the other', async () => {
    const KEY_A = 'sk-ant-scope-a';
    const KEY_B = 'sk-ant-scope-b';
    const { impl, calls } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, apiKey: KEY_A, fetchImpl: impl });
    await verifyProviderCredential({ ...ANTHROPIC, apiKey: KEY_B, fetchImpl: impl });
    assert.equal(calls.length, 2, 'each distinct key needs its own probe');

    // Interleaved reads. Under the old key-on-providerId cache, EVERY one of
    // these lookups deleted the other key's entry, so the second read of each
    // pair returned undefined.
    for (let i = 0; i < 3; i += 1) {
      assert.ok(
        getCachedVerification('anthropic', KEY_A),
        `key A must stay cached across read ${String(i)}`,
      );
      assert.ok(
        getCachedVerification('anthropic', KEY_B),
        `key B must stay cached across read ${String(i)}`,
      );
    }

    // And neither re-probes.
    await verifyProviderCredential({ ...ANTHROPIC, apiKey: KEY_A, fetchImpl: impl });
    await verifyProviderCredential({ ...ANTHROPIC, apiKey: KEY_B, fetchImpl: impl });
    assert.equal(calls.length, 2, 'both verdicts must still be served from cache');
  });

  it('invalidate() clears EVERY key cached for that provider id', async () => {
    const KEY_A = 'sk-ant-scope-a';
    const KEY_B = 'sk-ant-scope-b';
    const { impl } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, apiKey: KEY_A, fetchImpl: impl });
    await verifyProviderCredential({ ...ANTHROPIC, apiKey: KEY_B, fetchImpl: impl });

    invalidate('anthropic');

    assert.equal(getCachedVerification('anthropic', KEY_A), undefined);
    assert.equal(
      getCachedVerification('anthropic', KEY_B),
      undefined,
      'a key write must not leave the previous key a stale verdict to inherit',
    );
  });

  it('invalidate() leaves other providers alone', async () => {
    const { impl } = stubFetch(() => modelListResponse());
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    await verifyProviderCredential({
      providerId: 'openai',
      apiKey: 'sk-openai',
      wireFormat: 'openai',
      fetchImpl: impl,
    });

    invalidate('anthropic');

    assert.equal(getCachedVerification('anthropic', ANTHROPIC.apiKey), undefined);
    assert.ok(getCachedVerification('openai', 'sk-openai'));
  });

  it('bounds its size — a key-rotation loop cannot grow the cache without limit', async () => {
    const { impl } = stubFetch(() => modelListResponse());
    // Well past the 64-entry cap.
    for (let i = 0; i < 200; i += 1) {
      await verifyProviderCredential({
        ...ANTHROPIC,
        apiKey: `sk-ant-rotation-${String(i)}`,
        fetchImpl: impl,
      });
    }
    // The oldest must have been evicted; the newest must still be there.
    assert.equal(
      getCachedVerification('anthropic', 'sk-ant-rotation-0'),
      undefined,
      'the cache must evict, not grow forever',
    );
    assert.ok(getCachedVerification('anthropic', 'sk-ant-rotation-199'));
  });

  it('caches an invalid verdict too (no probe storm on a dead key)', async () => {
    const { impl, calls } = stubFetch(() => new Response('', { status: 401 }));
    await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    const second = await verifyProviderCredential({ ...ANTHROPIC, fetchImpl: impl });
    assert.equal(second.status, 'invalid');
    assert.equal(calls.length, 1);
  });
});

describe('durable verification record', () => {
  it('round-trips a record for the same key', () => {
    const raw = encodeVerifiedRecord(
      '2026-08-03T10:00:00.000Z',
      keyFingerprint('sk-ant-k'),
    );
    assert.equal(decodeVerifiedRecord(raw, 'sk-ant-k'), '2026-08-03T10:00:00.000Z');
  });

  it('rejects a record written for a different key', () => {
    const raw = encodeVerifiedRecord(
      '2026-08-03T10:00:00.000Z',
      keyFingerprint('sk-ant-old'),
    );
    assert.equal(decodeVerifiedRecord(raw, 'sk-ant-new'), undefined);
  });

  it('rejects absent or unparseable records rather than claiming verified', () => {
    assert.equal(decodeVerifiedRecord(undefined, 'k'), undefined);
    assert.equal(decodeVerifiedRecord('', 'k'), undefined);
    assert.equal(decodeVerifiedRecord('2026-08-03T10:00:00.000Z', 'k'), undefined);
    assert.equal(decodeVerifiedRecord('{"at":123}', 'k'), undefined);
  });

  it('never stores the key itself in the fingerprint', () => {
    const fp = keyFingerprint('sk-ant-super-secret');
    assert.ok(!fp.includes('sk-ant'));
    assert.equal(fp.length, 16);
  });
});

describe('vault key helpers', () => {
  it('derives the verified_at sibling key', () => {
    assert.equal(
      providerVerifiedAtVaultKey('anthropic'),
      'provider:anthropic/verified_at',
    );
  });

  it('recovers a provider id from a canonical api-key vault key', () => {
    assert.equal(
      providerIdFromApiKeyVaultKey('provider:anthropic/api_key'),
      'anthropic',
    );
    assert.equal(
      providerIdFromApiKeyVaultKey('provider:openai-compatible/api_key'),
      'openai-compatible',
    );
    // Legacy flat key and unrelated keys must not be mistaken for one.
    assert.equal(providerIdFromApiKeyVaultKey('anthropic_api_key'), undefined);
    assert.equal(
      providerIdFromApiKeyVaultKey('provider:anthropic/verified_at'),
      undefined,
    );
  });
});
