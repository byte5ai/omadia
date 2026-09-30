/**
 * Which address the password sign-in limiter charges an attempt to
 * (`AUTH_LOGIN_CLIENT_ADDRESS`, docs/security-architecture.md §10f).
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
    assert.equal(clientAddressFor(req, SOCKET), '198.51.100.7');
  });

  it('normalises the IPv4-mapped IPv6 form a dual-stack listener reports', () => {
    assert.equal(clientAddressFor(fakeRequest('::ffff:203.0.113.5'), SOCKET), '203.0.113.5');
  });

  it("yields 'unknown' when the socket has no address (unconnected test sockets)", () => {
    assert.equal(clientAddressFor(fakeRequest(undefined), SOCKET), UNKNOWN_CLIENT);
    assert.equal(UNKNOWN_CLIENT, 'unknown');
  });
});

describe('clientAddressFor — xff:<n> counts trusted hops from the RIGHT', () => {
  it('xff:1 takes the right-most entry (the one the trusted proxy appended)', () => {
    const req = fakeRequest('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    assert.equal(clientAddressFor(req, XFF1), '203.0.113.9');
  });

  it('a spoofed left-most entry never changes the key', () => {
    const a = fakeRequest('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    const b = fakeRequest('10.0.0.2', { 'x-forwarded-for': '7.7.7.7, 8.8.8.8, 203.0.113.9' });
    assert.notEqual(a.ip, b.ip, 'precondition: req.ip follows the forged entry');
    assert.equal(clientAddressFor(a, XFF1), clientAddressFor(b, XFF1));
  });

  it('xff:2 takes the second entry from the right', () => {
    const req = fakeRequest('10.0.0.3', {
      'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2',
    });
    assert.equal(clientAddressFor(req, XFF2), '203.0.113.9');
  });

  it('falls back to the socket peer when the header is missing or shorter than n', () => {
    assert.equal(clientAddressFor(fakeRequest('10.0.0.2'), XFF1), '10.0.0.2');
    assert.equal(
      clientAddressFor(fakeRequest('10.0.0.3', { 'x-forwarded-for': '203.0.113.9' }), XFF2),
      '10.0.0.3',
    );
    assert.equal(
      clientAddressFor(fakeRequest('10.0.0.3', { 'x-forwarded-for': ' , ' }), XFF1),
      '10.0.0.3',
    );
  });

  it('falls back to the socket peer when the entry is not an IP address', () => {
    for (const junk of ['not-an-ip', 'evil\nforged log line', 'x'.repeat(500), '999.1.1.1']) {
      const req = fakeRequest('10.0.0.2', { 'x-forwarded-for': junk });
      assert.equal(clientAddressFor(req, XFF1), '10.0.0.2', JSON.stringify(junk));
    }
  });

  it('strips a port and IPv6 brackets before validating', () => {
    assert.equal(
      clientAddressFor(fakeRequest('10.0.0.2', { 'x-forwarded-for': '203.0.113.9:51234' }), XFF1),
      '203.0.113.9',
    );
    assert.equal(
      clientAddressFor(
        fakeRequest('10.0.0.2', { 'x-forwarded-for': '[2001:db8:1:2::abcd]:443' }),
        XFF1,
      ),
      '2001:db8:1:2::/64',
    );
  });
});

describe('clientAddressFor — header:<name>', () => {
  it('returns the header an edge sets, with a socket fallback when absent', () => {
    assert.equal(
      clientAddressFor(fakeRequest('10.0.0.2', { 'fly-client-ip': '203.0.113.20' }), FLY_HEADER),
      '203.0.113.20',
    );
    assert.equal(clientAddressFor(fakeRequest('10.0.0.2'), FLY_HEADER), '10.0.0.2');
  });

  it('does not accept a list: a header the edge overwrites holds exactly one address', () => {
    const req = fakeRequest('10.0.0.2', { 'fly-client-ip': '6.6.6.6, 203.0.113.20' });
    assert.equal(clientAddressFor(req, FLY_HEADER), '10.0.0.2');
  });
});

describe('clientAddressFor — IPv6 clients are keyed by their /64', () => {
  it('two addresses in one /64 share a key; another /64 does not', () => {
    const a = clientAddressFor(fakeRequest('2001:db8:aa:1::1'), SOCKET);
    const b = clientAddressFor(fakeRequest('2001:0db8:00aa:0001:ffff:1:2:3'), SOCKET);
    const c = clientAddressFor(fakeRequest('2001:db8:aa:2::1'), SOCKET);
    assert.equal(a, '2001:db8:aa:1::/64');
    assert.equal(a, b, 'one host can rotate through its whole /64 — that is one client');
    assert.notEqual(a, c);
  });

  it('handles compressed, embedded-IPv4 and zone forms', () => {
    assert.equal(clientAddressFor(fakeRequest('::1'), SOCKET), '0:0:0:0::/64');
    assert.equal(clientAddressFor(fakeRequest('fe80::1%eth0'), SOCKET), 'fe80:0:0:0::/64');
    assert.equal(
      clientAddressFor(fakeRequest('64:ff9b:1:2::192.0.2.33'), SOCKET),
      '64:ff9b:1:2::/64',
    );
    assert.equal(clientAddressFor(fakeRequest('2001:DB8:AA:1::1'), SOCKET), '2001:db8:aa:1::/64');
  });
});
