import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { invokeWebhookPostAction } from '../src/conductor/webhookPostAction.js';
import { assertOutboundUrlAllowed, signWebhookBody, WebhookUrlNotAllowedError } from '../src/conductor/webhookOutbound.js';

// Issue #437 — the `webhook.post` Designer action and the shared SSRF guard it (and
// the outbound dispatcher) both call before ever making a request.

describe('assertOutboundUrlAllowed', () => {
  it('accepts a public http(s) URL', () => {
    assert.doesNotThrow(() => assertOutboundUrlAllowed('https://example.com/hook'));
  });

  it('rejects a non-http(s) scheme', () => {
    assert.throws(() => assertOutboundUrlAllowed('ftp://example.com/x'), WebhookUrlNotAllowedError);
  });

  it('rejects an invalid URL', () => {
    assert.throws(() => assertOutboundUrlAllowed('not a url'), WebhookUrlNotAllowedError);
  });

  it('rejects a literal private/loopback/link-local IP up front (no DNS needed)', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '::1']) {
      const url = host.includes(':') ? `http://[${host}]/x` : `http://${host}/x`;
      assert.throws(() => assertOutboundUrlAllowed(url), WebhookUrlNotAllowedError, `expected ${url} to be rejected`);
    }
  });
});

describe('signWebhookBody', () => {
  it('produces a sha256=<hex> signature the receiver can recompute', () => {
    const sig = signWebhookBody('secret', 'hello');
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(signWebhookBody('secret', 'hello'), sig); // deterministic
    assert.notEqual(signWebhookBody('other-secret', 'hello'), sig);
  });
});

describe('invokeWebhookPostAction', () => {
  it('rejects a missing url without making a request', async () => {
    await assert.rejects(() => invokeWebhookPostAction({}), /url/);
  });

  it('rejects a private-address url (SSRF guard applies to the ad-hoc action too)', async () => {
    await assert.rejects(() => invokeWebhookPostAction({ url: 'http://127.0.0.1/admin' }), WebhookUrlNotAllowedError);
  });

  it('rejects an oversized body before attempting a request', async () => {
    const big = 'x'.repeat(300_000);
    await assert.rejects(() => invokeWebhookPostAction({ url: 'https://example.com/hook', body: { big } }), /exceeds/);
  });
});
