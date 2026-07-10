/**
 * Epic #470 W1 — egress-proxy policy engine tests (spec §6). PURE-function level:
 * every allow/deny path, canonicalisation, the rebinding classifier, the job
 * registry's self-expiry, and the batched event client's flush semantics. The
 * socket layer is driven over REAL sockets in `proxy.test.mjs` (lesson (g)).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_ALLOWED_PORTS,
  JobRegistry,
  canonicalizeHost,
  classifyResolvedAddresses,
  compileAllowlist,
  createEventClient,
  decideRequest,
  hostMatchesAllowlist,
  parseAuthority,
  parseProxyAuthorization,
} from '../src/egressPolicy.mjs';

const PORTS = new Set(DEFAULT_ALLOWED_PORTS);
const TOKEN = 'proxy-token-abcdefghijklmnop';

/** A registry with one job registered; clock is fixed unless overridden. */
function registryWith(allowlist, { jobId = 'job-1', proxyToken = TOKEN, ttlSec = 180, now = () => 1000 } = {}) {
  const registry = new JobRegistry({ now });
  registry.register(jobId, { allowlist, proxyToken, ttlSec });
  return registry;
}

// ---------------------------------------------------------------------------

describe('parseAuthority — canonicalise THEN classify (lesson (a))', () => {
  it('canonicalises numeric / hex / octal IPv4 spellings to dotted-quad', () => {
    assert.deepEqual(parseAuthority('2130706433:443', 443), { host: '127.0.0.1', port: 443 });
    assert.deepEqual(parseAuthority('0x7f.0.0.1:443', 443), { host: '127.0.0.1', port: 443 });
    assert.deepEqual(parseAuthority('017700000001:443', 443), { host: '127.0.0.1', port: 443 });
    assert.deepEqual(parseAuthority('3232235777:443', 443), { host: '192.168.1.1', port: 443 });
    assert.deepEqual(parseAuthority('127.1:443', 443), { host: '127.0.0.1', port: 443 });
  });

  it('canonicalises trailing-dot FQDNs, bracketed and IPv4-mapped IPv6', () => {
    assert.deepEqual(parseAuthority('github.com.:443', 443), { host: 'github.com', port: 443 });
    assert.deepEqual(parseAuthority('GitHub.com:443', 443), { host: 'github.com', port: 443 });
    assert.deepEqual(parseAuthority('[::1]:443', 443), { host: '::1', port: 443 });
    assert.deepEqual(parseAuthority('[::ffff:7f00:1]:443', 443), { host: '::ffff:7f00:1', port: 443 });
  });

  it('applies the default port when none is given', () => {
    assert.deepEqual(parseAuthority('github.com', 443), { host: 'github.com', port: 443 });
  });

  it('rejects an authority carrying userinfo, a path, a query, or a fragment', () => {
    assert.equal(parseAuthority('user@github.com:443', 443), null);
    assert.equal(parseAuthority('github.com:443/evil', 443), null);
    assert.equal(parseAuthority('github.com:443?x=1', 443), null);
    assert.equal(parseAuthority('github.com:443#f', 443), null);
    assert.equal(parseAuthority('', 443), null);
    assert.equal(parseAuthority(undefined, 443), null);
  });
});

describe('canonicalizeHost', () => {
  it('lowercases, strips brackets and a trailing dot', () => {
    assert.equal(canonicalizeHost('GitHub.com.'), 'github.com');
    assert.equal(canonicalizeHost('[::1]'), '::1');
  });
});

describe('compileAllowlist — build allowlists, never scrub (lesson (b))', () => {
  it('compiles bare hosts (canonical) and *.suffix wildcards', () => {
    const c = compileAllowlist(['GitHub.com', 'registry.npmjs.org', '*.githubusercontent.com']);
    assert.ok(c.exact.has('github.com'));
    assert.ok(c.exact.has('registry.npmjs.org'));
    assert.deepEqual(c.suffixes, ['githubusercontent.com']);
  });

  it('rejects an IP literal, a scheme, a port, or a bad wildcard suffix', () => {
    assert.throws(() => compileAllowlist(['169.254.169.254']), /IP literal/);
    assert.throws(() => compileAllowlist(['https://github.com']), /scheme/);
    // `host:port` is scheme-shaped so it trips the scheme check first (parity with
    // netClassify); a bare IPv6 literal exercises the port/IPv6 branch.
    assert.throws(() => compileAllowlist(['github.com:443']), /scheme/);
    assert.throws(() => compileAllowlist(['::1']), /port or is an IPv6 literal/);
    assert.throws(() => compileAllowlist(['*.169.254.169.254']), /IP literal/);
    assert.throws(() => compileAllowlist([42]), /not a string/);
  });

  it('caps the number of entries', () => {
    assert.throws(() => compileAllowlist(new Array(513).fill('a.example')), /cap/);
  });
});

