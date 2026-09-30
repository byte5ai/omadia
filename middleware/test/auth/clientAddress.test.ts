/**
 * Which address the password sign-in limiter charges an attempt to
 * (`AUTH_LOGIN_CLIENT_ADDRESS`, `AUTH_LOGIN_IPV6_PREFIX`,
 * docs/security-architecture.md §10f).
 *
 * The interesting property is what a caller can NOT do: under `trust proxy`
 * Express's `req.ip` is the left-most X-Forwarded-For entry, which the client
 * writes. A key a header can pick is a key an attacker rotates for free, so
 * every case below pins what a forged value does to the key — nothing.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Request } from 'express';

import {
  clientAddressFor,
  describeClientAddressPolicy,
  isClientAddressPolicy,
  parseClientAddressPolicy,
  UNKNOWN_CLIENT,
  type ClientAddressPolicy,
} from '../../src/auth/clientAddress.js';

/** A request with a socket peer, headers and a `req.ip` that believes the header. */
function fakeRequest(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
): Request {
  const xff = headers['x-forwarded-for'];
  return {
    socket: { remoteAddress },
    headers,
    ip: xff !== undefined ? xff.split(',')[0]?.trim() : remoteAddress,
    ips: xff !== undefined ? xff.split(',').map((s) => s.trim()) : [],
  } as unknown as Request;
}

/** Just the key, for the many cases that only care about it. */
function keyOf(req: Request, policy: ClientAddressPolicy, ipv6PrefixBits?: number): string {
  return clientAddressFor(req, policy, ipv6PrefixBits).key;
}

const SOCKET: ClientAddressPolicy = { kind: 'socket' };
const XFF1: ClientAddressPolicy = { kind: 'xff', trustedHops: 1 };
const XFF2: ClientAddressPolicy = { kind: 'xff', trustedHops: 2 };
const FLY_HEADER: ClientAddressPolicy = { kind: 'header', name: 'fly-client-ip' };

describe('parseClientAddressPolicy', () => {
  it('accepts socket, xff:1..8 and header:<name>', () => {
    assert.deepEqual(parseClientAddressPolicy('socket'), SOCKET);
    assert.deepEqual(parseClientAddressPolicy('xff:1'), XFF1);
    assert.deepEqual(parseClientAddressPolicy('xff:8'), { kind: 'xff', trustedHops: 8 });
    assert.deepEqual(parseClientAddressPolicy(' xff:2 '), XFF2);
    assert.deepEqual(parseClientAddressPolicy('header:Fly-Client-IP'), FLY_HEADER);
  });

  it('rejects anything else, so a typo stops the boot instead of weakening the key', () => {
    for (const bad of [
      'xff:0',
      'xff:9',
      'xff:',
      'xff:-1',
      'xff:1.5',
      'bogus',
      '',
      'header:',
      'header:bad name',
      'header:x\r\nInjected: 1',
      'Socket ',
    ]) {
      assert.throws(() => parseClientAddressPolicy(bad), /AUTH_LOGIN_CLIENT_ADDRESS/, bad);
      assert.equal(isClientAddressPolicy(bad), false, bad);
    }
    assert.equal(isClientAddressPolicy('socket'), true);
    assert.equal(isClientAddressPolicy('xff:3'), true);
  });

  it('describes a policy in its own env spelling (boot log line)', () => {
    assert.equal(describeClientAddressPolicy(SOCKET), 'socket');
    assert.equal(describeClientAddressPolicy(XFF2), 'xff:2');
    assert.equal(describeClientAddressPolicy(FLY_HEADER), 'header:fly-client-ip');
  });
});

describe('clientAddressFor — socket', () => {
  it('returns the TCP peer and ignores a spoofed X-Forwarded-For and req.ip', () => {
    const req = fakeRequest('198.51.100.7', { 'x-forwarded-for': '127.0.0.1' });
    assert.equal(req.ip, '127.0.0.1', 'precondition: req.ip believes the header');
    assert.equal(keyOf(req, SOCKET), '198.51.100.7');
  });

  it('normalises the IPv4-mapped IPv6 form a dual-stack listener reports', () => {
    assert.equal(keyOf(fakeRequest('::ffff:203.0.113.5'), SOCKET), '203.0.113.5');
  });

  it("yields 'unknown' when the socket has no address (unconnected test sockets)", () => {
    assert.equal(keyOf(fakeRequest(undefined), SOCKET), UNKNOWN_CLIENT);
    assert.equal(UNKNOWN_CLIENT, 'unknown');
  });
});

