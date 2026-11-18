import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { invokeWebhookPostAction } from '../src/conductor/webhookPostAction.js';
import { assertOutboundUrlAllowed, signWebhookBody, WebhookUrlNotAllowedError } from '../src/conductor/webhookOutbound.js';
import type { postWebhook, PostWebhookResult } from '../src/conductor/webhookOutbound.js';

/** A `postWebhook` stand-in: records the one request made, answers with that status.
 *  `ok` is derived, never passed — the action must not be fed a contradictory fixture. */
function fakeSend(res: { status: number; bodySnippet?: string }) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const send = (req: { url: string; headers: Record<string, string>; body: string }): Promise<PostWebhookResult> => {
    calls.push(req);
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      bodySnippet: res.bodySnippet ?? '',
    });
  };
  return { send: send as unknown as typeof postWebhook, calls };
}

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

// Issue #1703 — a receiver that refuses must not advance the graph like a delivered
// one. The throwing cases (guard rejection, oversized body) are the describe above:
// there is no response to branch on, and they reach `postWebhook` itself, so they
// must NOT run through the fake. The action REPORTS the refusal (the engine turns it into a failed step via
// WEBHOOK_POST_DEFAULT_POSTCONDITION); it throws only where there is no response to
// branch on. The step-level half of this lives in conductorWebhookPostStepOutcome.test.ts.
describe('invokeWebhookPostAction response handling (#1703)', () => {
  it('reports a 2xx as ok', async () => {
    const { send, calls } = fakeSend({ status: 204 });
    const out = await invokeWebhookPostAction({ url: 'https://example.com/hook', body: { a: 1 } }, { send });
    assert.deepEqual(JSON.parse(out), { ok: true, status: 204 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body, '{"a":1}');
  });

  it('reports a 5xx as not-ok, with the status, rather than throwing', async () => {
    const { send } = fakeSend({ status: 500 });
    const out = await invokeWebhookPostAction({ url: 'https://example.com/hook' }, { send });
    assert.deepEqual(JSON.parse(out), { ok: false, status: 500 });
  });

  it('reports the out-of-quota 429 from the report the same way', async () => {
    const { send } = fakeSend({ status: 429, bodySnippet: 'rate limit exceeded' });
    const out = await invokeWebhookPostAction({ url: 'https://example.com/hook' }, { send });
    assert.deepEqual(JSON.parse(out), { ok: false, status: 429 });
  });
});
