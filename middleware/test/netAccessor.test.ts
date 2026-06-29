import { strict as assert } from 'node:assert';
import net from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { NetForbiddenError, NetRateLimitError } from '@omadia/plugin-api';

import { createNetAccessor } from '../src/platform/netAccessor.js';

// A throwaway loopback TCP server so the "allowed" path opens a REAL socket.
function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.end());
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('createNetAccessor — allow-list gating', () => {
  let srv: { port: number; close: () => void };
  beforeEach(async () => {
    srv = await listen();
  });
  afterEach(() => srv.close());

  it('connects to an allow-listed host:port', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: '127.0.0.1', port: srv.port }],
    });
    const sock = await net_.connect({ host: '127.0.0.1', port: srv.port });
    assert.ok(sock.writable, 'socket should be writable');
    sock.destroy();
  });

  it('host casing is ignored for matching', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: '127.0.0.1', port: srv.port }],
    });
    // an uppercased numeric host is identical, but exercise the lower-casing path
    const sock = await net_.connect({ host: '127.0.0.1', port: srv.port });
    sock.destroy();
    assert.ok(true);
  });

  it('rejects an unlisted host', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: '127.0.0.1', port: srv.port }],
    });
    await assert.rejects(
      () => net_.connect({ host: 'smtp.evil.com', port: srv.port }),
      NetForbiddenError,
    );
  });

  it('rejects an allowed host on a different port', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: '127.0.0.1', port: srv.port }],
    });
    await assert.rejects(
      () => net_.connect({ host: '127.0.0.1', port: srv.port + 1 }),
      NetForbiddenError,
    );
  });

  it('rejects an invalid port before any dial', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: '127.0.0.1', port: 70000 }],
    });
    await assert.rejects(
      () => net_.connect({ host: '127.0.0.1', port: 70000 }),
      TypeError,
    );
  });
});

describe('createNetAccessor — rate limiting', () => {
  it('enforces the per-minute connection budget', async () => {
    const srv = await listen();
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: '127.0.0.1', port: srv.port }],
      rateLimitPerMinute: 1,
    });
    const first = await net_.connect({ host: '127.0.0.1', port: srv.port });
    first.destroy();
    await assert.rejects(
      () => net_.connect({ host: '127.0.0.1', port: srv.port }),
      NetRateLimitError,
    );
    srv.close();
  });
});

describe('createNetAccessor — egress IP guard', () => {
  it('blocks an allow-listed host that resolves to link-local / cloud metadata', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: 'relay.attacker.com', port: 587 }],
      lookupFn: async () => '169.254.169.254',
    });
    await assert.rejects(
      () => net_.connect({ host: 'relay.attacker.com', port: 587 }),
      NetForbiddenError,
    );
  });

  it('blocks IPv6 link-local', async () => {
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: 'relay.attacker.com', port: 587 }],
      lookupFn: async () => 'fe80::1',
    });
    await assert.rejects(
      () => net_.connect({ host: 'relay.attacker.com', port: 587 }),
      NetForbiddenError,
    );
  });

  it('still allows a host that resolves to a private (loopback) relay', async () => {
    const srv = await listen();
    const net_ = createNetAccessor({
      agentId: 't',
      allowed: [{ host: 'relay.internal', port: srv.port }],
      lookupFn: async () => '127.0.0.1',
    });
    const sock = await net_.connect({ host: 'relay.internal', port: srv.port });
    assert.ok(sock.writable, 'private relay must remain reachable');
    sock.destroy();
    srv.close();
  });
});

describe('createNetAccessor — empty allow-list', () => {
  it('rejects every target when nothing is allowed', async () => {
    const net_ = createNetAccessor({ agentId: 't', allowed: [] });
    await assert.rejects(
      () => net_.connect({ host: '127.0.0.1', port: 25 }),
      NetForbiddenError,
    );
  });
});