describe('clientAddressFor — xff:<n> counts trusted hops from the RIGHT', () => {
  it('xff:1 takes the right-most entry (the one the trusted proxy appended)', () => {
    const req = fakeRequest('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    assert.equal(keyOf(req, XFF1), '203.0.113.9');
  });

  it('a spoofed left-most entry never changes the key', () => {
    const a = fakeRequest('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    const b = fakeRequest('10.0.0.2', { 'x-forwarded-for': '7.7.7.7, 8.8.8.8, 203.0.113.9' });
    assert.notEqual(a.ip, b.ip, 'precondition: req.ip follows the forged entry');
    assert.equal(keyOf(a, XFF1), keyOf(b, XFF1));
  });

  it('xff:2 takes the second entry from the right', () => {
    const req = fakeRequest('10.0.0.3', {
      'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2',
    });
    assert.equal(keyOf(req, XFF2), '203.0.113.9');
  });

  it('falls back to the socket peer when the header is missing or shorter than n', () => {
    assert.equal(keyOf(fakeRequest('10.0.0.2'), XFF1), '10.0.0.2');
    assert.equal(keyOf(fakeRequest('10.0.0.3', { 'x-forwarded-for': '203.0.113.9' }), XFF2), '10.0.0.3');
    assert.equal(keyOf(fakeRequest('10.0.0.3', { 'x-forwarded-for': ' , ' }), XFF1), '10.0.0.3');
  });

  it('falls back to the socket peer when the entry is not an IP address', () => {
    for (const junk of ['not-an-ip', 'evil\nforged log line', 'x'.repeat(500), '999.1.1.1']) {
      const req = fakeRequest('10.0.0.2', { 'x-forwarded-for': junk });
      assert.equal(keyOf(req, XFF1), '10.0.0.2', JSON.stringify(junk));
    }
  });

  it('strips a port and IPv6 brackets before validating', () => {
    assert.equal(keyOf(fakeRequest('10.0.0.2', { 'x-forwarded-for': '203.0.113.9:51234' }), XFF1), '203.0.113.9');
    assert.equal(
      keyOf(fakeRequest('10.0.0.2', { 'x-forwarded-for': '[2001:db8:1:2::abcd]:443' }), XFF1),
      '2001:db8:1:2::/64',
    );
  });
});

describe('clientAddressFor — header:<name>', () => {
  it('returns the header an edge sets, with a socket fallback when absent', () => {
    assert.equal(keyOf(fakeRequest('10.0.0.2', { 'fly-client-ip': '203.0.113.20' }), FLY_HEADER), '203.0.113.20');
    assert.equal(keyOf(fakeRequest('10.0.0.2'), FLY_HEADER), '10.0.0.2');
  });

  it('does not accept a list: a header the edge overwrites holds exactly one address', () => {
    const req = fakeRequest('10.0.0.2', { 'fly-client-ip': '6.6.6.6, 203.0.113.20' });
    assert.equal(keyOf(req, FLY_HEADER), '10.0.0.2');
  });

  it('on Fly the right-most X-Forwarded-For entry is the app’s own address: only the header tells clients apart', () => {
    // Fly documents X-Forwarded-For as "<client>, <the app's shared or
    // dedicated IP>", so xff:1 would key every client by the app's address.
    const appIp = '192.0.2.10';
    const alice = fakeRequest('172.16.0.2', {
      'x-forwarded-for': `203.0.113.1, ${appIp}`,
      'fly-client-ip': '203.0.113.1',
    });
    const bob = fakeRequest('172.16.0.2', {
      'x-forwarded-for': `198.51.100.2, ${appIp}`,
      'fly-client-ip': '198.51.100.2',
    });
    assert.equal(keyOf(alice, XFF1), keyOf(bob, XFF1), 'xff:1 on Fly: one key for everybody');
    assert.notEqual(keyOf(alice, FLY_HEADER), keyOf(bob, FLY_HEADER));
  });
});

describe('clientAddressFor — shared: the TCP peer is a proxy every client behind it shares', () => {
  it('marks the socket peer shared, and an address a trusted hop vouched for not', () => {
    assert.equal(clientAddressFor(fakeRequest('10.0.0.5'), SOCKET).shared, true);
    assert.equal(clientAddressFor(fakeRequest(undefined), SOCKET).shared, true);
    const fromXff = clientAddressFor(fakeRequest('10.0.0.5', { 'x-forwarded-for': '203.0.113.9' }), XFF1);
    assert.deepEqual(fromXff, { key: '203.0.113.9', shared: false });
    const fromHeader = clientAddressFor(fakeRequest('10.0.0.5', { 'fly-client-ip': '203.0.113.20' }), FLY_HEADER);
    assert.deepEqual(fromHeader, { key: '203.0.113.20', shared: false });
  });

  it('a fallback to the socket peer is shared too, whatever the policy', () => {
    assert.deepEqual(clientAddressFor(fakeRequest('10.0.0.5'), XFF1), { key: '10.0.0.5', shared: true });
    assert.deepEqual(clientAddressFor(fakeRequest('10.0.0.5', { 'x-forwarded-for': 'junk' }), XFF1), {
      key: '10.0.0.5',
      shared: true,
    });
    assert.deepEqual(clientAddressFor(fakeRequest('10.0.0.5'), FLY_HEADER), { key: '10.0.0.5', shared: true });
  });
});

describe('clientAddressFor — IPv6 clients are keyed by a prefix (/64 by default)', () => {
  it('two addresses in one /64 share a key; another /64 does not', () => {
    const a = keyOf(fakeRequest('2001:db8:aa:1::1'), SOCKET);
    const b = keyOf(fakeRequest('2001:0db8:00aa:0001:ffff:1:2:3'), SOCKET);
    const c = keyOf(fakeRequest('2001:db8:aa:2::1'), SOCKET);
    assert.equal(a, '2001:db8:aa:1::/64');
    assert.equal(a, b, 'one host can rotate through its whole /64 — that is one client');
    assert.notEqual(a, c);
  });

  it('handles compressed, embedded-IPv4 and zone forms', () => {
    assert.equal(keyOf(fakeRequest('::1'), SOCKET), '0:0:0:0::/64');
    assert.equal(keyOf(fakeRequest('fe80::1%eth0'), SOCKET), 'fe80:0:0:0::/64');
    assert.equal(keyOf(fakeRequest('64:ff9b:1:2::192.0.2.33'), SOCKET), '64:ff9b:1:2::/64');
    assert.equal(keyOf(fakeRequest('2001:DB8:AA:1::1'), SOCKET), '2001:db8:aa:1::/64');
  });

  it('a shorter prefix (AUTH_LOGIN_IPV6_PREFIX) folds a whole allocation into one key', () => {
    // A /48 holds 65,536 /64s and a /56 holds 256: at /64 each is its own client.
    const inOne48 = ['2001:db8:77:1::1', '2001:db8:77:ff::1', '2001:db8:77:ffff::1'];
    assert.equal(new Set(inOne48.map((ip) => keyOf(fakeRequest(ip), SOCKET))).size, 3);
    assert.deepEqual(
      [...new Set(inOne48.map((ip) => keyOf(fakeRequest(ip), SOCKET, 48)))],
      ['2001:db8:77::/48'],
    );
    assert.notEqual(keyOf(fakeRequest('2001:db8:78:1::1'), SOCKET, 48), '2001:db8:77::/48');
  });

  it('masks inside a group for prefixes that are not a multiple of 16', () => {
    assert.equal(keyOf(fakeRequest('2001:db8:aa:1ff::1'), SOCKET, 56), '2001:db8:aa:100::/56');
    assert.equal(keyOf(fakeRequest('2001:db8:aa:1ff::1'), SOCKET, 60), '2001:db8:aa:1f0::/60');
    assert.equal(keyOf(fakeRequest('2001:db8:aa:1ff::1'), SOCKET, 32), '2001:db8::/32');
  });

  it('clamps an out-of-range prefix into 32..64 and leaves IPv4 alone', () => {
    assert.equal(keyOf(fakeRequest('2001:db8:aa:1::1'), SOCKET, 128), '2001:db8:aa:1::/64');
    assert.equal(keyOf(fakeRequest('2001:db8:aa:1::1'), SOCKET, 8), '2001:db8::/32');
    assert.equal(keyOf(fakeRequest('203.0.113.5'), SOCKET, 48), '203.0.113.5');
  });
});
