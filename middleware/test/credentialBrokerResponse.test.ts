/**
 * #778 S3a — `brokerResponse.ts` in isolation: which forms of the secret are
 * scrubbed, the documented 8-character floor, the basic-password segment,
 * the cap-boundary straddle, and the body reader's edge cases.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MIN_SCRUBBABLE_SECRET_LENGTH,
  REDACTED,
  readBodyCapped,
  scrubBody,
  scrubSecret,
  secretForms,
  type BrokerUpstreamResponse,
} from '../src/credentials/brokerResponse.js';

const SECRET = 'sk live/secret+value 42';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function response(body: ReadableStream<Uint8Array> | null | undefined, text = ''): BrokerUpstreamResponse {
  return { status: 200, headers: [], text: async () => text, ...(body === undefined ? {} : { body }) };
}

describe('#778 S3a brokerResponse', () => {
  it('scrubs the raw, base64, URL-encoded and form-encoded forms', () => {
    const forms = secretForms(SECRET, 'bearer');
    const enc = encodeURIComponent(SECRET);
    const text = [SECRET, Buffer.from(SECRET).toString('base64'), enc, enc.replace(/%20/g, '+')].join(' | ');
    const scrubbed = scrubSecret(text, forms);
    assert.equal(scrubbed, [REDACTED, REDACTED, REDACTED, REDACTED].join(' | '));
  });

  it('matches URL-encoded hex case-insensitively (an upstream re-encoding in lowercase)', () => {
    const forms = secretForms(SECRET, 'query-param');
    const lower = encodeURIComponent(SECRET).toLowerCase();
    assert.equal(scrubSecret(`?api_key=${lower}&x=1`, forms), `?api_key=${REDACTED}&x=1`);
  });

  it(`leaves a secret shorter than ${String(MIN_SCRUBBABLE_SECRET_LENGTH)} chars unscrubbed — the documented floor`, () => {
    const short = 'abc1234';
    assert.equal(short.length, MIN_SCRUBBABLE_SECRET_LENGTH - 1);
    assert.deepEqual(secretForms(short, 'bearer'), []);
    assert.equal(scrubSecret(`token=${short}`, secretForms(short, 'bearer')), `token=${short}`);
    assert.equal(secretForms('abcd1234', 'bearer').includes('abcd1234'), true);
  });

  it('scrubs the basic-password segment on its own when it is long enough', () => {
    const forms = secretForms('svc-user:p@ss word/42', 'basic-password');
    assert.equal(scrubSecret('your password p@ss word/42 is wrong', forms), `your password ${REDACTED} is wrong`);
    assert.equal(scrubSecret(`pw=${encodeURIComponent('p@ss word/42')}`, forms), `pw=${REDACTED}`);
  });

  it('does not scrub a basic-password segment below the floor, but still scrubs the whole secret', () => {
    const forms = secretForms('svc-user:short', 'basic-password');
    assert.equal(scrubSecret('short', forms), 'short');
    assert.equal(scrubSecret('svc-user:short', forms), REDACTED);
  });

  it('scrubs the whitespace-trimmed form undici puts on the wire for a padded secret', () => {
    for (const padded of ['sk-live-abcdefgh\n', ' sk-live-abcdefgh', '\tsk-live-abcdefgh\r\n']) {
      const forms = secretForms(padded, 'bearer');
      // A padded form may take its whitespace with it (`Bearer[REDACTED]`);
      // what matters is that no trace of the secret survives.
      const out = scrubSecret('Bearer sk-live-abcdefgh', forms);
      assert.ok(out.startsWith('Bearer') && out.endsWith(REDACTED), `${JSON.stringify(padded)} -> ${out}`);
      assert.ok(!out.includes('abcdefgh'));
    }
    const basic = secretForms('svc-user:pa55word-secret ', 'basic-password');
    assert.equal(scrubSecret('password=pa55word-secret;', basic), `password=${REDACTED};`);
  });

  it('does not add a trimmed form that falls below the floor', () => {
    assert.deepEqual(secretForms('abc1234 ', 'bearer').includes('abc1234'), false);
  });

  it("scrubs the WHATWG-URL form of a query-param secret (' as %27)", () => {
    const forms = secretForms("abc'defgh!ij", 'query-param');
    assert.equal(scrubSecret('/v1/x?api_key=abc%27defgh!ij', forms), `/v1/x?api_key=${REDACTED}`);
  });

  it('scrubs the JSON-escaped form of a secret carrying a quote or backslash', () => {
    const forms = secretForms('svc-user:pa"ss\\word42', 'basic-password');
    const echoed = JSON.stringify({ password: 'pa"ss\\word42', user: 'svc-user:pa"ss\\word42' });
    assert.equal(echoed.includes('pa\\"ss'), true);
    assert.equal(scrubSecret(echoed, forms), JSON.stringify({ password: REDACTED, user: REDACTED }));
  });

  it('scrubs the PHP json_encode form that escapes / as \\/ (raw and base64)', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const phpEscape = (s: string): string => s.replace(/\//g, '\\/');
    for (const scheme of ['header', 'bearer', 'query-param'] as const) {
      const forms = secretForms(secret, scheme);
      assert.equal(scrubSecret(`{"x-api-key":"${phpEscape(secret)}"}`, forms), `{"x-api-key":"${REDACTED}"}`);
    }
    // A base64 alphabet has `/` too: `basic-password`'s Authorization echoed by PHP.
    const basic = 'svc-user:p?>?>?>?pass';
    const base64 = Buffer.from(basic).toString('base64');
    assert.ok(base64.includes('/'), base64);
    const forms = secretForms(basic, 'basic-password');
    assert.equal(scrubSecret(`{"auth":"Basic ${phpEscape(base64)}"}`, forms), `{"auth":"Basic ${REDACTED}"}`);
  });

  it('a secret straddling the cap leaves no prefix of any form at the tail', () => {
    const forms = secretForms(SECRET, 'bearer');
    const longest = Math.max(...forms.map((f) => f.length));
    for (let cut = 1; cut < SECRET.length; cut += 1) {
      const text = `${'x'.repeat(40)}${SECRET.slice(0, cut)}`;
      const out = scrubBody({ text, truncated: true }, forms);
      for (const form of forms) {
        for (let len = 1; len <= Math.min(form.length, out.length); len += 1) {
          assert.ok(!out.endsWith(form.slice(0, len)), `cut=${String(cut)} left ${form.slice(0, len)}`);
        }
      }
      assert.ok(out.length <= text.length - (longest - 1) || out.length === 0);
    }
  });

  it('an untruncated body is not trimmed', () => {
    const forms = secretForms(SECRET, 'bearer');
    assert.equal(scrubBody({ text: 'hello world', truncated: false }, forms), 'hello world');
  });

  it('readBodyCapped returns an empty body for a null stream', async () => {
    assert.deepEqual(await readBodyCapped(response(null), 10), { text: '', truncated: false });
  });

  it('readBodyCapped streams and truncates at the cap', async () => {
    assert.deepEqual(await readBodyCapped(response(streamOf('hello ', 'world')), 8), {
      text: 'hello wo',
      truncated: true,
    });
    assert.deepEqual(await readBodyCapped(response(streamOf('hello ', 'world')), 11), {
      text: 'hello world',
      truncated: false,
    });
  });

  it('a legacy text()-only stub still works and is capped', async () => {
    assert.deepEqual(await readBodyCapped(response(undefined, 'short'), 10), { text: 'short', truncated: false });
    assert.deepEqual(await readBodyCapped(response(undefined, 'much too long'), 4), { text: 'much', truncated: true });
  });

  it('readBodyCapped rejects when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('a'));
      },
    });
    const pending = readBodyCapped(response(stream), 1024, controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 10);
    await assert.rejects(pending);
  });
});