describe('hostMatchesAllowlist', () => {
  const c = compileAllowlist(['github.com', '*.githubusercontent.com']);
  it('matches exact hosts', () => assert.equal(hostMatchesAllowlist('github.com', c), true));
  it('matches a wildcard with a leading label', () =>
    assert.equal(hostMatchesAllowlist('raw.githubusercontent.com', c), true));
  it('does NOT match the bare wildcard suffix', () =>
    assert.equal(hostMatchesAllowlist('githubusercontent.com', c), false));
  it('does NOT match a lookalike suffix', () =>
    assert.equal(hostMatchesAllowlist('evilgithub.com', c), false));
  it('does NOT substring-match', () => assert.equal(hostMatchesAllowlist('github.com.evil.tld', c), false));
});

describe('parseProxyAuthorization', () => {
  it('parses Basic base64(jobId:proxyToken)', () => {
    const header = `Basic ${Buffer.from('job-1:secret').toString('base64')}`;
    assert.deepEqual(parseProxyAuthorization(header), { jobId: 'job-1', proxyToken: 'secret' });
  });
  it('keeps a colon inside the token', () => {
    const header = `Basic ${Buffer.from('job-1:a:b:c').toString('base64')}`;
    assert.deepEqual(parseProxyAuthorization(header), { jobId: 'job-1', proxyToken: 'a:b:c' });
  });
  it('rejects a missing scheme, a missing colon, or an empty part', () => {
    assert.equal(parseProxyAuthorization(undefined), null);
    assert.equal(parseProxyAuthorization('Bearer x'), null);
    assert.equal(parseProxyAuthorization(`Basic ${Buffer.from('nocolon').toString('base64')}`), null);
    assert.equal(parseProxyAuthorization(`Basic ${Buffer.from(':secret').toString('base64')}`), null);
    assert.equal(parseProxyAuthorization(`Basic ${Buffer.from('job:').toString('base64')}`), null);
  });
});

describe('JobRegistry — self-expiry and canonicalisation', () => {
  it('registers, looks up, and canonicalises the stored allowlist', () => {
    const registry = registryWith(['GitHub.com']);
    const rec = registry.get('job-1');
    assert.ok(rec);
    assert.ok(hostMatchesAllowlist('github.com', rec.allowlist));
    assert.equal(registry.size(), 1);
  });

  it('reports an expired registration as absent and prunes it', () => {
    let clock = 1000;
    const registry = new JobRegistry({ now: () => clock });
    registry.register('job-1', { allowlist: ['github.com'], proxyToken: TOKEN, ttlSec: 10 });
    assert.ok(registry.get('job-1'));
    clock = 1000 + 10_001; // TTL elapsed
    assert.equal(registry.get('job-1'), null);
    assert.equal(registry.size(), 0);
  });

  it('deletes on demand and refuses a bad registration', () => {
    const registry = registryWith(['github.com']);
    assert.equal(registry.delete('job-1'), true);
    assert.equal(registry.delete('job-1'), false);
    assert.throws(() => registry.register('job-2', { allowlist: ['github.com'], proxyToken: '', ttlSec: 10 }), /proxyToken/);
    assert.throws(() => registry.register('job-2', { allowlist: ['github.com'], proxyToken: TOKEN, ttlSec: 0 }), /ttlSec/);
    assert.throws(() => registry.register('job-2', { allowlist: ['1.2.3.4'], proxyToken: TOKEN, ttlSec: 10 }), /IP literal/);
  });
});

