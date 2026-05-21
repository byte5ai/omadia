import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { HttpForbiddenError, HttpRateLimitError } from '@omadia/plugin-api';

import { createHttpAccessor } from '../src/platform/httpAccessor.js';
import { HttpBlockedAddressError, isPublicIp } from '../src/platform/ssrfGuard.js';

// ---------------------------------------------------------------------------
// isPublicIp — the SSRF classifier
// ---------------------------------------------------------------------------

describe('isPublicIp', () => {
  it('accepts globally-routable IPv4', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
      assert.equal(isPublicIp(ip), true, ip);
    }
  });

  it('rejects private / loopback / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '192.0.0.1',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      assert.equal(isPublicIp(ip), false, ip);
    }
  });

  it('classifies IPv6', () => {
    assert.equal(isPublicIp('2606:4700:4700::1111'), true);
    assert.equal(isPublicIp('::1'), false); // loopback
    assert.equal(isPublicIp('::'), false); // unspecified
    assert.equal(isPublicIp('fe80::1'), false); // link-local
    assert.equal(isPublicIp('fc00::1'), false); // ULA
    assert.equal(isPublicIp('fd12:3456:789a::1'), false); // ULA
    assert.equal(isPublicIp('ff02::1'), false); // multicast
  });

  it('classifies IPv4-mapped IPv6 by the embedded address', () => {
    assert.equal(isPublicIp('::ffff:10.0.0.1'), false);
    assert.equal(isPublicIp('::ffff:169.254.169.254'), false);
    assert.equal(isPublicIp('::ffff:8.8.8.8'), true);
  });

  it('returns false for non-IP strings', () => {
    assert.equal(isPublicIp('example.com'), false);
    assert.equal(isPublicIp(''), false);
  });
});

// ---------------------------------------------------------------------------
// createHttpAccessor — static-allow-list modes
// ---------------------------------------------------------------------------

describe('createHttpAccessor — static modes', () => {
  it('rejects an undeclared host in single-host mode', async () => {
    const http = createHttpAccessor({ agentId: 'a', outbound: ['api.example.com'] });
    await assert.rejects(() => http.fetch('https://evil.com/'), HttpForbiddenError);
  });

  it('confines a non-web_scanner plugin even when audit_mode says public-web', async () => {
    const http = createHttpAccessor({
      agentId: 'a',
      outbound: ['api.example.com'],
      webScanner: false,
      auditMode: 'public-web',
    });
    await assert.rejects(() => http.fetch('https://wikipedia.org/'), HttpForbiddenError);
  });

  it('ignores extraHosts in single-host mode', async () => {
    const http = createHttpAccessor({
      agentId: 'a',
      outbound: ['api.example.com'],
      webScanner: true,
      auditMode: 'single-host',
      extraHosts: ['curated.example.org'],
    });
    await assert.rejects(
      () => http.fetch('https://curated.example.org/'),
      HttpForbiddenError,
    );
  });

  it('unions extraHosts into the allow-list in allowlist mode', async (t) => {
    const seen: string[] = [];
    t.mock.method(globalThis, 'fetch', async (u: string | URL) => {
      seen.push(String(u));
      return new Response('ok');
    });
    const http = createHttpAccessor({
      agentId: 'a',
      outbound: ['api.example.com'],
      webScanner: true,
      auditMode: 'allowlist',
      extraHosts: ['curated.example.org'],
    });
    await http.fetch('https://curated.example.org/x');
    await http.fetch('https://api.example.com/y');
    await assert.rejects(() => http.fetch('https://other.com/'), HttpForbiddenError);
    assert.deepEqual(seen, [
      'https://curated.example.org/x',
      'https://api.example.com/y',
    ]);
  });
});

// ---------------------------------------------------------------------------
// createHttpAccessor — public-web mode + SSRF guard
// ---------------------------------------------------------------------------

describe('createHttpAccessor — public-web', () => {
  it('blocks literal private / link-local / metadata IPs up front', async () => {
    const http = createHttpAccessor({
      agentId: 'a',
      outbound: [],
      webScanner: true,
      auditMode: 'public-web',
    });
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://127.0.0.1:8080/',
      'http://[::1]/',
      'http://192.168.1.1/',
    ]) {
      await assert.rejects(() => http.fetch(url), HttpBlockedAddressError, url);
    }
  });

  it('reaches fetch for an arbitrary public hostname', async (t) => {
    const seen: string[] = [];
    t.mock.method(globalThis, 'fetch', async (u: string | URL) => {
      seen.push(String(u));
      return new Response('ok');
    });
    const http = createHttpAccessor({
      agentId: 'a',
      outbound: [],
      webScanner: true,
      auditMode: 'public-web',
    });
    const res = await http.fetch('https://wikipedia.org/wiki/Main_Page');
    assert.equal(await res.text(), 'ok');
    assert.equal(seen.length, 1);
  });

  it('rejects non-http(s) URL schemes', async () => {
    const http = createHttpAccessor({ agentId: 'a', outbound: ['x.example.com'] });
    await assert.rejects(
      () => http.fetch('file:///etc/passwd'),
      HttpBlockedAddressError,
    );
  });
});

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

describe('createHttpAccessor — rate limit', () => {
  it('throws HttpRateLimitError past the per-minute cap', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
    const http = createHttpAccessor({
      agentId: 'a',
      outbound: ['x.example.com'],
      rateLimitPerMinute: 2,
    });
    await http.fetch('https://x.example.com/1');
    await http.fetch('https://x.example.com/2');
    await assert.rejects(
      () => http.fetch('https://x.example.com/3'),
      HttpRateLimitError,
    );
  });
});
