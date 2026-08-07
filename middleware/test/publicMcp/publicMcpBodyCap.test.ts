import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import {
  MAX_REQUEST_BYTES,
  PublicMcpServer,
  type PublicMcpServerDeps,
} from '../../src/mcp/publicMcpServer.js';
import { createInMemoryPublicMcpKeyBindingStore } from '../../src/mcp/publicMcpKeyBindings.js';

/**
 * W2-3 (issue #542) — the 8 MB body cap, at the honest boundary.
 *
 * The `Content-Length` half of `bodyCapMiddleware` cannot be driven end-to-end:
 * a header declaring 8-10 MB while sending a small body leaves the kernel's
 * global `express.json` waiting for the rest of the body, and `fetch` refuses to
 * send a mismatched `Content-Length` at all. So it is exercised here against the
 * middleware itself, which is exactly the unit that owns the decision. The
 * actual-size half — the real enforcement — is additionally driven end-to-end in
 * `publicMcpEndpoint.e2e.test.ts`.
 */

function server(): PublicMcpServer {
  const deps: PublicMcpServerDeps = {
    resolveDispatcher: () => undefined,
    bindings: createInMemoryPublicMcpKeyBindingStore([]),
    writeRateLimiter: { tryConsume: () => true },
  };
  return new PublicMcpServer(deps);
}

interface Captured {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
}

function run(req: Partial<Request>): Captured {
  const captured: Captured = { nextCalled: false };
  const res = {
    status(code: number) {
      captured.status = code;
      return this as unknown as Response;
    },
    json(body: unknown) {
      captured.body = body;
      return this as unknown as Response;
    },
  } as unknown as Response;
  server().bodyCapMiddleware()(
    { headers: {}, ...req } as Request,
    res,
    () => {
      captured.nextCalled = true;
    },
  );
  return captured;
}

describe('public MCP body cap', () => {
  it('passes a small body through', () => {
    const out = run({ headers: { 'content-length': '42' }, body: { jsonrpc: '2.0' } });
    assert.equal(out.nextCalled, true);
    assert.equal(out.status, undefined);
  });

  it('passes a body with no Content-Length at all', () => {
    const out = run({ body: { jsonrpc: '2.0' } });
    assert.equal(out.nextCalled, true);
  });

  it('passes a request with no body at all', () => {
    const out = run({});
    assert.equal(out.nextCalled, true);
  });

  // A batch is one HTTP request carrying many JSON-RPC messages, and every
  // per-request control here is charged once per HTTP request: the API-key rate
  // limiter takes a single token, and `tools/list` never touches the
  // concurrency counter. Without this guard, one small array of tens of
  // thousands of `tools/list` calls costs one token and that many Postgres
  // `bindings.get` round-trips. The SDK transport really does accept arrays, so
  // it is reachable rather than theoretical.
  it('refuses a JSON-RPC batch', () => {
    const out = run({ body: [{ jsonrpc: '2.0', method: 'tools/list', id: 1 }] });
    assert.equal(out.nextCalled, false, 'a batch must not reach the handler');
    assert.equal(out.status, 400);
    assert.equal(
      (out.body as { error?: { code?: number } }).error?.code,
      -32600,
      'a refused batch must be an Invalid Request, not a generic failure',
    );
  });

  it('refuses a large batch without paying to execute it', () => {
    // The amplification shape specifically: well under the byte cap, thousands
    // of messages. It must be refused on shape, not squeeze under the size gate.
    const batch = Array.from({ length: 5000 }, (_, i) => ({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: i,
    }));
    assert.ok(
      Buffer.byteLength(JSON.stringify(batch), 'utf8') < MAX_REQUEST_BYTES,
      'fixture must sit UNDER the byte cap, or it proves the wrong gate',
    );
    const out = run({ body: batch });
    assert.equal(out.nextCalled, false);
    assert.equal(out.status, 400);
  });

  it('still passes a single non-batch request', () => {
    // Guard rail: the batch refusal must not be rejecting ordinary traffic,
    // which would make the two cases above vacuous.
    const out = run({ body: { jsonrpc: '2.0', method: 'tools/list', id: 1 } });
    assert.equal(out.nextCalled, true);
    assert.equal(out.status, undefined);
  });

  it('413s on a declared Content-Length over the cap', () => {
    const out = run({
      headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) },
      body: { jsonrpc: '2.0' },
    });
    assert.equal(out.nextCalled, false);
    assert.equal(out.status, 413);
    assert.deepEqual(out.body, {
      jsonrpc: '2.0',
      error: { code: 413, message: 'Payload Too Large' },
      id: null,
    });
  });

  it('allows a declared Content-Length exactly AT the cap', () => {
    const out = run({
      headers: { 'content-length': String(MAX_REQUEST_BYTES) },
      body: { jsonrpc: '2.0' },
    });
    assert.equal(out.nextCalled, true);
  });

  /** The real enforcement: an oversized body with NO honest header. */
  it('413s on an oversized body even when Content-Length is absent', () => {
    const out = run({ body: { blob: 'x'.repeat(MAX_REQUEST_BYTES + 1024) } });
    assert.equal(out.nextCalled, false);
    assert.equal(out.status, 413);
  });

  /** A lying header must not be able to smuggle an oversized body through. */
  it('413s on an oversized body that declares a small Content-Length', () => {
    const out = run({
      headers: { 'content-length': '10' },
      body: { blob: 'x'.repeat(MAX_REQUEST_BYTES + 1024) },
    });
    assert.equal(out.nextCalled, false);
    assert.equal(out.status, 413);
  });

  it('ignores a non-numeric Content-Length and falls back to the body size', () => {
    assert.equal(run({ headers: { 'content-length': 'banana' }, body: { a: 1 } }).nextCalled, true);
    assert.equal(
      run({
        headers: { 'content-length': 'banana' },
        body: { blob: 'x'.repeat(MAX_REQUEST_BYTES + 1024) },
      }).status,
      413,
    );
  });
});
