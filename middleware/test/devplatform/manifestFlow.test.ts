import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildManifest,
  exchangeManifestCode,
  ManifestFlowStore,
  manifestActionUrl,
  type ConversionFetch,
} from '../../src/devplatform/githubApp/manifestFlow.js';

describe('devplatform/manifestFlow — buildManifest', () => {
  it('carries the exact permission set and an INACTIVE webhook', () => {
    const m = buildManifest('https://omadia.example.com');
    assert.deepEqual(m['default_permissions'], {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    });
    const hook = m['hook_attributes'] as { active: boolean; url: string };
    assert.equal(hook.active, false, 'the W4 webhook placeholder must not fire in W2');
    assert.match(hook.url, /\/bot-api\/v1\/dev-platform\/github-app\/webhook$/);
    assert.equal(m['public'], false, 'installable only on its owner');
    assert.equal(m['redirect_url'], 'https://omadia.example.com/bot-api/v1/dev-platform/github-app/callback');
  });

  it('truncates the org suffix to GitHub’s 34-char App-name cap', () => {
    const m = buildManifest('https://x.example.com', 'a-very-long-organization-name-that-overflows');
    assert.ok((m['name'] as string).length <= 34, `name too long: ${m['name'] as string}`);
    assert.ok((m['name'] as string).startsWith('omadia-dev '));
  });

  it('strips a trailing slash from the public base url', () => {
    const m = buildManifest('https://x.example.com/');
    assert.equal(m['url'], 'https://x.example.com');
  });
});

describe('devplatform/manifestFlow — manifestActionUrl', () => {
  it('targets the org settings path for an org App', () => {
    assert.equal(
      manifestActionUrl('https://github.com', 'st8', 'byte5ai'),
      'https://github.com/organizations/byte5ai/settings/apps/new?state=st8',
    );
  });
  it('targets personal settings without an org', () => {
    assert.equal(
      manifestActionUrl('https://github.com', 'st8'),
      'https://github.com/settings/apps/new?state=st8',
    );
  });
});

describe('devplatform/manifestFlow — ManifestFlowStore', () => {
  it('round-trips a state exactly once', () => {
    const store = new ManifestFlowStore();
    const { state } = store.start({ createdBySub: 'user-1', org: 'byte5ai' });
    const flow = store.consume(state);
    assert.equal(flow?.createdBySub, 'user-1');
    assert.equal(flow?.org, 'byte5ai');
    assert.equal(store.consume(state), null, 'a state is good for exactly one callback');
  });

  it('rejects an unknown state without side effects', () => {
    const store = new ManifestFlowStore();
    store.start({ createdBySub: 'user-1' });
    assert.equal(store.consume('never-issued'), null);
    assert.equal(store.size(), 1, 'a bad state probe does not consume the real flow');
  });

  it('rejects an expired state and reaps its slot (no consume needed)', () => {
    let t = 0;
    const store = new ManifestFlowStore(1000, () => t);
    const { state } = store.start({ createdBySub: 'user-1' });
    t = 2000;
    assert.equal(store.consume(state), null);
    assert.equal(store.size(), 0, 'the expired slot is reaped');
  });
});

function recorder(reply: { ok: boolean; status: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl: ConversionFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  };
  return { calls, fetchImpl };
}

describe('devplatform/manifestFlow — exchangeManifestCode', () => {
  const ok = {
    id: 12345,
    slug: 'omadia-dev-byte5ai',
    owner: { login: 'byte5ai' },
    client_id: 'Iv1.abc',
    client_secret: 'shh',
    webhook_secret: 'whsec',
    pem: 'FAKE-PEM-FIXTURE-not-a-key',
    html_url: 'https://github.com/apps/omadia-dev-byte5ai',
  };

  it('parses a 201 conversion into split-ready credentials', async () => {
    const { calls, fetchImpl } = recorder({ ok: true, status: 201, body: ok });
    const conv = await exchangeManifestCode('code-abc', 'https://api.github.com', fetchImpl);
    assert.equal(conv.id, 12345);
    assert.equal(conv.slug, 'omadia-dev-byte5ai');
    assert.equal(conv.ownerLogin, 'byte5ai');
    assert.equal(conv.pem, ok.pem);
    assert.equal(conv.clientSecret, 'shh');
    assert.match(calls[0]!.url, /\/app-manifests\/code-abc\/conversions$/);
    assert.equal(calls[0]!.method, 'POST');
  });

  it('never leaks the PEM or secret in the error on a non-201', async () => {
    const { fetchImpl } = recorder({ ok: false, status: 422, body: { pem: 'LEAKED-PEM', message: 'bad' } });
    await assert.rejects(
      () => exchangeManifestCode('c', 'https://api.github.com', fetchImpl),
      (e: unknown) => e instanceof Error && /status 422/.test(e.message) && !/LEAKED-PEM/.test(e.message),
    );
  });

  it('rejects an incomplete conversion (missing pem) rather than persisting a broken App', async () => {
    const { fetchImpl } = recorder({ ok: true, status: 201, body: { ...ok, pem: '' } });
    await assert.rejects(() => exchangeManifestCode('c', 'https://api.github.com', fetchImpl), /incomplete App/);
  });
});
