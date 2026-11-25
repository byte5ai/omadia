import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  createAgentBuilderRouter,
  type AgentBuilderRouterOptions,
} from '../src/routes/agentBuilder.js';
import {
  HARNESS_SERVER_ID,
  jsonResponse,
  mcpOAuthHarness,
  tokenRow,
} from './_helpers/mcpOAuthHarness.js';

/**
 * A stored token row is not an authorization. These tests pin when a row stops
 * counting: expired with nothing to renew it, refused by the token endpoint,
 * or refused by the MCP server.
 */

const PAST = (): Date => new Date(Date.now() - 60_000);

describe('McpOAuthService.tokenState', () => {
  it('no stored token: not connected, nothing invalid', async () => {
    const h = mcpOAuthHarness({});
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: false,
      invalid: null,
    });
  });

  it('a token inside its lifetime counts', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice')] });
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: true,
      invalid: null,
    });
  });

  it('a token without an expiry counts', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice', { expiresAt: null, refreshTokenRef: null })],
    });
    assert.equal((await h.svc.tokenState(HARNESS_SERVER_ID, 'alice')).connected, true);
  });

  it('an expired token with a refresh token still counts: one refresh renews it', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice', { expiresAt: PAST() })] });
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: true,
      invalid: null,
    });
  });

  it('an expired token without a refresh token is expired', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice', { expiresAt: PAST(), refreshTokenRef: null })],
    });
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: false,
      invalid: 'expired',
    });
  });

  it('a marked token reports its mark, whatever its expiry says', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice', { invalidReason: 'rejected' })] });
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: false,
      invalid: 'rejected',
    });
  });

  it("one user's dead token says nothing about another user's", async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice', { invalidReason: 'rejected' }), tokenRow('bob')],
    });
    assert.equal((await h.svc.tokenState(HARNESS_SERVER_ID, 'bob')).connected, true);
  });
});

describe('a refused refresh marks the token', () => {
  const expired = () => [tokenRow('alice', { expiresAt: PAST() })];

  it('invalid_grant from the token endpoint marks refresh_failed', async () => {
    const h = mcpOAuthHarness({
      rows: expired(),
      respond: () => jsonResponse(400, { error: 'invalid_grant' }),
    });
    // The stored access token still goes out, as before: the server's 401 is
    // what makes the chat show the connect card.
    assert.equal(await h.svc.getValidAccessToken(h.server, 'alice'), 'AT-alice');
    assert.equal(h.row('alice')?.invalidReason, 'refresh_failed');
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: false,
      invalid: 'refresh_failed',
    });
  });

  it('a 200 without an access token is a refusal too', async () => {
    const h = mcpOAuthHarness({
      rows: expired(),
      respond: () => jsonResponse(200, { error: 'invalid_grant' }),
    });
    await h.svc.getValidAccessToken(h.server, 'alice');
    assert.equal(h.row('alice')?.invalidReason, 'refresh_failed');
  });

  for (const status of [500, 503, 429, 408]) {
    it(`a ${String(status)} leaves the token alone: a retry may work`, async () => {
      const h = mcpOAuthHarness({
        rows: expired(),
        respond: () => new Response('try later', { status }),
      });
      assert.equal(await h.svc.getValidAccessToken(h.server, 'alice'), 'AT-alice');
      assert.equal(h.row('alice')?.invalidReason, null);
      assert.equal((await h.svc.tokenState(HARNESS_SERVER_ID, 'alice')).connected, true);
    });
  }

  it('a network failure leaves the token alone', async () => {
    const h = mcpOAuthHarness({
      rows: expired(),
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    await h.svc.getValidAccessToken(h.server, 'alice');
    assert.equal(h.row('alice')?.invalidReason, null);
  });

  it('a later successful refresh clears the mark', async () => {
    let refuse = true;
    const h = mcpOAuthHarness({
      rows: expired(),
      respond: () =>
        refuse
          ? jsonResponse(400, { error: 'invalid_grant' })
          : jsonResponse(200, { access_token: 'AT-new', expires_in: 3600 }),
    });
    await h.svc.getValidAccessToken(h.server, 'alice');
    assert.equal(h.row('alice')?.invalidReason, 'refresh_failed');

    refuse = false;
    assert.equal(await h.svc.getValidAccessToken(h.server, 'alice'), 'AT-new');
    assert.deepEqual(await h.svc.tokenState(HARNESS_SERVER_ID, 'alice'), {
      connected: true,
      invalid: null,
    });
  });
});

