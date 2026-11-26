import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { parseClientAddressPolicy } from '../../src/auth/clientAddress.js';
import type { AdminAuditLog } from '../../src/auth/adminAuditLog.js';
import { mountAdminTokenSurface } from '../../src/routes/adminTokenMount.js';
import {
  ADMIN_TOKEN_FAILURE_WINDOW_MS,
  ADMIN_TOKEN_MAX_FAILURES,
  ADMIN_TOKEN_MIN_UNBRAKED_LENGTH,
  adminTokenThrottleWarnings,
  createAdminTokenThrottle,
} from '../../src/routes/adminTokenThrottle.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * A wrong ADMIN_TOKEN bearer fills a per-client failure bucket; a full bucket
 * answers 429 before the token is compared. Only an address a trusted proxy
 * vouched for is braked, never the shared TCP peer (the password limiter's
 * client rule, loginRateLimiter.ts layer 1).
 */

const TOKEN = 'admin-token-0123456789abcdef';
const HEADER = 'x-client-ip';
const DRAIN_MS = ADMIN_TOKEN_FAILURE_WINDOW_MS / ADMIN_TOKEN_MAX_FAILURES;

const fakeReq = (ip: string | undefined) =>
  ({
    socket: { remoteAddress: '10.0.0.1' },
    headers: ip === undefined ? {} : { [HEADER]: ip },
  }) as never;

describe('admin-token throttle: per vouched client', () => {
  it('brakes a client after the burst and lets one try through per drain step', () => {
    let t = 1_000_000;
    const throttle = createAdminTokenThrottle({
      clientAddress: parseClientAddressPolicy(`header:${HEADER}`),
      now: () => t,
    });
    const a = fakeReq('203.0.113.7');
    for (let i = 0; i < ADMIN_TOKEN_MAX_FAILURES; i++) {
      assert.equal(throttle.retryAfterMs(a), 0, `try ${String(i + 1)}`);
      throttle.recordFailure(a);
    }
    const wait = throttle.retryAfterMs(a);
    assert.ok(wait > 0 && wait <= DRAIN_MS, String(wait));
    assert.equal(throttle.retryAfterMs(fakeReq('203.0.113.8')), 0, 'another client is not braked');
    t += DRAIN_MS;
    assert.equal(throttle.retryAfterMs(a), 0, 'one drain step frees one try');
    throttle.recordFailure(a);
    assert.ok(throttle.retryAfterMs(a) > 0, 'and the next failure fills it again');
  });

  it('keeps the partial drain step: one failure every 5 s takes far longer than the burst to fill', () => {
    let t = 0;
    const throttle = createAdminTokenThrottle({
      clientAddress: parseClientAddressPolicy(`header:${HEADER}`),
      now: () => t,
    });
    const a = fakeReq('203.0.113.9');
    // 12 a minute against a drain of 10 a minute: a reset drain mark (one
    // failure every 5 s never reaches a 6 s step) would brake it after the
    // burst of 10; with the partial step kept, 20 tries still go through.
    for (let i = 0; i < ADMIN_TOKEN_MAX_FAILURES * 2; i++) {
      assert.equal(throttle.retryAfterMs(a), 0, `try ${String(i + 1)}`);
      throttle.recordFailure(a);
      t += 5_000;
    }
  });

  it('never brakes the shared TCP peer', () => {
    const throttle = createAdminTokenThrottle({ clientAddress: parseClientAddressPolicy('socket') });
    const peer = fakeReq(undefined);
    for (let i = 0; i < ADMIN_TOKEN_MAX_FAILURES * 3; i++) throttle.recordFailure(peer);
    assert.equal(throttle.retryAfterMs(peer), 0);
  });
});

describe('admin-token throttle: boot warnings', () => {
  const socket = parseClientAddressPolicy('socket');
  const long = 'a'.repeat(ADMIN_TOKEN_MIN_UNBRAKED_LENGTH);

  it('says nothing without a token or behind a vouched client address', () => {
    assert.deepEqual(adminTokenThrottleWarnings(undefined, socket), []);
    assert.deepEqual(adminTokenThrottleWarnings('  ', socket), []);
    assert.deepEqual(adminTokenThrottleWarnings('short', parseClientAddressPolicy(`header:${HEADER}`)), []);
    assert.deepEqual(adminTokenThrottleWarnings('short', parseClientAddressPolicy('xff:1')), []);
  });

  it('warns that the shared TCP peer is unbraked, and about a short token on top', () => {
    const forLong = adminTokenThrottleWarnings(long, socket);
    assert.equal(forLong.length, 1);
    assert.match(forLong[0] ?? '', /AUTH_LOGIN_CLIENT_ADDRESS=socket/);

    const forShort = adminTokenThrottleWarnings(long.slice(1), socket);
    assert.equal(forShort.length, 2);
    assert.match(forShort[1] ?? '', /shorter than 32/);
    assert.ok(forShort.every((line) => !line.includes(long.slice(1))), 'the token never reaches the log');
  });
});

describe('admin-token throttle through the surface', () => {
  let server: Server;
  let base: string;
  const logs: string[] = [];

  before(async () => {
    const app = express();
    mountAdminTokenSurface(app, {
      token: TOKEN,
      store: { writeFile: async () => undefined } as never,
      audit: () => ({ record: async () => undefined }) as unknown as AdminAuditLog,
      log: (line) => logs.push(line),
      runTraceStats: () => undefined,
      throttle: createAdminTokenThrottle({ clientAddress: parseClientAddressPolicy(`header:${HEADER}`) }),
    });
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  after(() => {
    server.close();
  });

  const call = (token: string, ip: string) =>
    fetch(`${base}/api/admin/security/screening`, {
      headers: { authorization: `Bearer ${token}`, [HEADER]: ip },
    });

  it('answers 429 with Retry-After once a client sent too many wrong tokens, even with the right one', async () => {
    for (let i = 0; i < ADMIN_TOKEN_MAX_FAILURES; i++) {
      assert.equal((await call('wrong', '198.51.100.4')).status, 401);
    }
    const braked = await call(TOKEN, '198.51.100.4');
    assert.equal(braked.status, 429);
    assert.ok(Number(braked.headers.get('retry-after')) >= 1);
    assert.ok(logs.some((l) => l.includes('throttled')));
    assert.equal((await call(TOKEN, '198.51.100.5')).status, 200, 'another client is served');
  });
});
