/**
 * Issue #669 — the optional `/api/dev` address gate.
 *
 * The e2e suite can only exercise the ALLOW branch (its own listener is on
 * 127.0.0.1). The refusal branch — and the header-spoofing question, which is
 * the only interesting thing about a guard like this — is asserted here
 * against the middleware directly.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { createLoopbackOnly, isLoopbackAddress } from '../../src/auth/loopbackOnly.js';

interface FakeResult {
  readonly nexted: boolean;
  readonly status: number | undefined;
  readonly body: unknown;
}

/** Drives the middleware with a socket address and optional spoofing headers. */
function run(
  handler: ReturnType<typeof createLoopbackOnly>,
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
): FakeResult {
  let nexted = false;
  let status: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  const req = {
    socket: { remoteAddress },
    headers,
    ip: headers['x-forwarded-for'] ?? remoteAddress,
  } as unknown as Request;
  handler(req, res, () => {
    nexted = true;
  });
  return { nexted, status, body };
}

describe('isLoopbackAddress', () => {
  it('accepts the IPv4 and IPv6 loopback literals', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
  });

  it('accepts the IPv4-mapped IPv6 form a dual-stack listener reports', () => {
    // Node reports this for a v4 client reaching a `::` listener, which is how
    // index.ts binds. Missing it would refuse every local request.
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  });

  it('accepts the whole 127.0.0.0/8 block', () => {
    assert.equal(isLoopbackAddress('127.0.0.2'), true);
    assert.equal(isLoopbackAddress('127.255.255.254'), true);
  });

  it('rejects private, public and malformed addresses', () => {
    assert.equal(isLoopbackAddress('10.0.0.5'), false);
    assert.equal(isLoopbackAddress('172.17.0.3'), false);
    assert.equal(isLoopbackAddress('93.184.216.34'), false);
    assert.equal(isLoopbackAddress('fd00::1'), false);
    assert.equal(isLoopbackAddress('127.0.0.999'), false);
    assert.equal(isLoopbackAddress('127.0.0.1.evil.example'), false);
    assert.equal(isLoopbackAddress(''), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });
});

describe('createLoopbackOnly', () => {
  it('passes everything through when disabled', () => {
    const handler = createLoopbackOnly({ enabled: false });
    assert.equal(run(handler, '10.0.0.5').nexted, true);
  });

  it('passes a loopback request through when enabled', () => {
    const handler = createLoopbackOnly({ enabled: true, log: () => {} });
    assert.equal(run(handler, '::ffff:127.0.0.1').nexted, true);
  });

  it('refuses a non-loopback request with 403', () => {
    const handler = createLoopbackOnly({ enabled: true, log: () => {} });
    const result = run(handler, '10.0.0.5');
    assert.equal(result.nexted, false);
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, {
      code: 'dev.loopback_only',
      message: 'dev endpoints are bound to loopback on this deployment',
    });
  });

  /**
   * The one mistake that makes this guard decorative. `trust proxy` is on in
   * index.ts, so `req.ip` reflects `X-Forwarded-For` — a caller could simply
   * claim to be 127.0.0.1. The guard reads the socket instead.
   */
  it('is not defeated by a spoofed X-Forwarded-For', () => {
    const handler = createLoopbackOnly({ enabled: true, log: () => {} });
    const result = run(handler, '203.0.113.7', { 'x-forwarded-for': '127.0.0.1' });
    assert.equal(result.nexted, false);
    assert.equal(result.status, 403);
  });

  it('refuses a request with no discoverable socket address', () => {
    const handler = createLoopbackOnly({ enabled: true, log: () => {} });
    assert.equal(run(handler, undefined).status, 403);
  });
});