describe('a token the MCP server refused', () => {
  it('markTokenRejected marks the row and keeps it', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice')] });
    await h.svc.markTokenRejected(HARNESS_SERVER_ID, 'alice');
    assert.equal(h.row('alice')?.invalidReason, 'rejected');
    assert.equal(h.vault.get(`token/${HARNESS_SERVER_ID}/alice/access`), 'AT-alice');
  });

  it('keeps the first cause when the same dead grant is refused twice', async () => {
    // A refused refresh hands out the stale token, and the server then answers
    // 401 to it. The cause is the refusal.
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice', { expiresAt: PAST() })],
      respond: () => jsonResponse(400, { error: 'invalid_grant' }),
    });
    await h.svc.getValidAccessToken(h.server, 'alice');
    await h.svc.markTokenRejected(HARNESS_SERVER_ID, 'alice');
    assert.equal(h.row('alice')?.invalidReason, 'refresh_failed');
  });

  it('marking is a no-op without a stored token', async () => {
    const h = mcpOAuthHarness({});
    await h.svc.markTokenRejected(HARNESS_SERVER_ID, 'alice');
    assert.equal(h.row('alice'), undefined);
  });

  it('a failed write is logged, not thrown', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice')] });
    (h.graph as { markMcpOAuthTokenInvalid: unknown }).markMcpOAuthTokenInvalid = async () => {
      throw new Error('connection terminated');
    };
    await h.svc.markTokenRejected(HARNESS_SERVER_ID, 'alice');
    assert.match(h.logs.join('\n'), /could not mark the token/);
  });
});

describe('GET /mcp-servers/:id/auth-status', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** The operator router over the harness, acting as the shared identity
   *  `operator` (the server row is switched to `service` delegation, so no
   *  session is needed to resolve a user key). */
  async function authStatus(
    h: ReturnType<typeof mcpOAuthHarness>,
  ): Promise<Record<string, unknown>> {
    (h.server as { delegation: string }).delegation = 'service';
    const options: AgentBuilderRouterOptions = {
      getConfigStore: () => ({}) as never,
      getGraphStore: () => h.graph,
      getRegistry: () => undefined,
      mcpOAuth: h.svc,
      mcpOAuthUserKey: 'operator',
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v1/operator', createAgentBuilderRouter(options));
    const api: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    close = () => new Promise<void>((resolve) => api.close(() => resolve()));
    const port = (api.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${String(port)}/api/v1/operator/mcp-servers/${HARNESS_SERVER_ID}/auth-status`,
    );
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  }

  it('reports a working token as connected', async () => {
    const body = await authStatus(mcpOAuthHarness({ rows: [tokenRow('operator')] }));
    assert.equal(body['connected'], true);
    assert.equal(body['tokenInvalid'], null);
  });

  it('reports no token as not connected, with nothing invalid', async () => {
    const body = await authStatus(mcpOAuthHarness({}));
    assert.equal(body['connected'], false);
    assert.equal(body['tokenInvalid'], null);
  });

  it('does not call a revoked token connected', async () => {
    const body = await authStatus(
      mcpOAuthHarness({ rows: [tokenRow('operator', { invalidReason: 'rejected' })] }),
    );
    assert.equal(body['protected'], true);
    assert.equal(body['connected'], false);
    assert.equal(body['tokenInvalid'], 'rejected');
  });

  it('does not call an expired token without a refresh token connected', async () => {
    const body = await authStatus(
      mcpOAuthHarness({
        rows: [tokenRow('operator', { expiresAt: PAST(), refreshTokenRef: null })],
      }),
    );
    assert.equal(body['connected'], false);
    assert.equal(body['tokenInvalid'], 'expired');
  });
});