describe('decideRequest — default-deny decision order (spec §6)', () => {
  const ctx = (registry, extra = {}) => ({ registry, allowedPorts: PORTS, ...extra });

  it('407 bad_auth on absent, wrong-token, or unknown-job auth', () => {
    const registry = registryWith(['github.com']);
    // no auth
    assert.deepEqual(
      decideRequest({ host: 'github.com', port: 443 }, ctx(registry)),
      { decision: 'deny', status: 407, reason: 'bad_auth', allowInternal: false, matched: null },
    );
    // wrong token
    assert.equal(
      decideRequest({ jobId: 'job-1', proxyToken: 'wrong', host: 'github.com', port: 443 }, ctx(registry)).reason,
      'bad_auth',
    );
    // unknown job
    assert.equal(
      decideRequest({ jobId: 'nope', proxyToken: TOKEN, host: 'github.com', port: 443 }, ctx(registry)).reason,
      'bad_auth',
    );
  });

  it('allows an allowlisted host on an allowed port', () => {
    const registry = registryWith(['github.com', '*.githubusercontent.com']);
    const d = decideRequest({ jobId: 'job-1', proxyToken: TOKEN, host: 'github.com', port: 443 }, ctx(registry));
    assert.equal(d.decision, 'allow');
    assert.equal(d.allowInternal, false);
    assert.equal(d.matched, 'allowlist');
    assert.equal(
      decideRequest({ jobId: 'job-1', proxyToken: TOKEN, host: 'raw.githubusercontent.com', port: 443 }, ctx(registry)).decision,
      'allow',
    );
  });

  it('denies a non-allowlisted host (default-deny)', () => {
    const registry = registryWith(['github.com']);
    const d = decideRequest({ jobId: 'job-1', proxyToken: TOKEN, host: 'evil.example', port: 443 }, ctx(registry));
    assert.deepEqual(d, { decision: 'deny', status: 403, reason: 'not_allowlisted', allowInternal: false, matched: null });
  });

  it('denies a disallowed port even on an allowlisted host', () => {
    const registry = registryWith(['github.com']);
    const d = decideRequest({ jobId: 'job-1', proxyToken: TOKEN, host: 'github.com', port: 22 }, ctx(registry));
    assert.equal(d.reason, 'port_not_allowed');
  });

  it('allows the single internal destination with allowInternal (bypassing port + rebind)', () => {
    const registry = registryWith(['github.com']);
    const c = ctx(registry, { internalHost: 'middleware', internalPort: 8080 });
    const d = decideRequest({ jobId: 'job-1', proxyToken: TOKEN, host: 'middleware', port: 8080 }, c);
    assert.equal(d.decision, 'allow');
    assert.equal(d.allowInternal, true);
    assert.equal(d.matched, 'internal');
  });

  it('denies a canonicalised numeric-IP target (2130706433 → 127.0.0.1, not on any allowlist)', () => {
    const registry = registryWith(['github.com']);
    const parsed = parseAuthority('2130706433:443', 443);
    assert.ok(parsed);
    const d = decideRequest({ jobId: 'job-1', proxyToken: TOKEN, host: parsed.host, port: parsed.port }, ctx(registry));
    assert.equal(d.decision, 'deny');
    assert.equal(d.reason, 'not_allowlisted');
  });
});

describe('classifyResolvedAddresses — rebinding defence (spec §6 rule 4)', () => {
  it('refuses when ANY resolved address is internal', () => {
    assert.deepEqual(
      classifyResolvedAddresses([{ address: '140.82.112.3', family: 4 }, { address: '10.0.0.5', family: 4 }]),
      { ok: false, reason: 'internal_ip' },
    );
    assert.deepEqual(classifyResolvedAddresses([{ address: '169.254.169.254', family: 4 }]), {
      ok: false,
      reason: 'internal_ip',
    });
  });

  it('pins the first vetted IP when all are public', () => {
    assert.deepEqual(classifyResolvedAddresses([{ address: '140.82.112.3', family: 4 }]), {
      ok: true,
      pinnedIp: '140.82.112.3',
      family: 4,
    });
  });

  it('skips the internal check for the deliberate internal destination', () => {
    assert.deepEqual(classifyResolvedAddresses([{ address: '10.0.0.5', family: 4 }], { allowInternal: true }), {
      ok: true,
      pinnedIp: '10.0.0.5',
      family: 4,
    });
  });

  it('reports no_address on an empty resolution', () => {
    assert.deepEqual(classifyResolvedAddresses([]), { ok: false, reason: 'no_address' });
  });
});

describe('createEventClient — batching + immediate deny flush', () => {
  function fakeFetch() {
    const posts = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, opts) => {
      posts.push({ url, body: JSON.parse(String(opts?.body)) });
      return /** @type {any} */ ({ ok: true });
    };
    return { posts, fetchImpl };
  }
  const allowEvent = { jobId: 'j', ts: 't', verb: 'CONNECT', host: 'github.com', port: 443, decision: 'allow', reason: null, resolvedIp: '1.2.3.4', bytesIn: 0, bytesOut: 0, durationMs: 0 };
  const denyEvent = { ...allowEvent, decision: 'deny', reason: 'not_allowlisted', resolvedIp: null };

  it('batches non-deny events until an explicit flush', async () => {
    const { posts, fetchImpl } = fakeFetch();
    const client = createEventClient({ url: 'http://mw/events', token: 'x'.repeat(32), fetchImpl, flushIntervalMs: 10_000 });
    client.record({ ...allowEvent });
    assert.equal(client.queueLength, 1);
    assert.equal(posts.length, 0);
    await client.flush();
    client.stop();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.events.length, 1);
  });

  it('flushes IMMEDIATELY on a deny (a refusal is never delayed)', async () => {
    const { posts, fetchImpl } = fakeFetch();
    const client = createEventClient({ url: 'http://mw/events', token: 'x'.repeat(32), fetchImpl, flushIntervalMs: 10_000 });
    client.record({ ...allowEvent });
    client.record({ ...denyEvent });
    await new Promise((r) => setImmediate(r));
    client.stop();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.events.length, 2); // the queued allow flushes with the deny
    // The POST carries a bearer, never the event payload as a credential.
    assert.match(String(posts[0].url), /\/events$/);
  });

  it('is a no-op (never throws) when unconfigured', async () => {
    const client = createEventClient({ flushIntervalMs: 10_000 });
    client.record({ ...denyEvent });
    await client.flush();
    client.stop();
    assert.equal(client.queueLength, 0);
  });
});
