import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';

import {
  isHttpUrlTemplate,
  isMcpInputRefusal,
  isUniqueViolation,
  requireUuidMcpId,
  validateMcpServerInput,
} from '../src/routes/mcpServerInput.js';
import type { AddressInfo } from 'node:net';

import { isSandboxListenDenied, listenLoopback } from './_helpers/listenLoopback.js';

/** #1955 — operator MCP input checks answer 400/404/409, never a pg 500. */
describe('validateMcpServerInput (#1955)', () => {
  const codeOf = (body: unknown): string | undefined => {
    const r = validateMcpServerInput(body);
    return isMcpInputRefusal(r) ? r.code : undefined;
  };

  it('accepts a valid http server and trims its fields', () => {
    const r = validateMcpServerInput({ name: ' crm ', transport: 'http', endpoint: ' https://x.example/mcp ' });
    assert.deepEqual(r, { name: 'crm', transport: 'http', endpoint: 'https://x.example/mcp', status: 'enabled' });
  });

  it('accepts placeholders in an http endpoint', () => {
    assert.equal(codeOf({ name: 'm365', transport: 'http', endpoint: 'https://graph.example/{tenant_id}/mcp' }), undefined);
    assert.equal(codeOf({ name: 'self', transport: 'http', endpoint: 'https://{host}/mcp' }), undefined);
  });

  it('accepts any stdio command line', () => {
    assert.equal(codeOf({ name: 'local', transport: 'stdio', endpoint: 'npx -y -- some-server' }), undefined);
  });

  it('refuses each invalid input with its own code', () => {
    assert.equal(codeOf({ name: '', transport: 'http', endpoint: 'https://x' }), 'name_required');
    assert.equal(codeOf({ name: 'x'.repeat(121), transport: 'http', endpoint: 'https://x' }), 'name_too_long');
    assert.equal(codeOf({ name: 'a', transport: 'grpc', endpoint: 'https://x' }), 'invalid_transport');
    assert.equal(codeOf({ name: 'a', transport: 'http', endpoint: '' }), 'endpoint_required');
    assert.equal(codeOf({ name: 'a', transport: 'stdio', endpoint: '  ' }), 'endpoint_required');
    assert.equal(codeOf({ name: 'a', transport: 'http', endpoint: 'x.example/mcp' }), 'endpoint_invalid');
    assert.equal(codeOf({ name: 'a', transport: 'sse', endpoint: 'ftp://x.example' }), 'endpoint_invalid');
    assert.equal(codeOf({ name: 'a', transport: 'http', endpoint: 'https://x', status: 'on' }), 'invalid_status');
  });

  it('isHttpUrlTemplate needs a host', () => {
    assert.equal(isHttpUrlTemplate('https://'), false);
    assert.equal(isHttpUrlTemplate('http://localhost:8080/mcp'), true);
  });

  it('isUniqueViolation reads the pg code', () => {
    assert.equal(isUniqueViolation({ code: '23505' }), true);
    assert.equal(isUniqueViolation(new Error('x')), false);
  });
});

describe('requireUuidMcpId (#1955)', () => {
  it('404s a non-UUID id and lets UUIDs and literal routes through', async (t) => {
    const app = express();
    app.use('/mcp-servers', requireUuidMcpId(new Set(['rescan-all'])));
    app.use((_req, res) => {
      res.status(200).json({ reached: true });
    });
    let server;
    try {
      server = await listenLoopback(app);
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }
    try {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${String(port)}`;
      assert.equal((await fetch(`${base}/mcp-servers/not-a-uuid`)).status, 404);
      assert.equal((await fetch(`${base}/mcp-servers/not-a-uuid/discover`, { method: 'POST' })).status, 404);
      assert.equal(
        (await fetch(`${base}/mcp-servers/00000000-0000-4000-8000-000000000001/discover`)).status,
        200,
      );
      assert.equal((await fetch(`${base}/mcp-servers/rescan-all`, { method: 'POST' })).status, 200);
      assert.equal((await fetch(`${base}/mcp-servers`)).status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
