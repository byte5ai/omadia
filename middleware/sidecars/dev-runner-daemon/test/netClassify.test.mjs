/**
 * Epic #470 W1 — parity test for the daemon's egress-entry classifier.
 *
 * `src/netClassify.mjs` is a COPY of the middleware's own classifier
 * (`middleware/src/devplatform/deriveJobPolicy.ts` → `classifyEgressEntry`, and
 * the `ssrfGuard.ts` IP predicates). The copy is deliberate — the daemon is a
 * standalone sidecar and must not import the middleware's TypeScript — so this
 * table is the guard against the two drifting: every case below states what the
 * middleware's classifier does, and the daemon copy must agree.
 *
 * Keep this table in lockstep with `middleware/test/ssrfGuard.test.ts` and the
 * `deriveJobPolicy` egress-validation tests: a change on either side that lets
 * the two classifications diverge fails here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { classifyEgressEntry, isInternalIp } from '../src/netClassify.mjs';

describe('netClassify — classifyEgressEntry parity with the middleware', () => {
  /** @type {Array<[string, string]>} accepted: input → expected canonical host */
  const ACCEPTED = [
    ['github.com', 'github.com'],
    ['GitHub.com', 'github.com'],
    ['codeload.github.com', 'codeload.github.com'],
    ['registry.npmjs.org', 'registry.npmjs.org'],
    // operator-chosen internal NAMES are kept (a deliberate allowlist choice,
    // unlike a raw metadata-range IP literal) — parity with the middleware.
    ['artifactory.internal', 'artifactory.internal'],
    ['host.local', 'host.local'],
    // a single trailing FQDN dot is normalised away.
    ['example.com.', 'example.com'],
    ['a-b.example', 'a-b.example'],
  ];
  for (const [input, host] of ACCEPTED) {
    it(`accepts ${JSON.stringify(input)} as ${host}`, () => {
      assert.deepEqual(classifyEgressEntry(input), { host });
    });
  }

  /** @type {Array<[string, string]>} rejected: input → substring of the reason */
  const REJECTED = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['git\thub.com', 'whitespace/control char'],
    ['git hub.com', 'whitespace/control char'],
    ['https://github.com', 'scheme'],
    ['ssh://github.com', 'scheme'],
    ['github.com/evil', 'path/userinfo'],
    ['github.com?x=1', 'path/userinfo'],
    ['github.com#frag', 'path/userinfo'],
    ['user@github.com', 'path/userinfo'],
    ['github.com@169.254.169.254', 'path/userinfo'],
    ['*.evil.example', 'wildcard'],
    // `host:port` is scheme-shaped, so it trips the scheme check first — same as
    // the middleware. The port/IPv6 branch below catches the forms that are NOT
    // scheme-shaped (a bare IPv6 literal starting with ':').
    ['github.com:8080', 'scheme'],
    ['::1', 'port or is an IPv6 literal'],
    ['[::ffff:127.0.0.1]', 'port or is an IPv6 literal'],
    ['8.8.8.8', 'IP literal'],
    ['169.254.169.254', 'IP literal'],
    ['10.0.0.1', 'IP literal'],
    ['192.168.1.1', 'IP literal'],
    ['172.16.0.1', 'IP literal'],
    ['127.0.0.1', 'IP literal'],
    ['0.0.0.0', 'IP literal'],
    ['169.254.169.254.', 'IP literal'], // trailing dot normalised, still an IP
    // Non-dotted IPv4 spellings the WHATWG URL parser canonicalises to loopback/
    // RFC1918 — a label-shaped match would allowlist them under a numeric "name".
    ['2130706433', 'bare hostname'], // → 127.0.0.1
    ['0x7f.0.0.1', 'bare hostname'], // → 127.0.0.1
    ['017700000001', 'bare hostname'], // → 127.0.0.1
    ['3232235777', 'bare hostname'], // → 192.168.1.1
    ['127.1', 'bare hostname'], // → 127.0.0.1
    // Bracketed IPv6 + IPv4-mapped-IPv6 literals (the `:` trips the IPv6 branch).
    ['[::ffff:7f00:1]', 'port or is an IPv6 literal'],
    ['[::1]', 'port or is an IPv6 literal'],
    ['[::ffff:127.0.0.1]', 'port or is an IPv6 literal'],
    ['-bad.example', 'not a valid hostname'],
    ['bad-.example', 'not a valid hostname'],
    ['example..com', 'not a valid hostname'],
    ['example.com..', 'not a valid hostname'],
  ];
  for (const [input, reason] of REJECTED) {
    it(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      const c = classifyEgressEntry(input);
      assert.ok('reject' in c, `expected ${JSON.stringify(input)} to be rejected`);
      assert.ok(
        c.reject.includes(reason),
        `expected reason for ${JSON.stringify(input)} to include ${JSON.stringify(reason)}, got ${JSON.stringify(c.reject)}`,
      );
    });
  }

  it('rejects a non-string entry', () => {
    assert.deepEqual(classifyEgressEntry(42), { reject: 'not a string' });
    assert.deepEqual(classifyEgressEntry(null), { reject: 'not a string' });
    assert.deepEqual(classifyEgressEntry(undefined), { reject: 'not a string' });
  });
});

describe('netClassify — isInternalIp parity with ssrfGuard', () => {
  const INTERNAL = [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fc00::1',
    'fe80::1',
  ];
  for (const ip of INTERNAL) {
    it(`flags ${ip} as internal`, () => assert.equal(isInternalIp(ip), true));
  }

  const PUBLIC = ['8.8.8.8', '1.1.1.1', '140.82.112.3', '172.15.0.1', '172.32.0.1', '2606:4700::1'];
  for (const ip of PUBLIC) {
    it(`treats ${ip} as public`, () => assert.equal(isInternalIp(ip), false));
  }
});
