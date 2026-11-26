import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  createAgentBuilderRouter,
  type AgentBuilderRouterOptions,
} from '../src/routes/agentBuilder.js';
import { McpAuthDiscovery } from '../src/services/mcpAuthDiscovery.js';
import { McpOAuthClient } from '../src/services/mcpOAuthClient.js';
import {
  HARNESS_ISSUER,
  HARNESS_SERVER_ID,
  jsonResponse,
  mcpOAuthHarness,
  tokenRow,
  type HarnessRequest,
} from './_helpers/mcpOAuthHarness.js';

/**
 * Disconnecting ends the authorization on both sides: the grant at the
 * authorization server (RFC 7009) where it offers that, and omadia's own copy
 * in the vault and the token table. These tests pin what goes over the wire,
 * what is left behind, and what the caller is told.
 */

const REVOKE_URL = `${HARNESS_ISSUER}/revoke`;
const ok = (): Response => new Response('', { status: 200 });
const tokenKeys = (vault: Map<string, string>): string[] =>
  [...vault.keys()].filter((k) => k.startsWith('token/')).sort();
const sent = (requests: readonly HarnessRequest[]): string[] =>
  requests.map((r) => `${r.url} ${r.form.get('token_type_hint') ?? ''}=${r.form.get('token') ?? ''}`);

describe('revocation endpoint discovery', () => {
  const discoveryOver = (asDoc: Record<string, unknown>): McpAuthDiscovery =>
    new McpAuthDiscovery({
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes('oauth-protected-resource')) {
          return jsonResponse(200, {
            resource: 'https://srv.example',
            authorization_servers: [HARNESS_ISSUER],
          });
        }
        if (url.includes('oauth-authorization-server')) return jsonResponse(200, asDoc);
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });
  const AS_DOC = {
    issuer: HARNESS_ISSUER,
    authorization_endpoint: `${HARNESS_ISSUER}/authorize`,
    token_endpoint: `${HARNESS_ISSUER}/token`,
  };

  it('reads revocation_endpoint from the authorization-server metadata', async () => {
    const found = await discoveryOver({ ...AS_DOC, revocation_endpoint: REVOKE_URL }).discover(
      'https://srv.example/mcp',
    );
    assert.equal(found?.server.revocationEndpoint, REVOKE_URL);
  });

  it('is null when the authorization server advertises none', async () => {
    const found = await discoveryOver(AS_DOC).discover('https://srv.example/mcp');
    assert.equal(found?.server.revocationEndpoint, null);
  });
});

describe('McpOAuthClient.revoke', () => {
  it('posts the token, its type hint and the client credentials as a form', async () => {
    const seen: { url: string; body: string; contentType: string | null }[] = [];
    const client = new McpOAuthClient({
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push({
          url: String(input),
          body: String(init?.body),
          contentType: new Headers(init?.headers).get('content-type'),
        });
        // RFC 7009 §2.2: an empty 200 is the success answer.
        return ok();
      }) as typeof fetch,
    });
    await client.revoke({
      revocationEndpoint: REVOKE_URL,
      client: { clientId: 'cid', clientSecret: 'sec' },
      token: 'RT-1',
      tokenTypeHint: 'refresh_token',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, REVOKE_URL);
    assert.equal(seen[0]?.contentType, 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(seen[0]?.body);
    assert.deepEqual(Object.fromEntries(form), {
      token: 'RT-1',
      token_type_hint: 'refresh_token',
      client_id: 'cid',
      client_secret: 'sec',
    });
  });

  it('throws when the authorization server does not confirm', async () => {
    const client = new McpOAuthClient({
      fetchImpl: (async () => jsonResponse(503, { error: 'temporarily_unavailable' })) as typeof fetch,
    });
    await assert.rejects(
      client.revoke({
        revocationEndpoint: REVOKE_URL,
        client: { clientId: 'cid', clientSecret: null },
        token: 'RT-1',
        tokenTypeHint: 'refresh_token',
      }),
      /503/,
    );
  });
});

describe('McpOAuthService.disconnect', () => {
  it('revokes the refresh token, then the access token, and removes both sides', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice')], respond: ok });
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'revoked');
    assert.deepEqual(sent(h.requests), [
      `${REVOKE_URL} refresh_token=RT-alice`,
      `${REVOKE_URL} access_token=AT-alice`,
    ]);
    assert.equal(h.row('alice'), undefined);
    assert.deepEqual(tokenKeys(h.vault), []);
  });

  it('revokes the access token when there is no refresh token', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice', { refreshTokenRef: null })],
      respond: ok,
    });
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'revoked');
    assert.deepEqual(sent(h.requests), [`${REVOKE_URL} access_token=AT-alice`]);
  });

  it('counts the grant as revoked when only the access token is turned down', async () => {
    // RFC 7009 §2.2.1: an AS may not support revoking access tokens.
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice')],
      respond: (req) =>
        req.form.get('token_type_hint') === 'access_token'
          ? jsonResponse(400, { error: 'unsupported_token_type' })
          : ok(),
    });
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'revoked');
  });

  it('no revocation endpoint: nothing is sent, the token is removed, outcome unsupported', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice')],
      authServer: { revocationEndpoint: null },
      respond: ok,
    });
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'unsupported');
    assert.deepEqual(h.requests, []);
    assert.equal(h.row('alice'), undefined);
    assert.deepEqual(tokenKeys(h.vault), []);
  });

  it('a refused or failed revocation still removes the token, outcome failed', async () => {
    for (const respond of [
      () => jsonResponse(503, { error: 'temporarily_unavailable' }),
      () => jsonResponse(401, { error: 'invalid_client' }),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const h = mcpOAuthHarness({ rows: [tokenRow('alice')], respond });
      assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'failed');
      assert.equal(h.row('alice'), undefined);
      assert.deepEqual(tokenKeys(h.vault), []);
    }
  });

  it('never writes a token to the log when the provider echoes it back', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice')],
      respond: (req) => jsonResponse(400, { error: 'invalid_request', token: req.form.get('token') }),
    });
    await h.svc.disconnect(h.server, 'alice', { revoke: true });
    const log = h.logs.join('\n');
    assert.match(log, /revocation failed/);
    assert.doesNotMatch(log, /RT-alice|AT-alice/);
  });

  it('does not send a token to an issuer other than the one that minted it', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('alice', { issuer: 'https://old-as.example' })],
      respond: ok,
    });
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'failed');
    assert.deepEqual(h.requests, []);
    assert.equal(h.row('alice'), undefined);
  });

  it('revoke: false contacts nobody and still removes the token', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice')], respond: ok });
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: false }), 'failed');
    assert.deepEqual(h.requests, []);
    assert.deepEqual(tokenKeys(h.vault), []);
  });

  it('without a stored token: not_connected, and vault leftovers of that user go', async () => {
    const h = mcpOAuthHarness({ respond: ok });
    // What an earlier disconnect left behind before it cleaned the vault.
    h.vault.set(`token/${HARNESS_SERVER_ID}/alice/access`, 'AT-old');
    h.vault.set(`token/${HARNESS_SERVER_ID}/alice/refresh`, 'RT-old');
    assert.equal(await h.svc.disconnect(h.server, 'alice', { revoke: true }), 'not_connected');
    assert.deepEqual(h.requests, []);
    assert.deepEqual(tokenKeys(h.vault), []);
  });

  it("leaves another user's token alone", async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice'), tokenRow('bob')], respond: ok });
    await h.svc.disconnect(h.server, 'alice', { revoke: true });
    assert.notEqual(h.row('bob'), undefined);
    assert.deepEqual(tokenKeys(h.vault), [
      `token/${HARNESS_SERVER_ID}/bob/access`,
      `token/${HARNESS_SERVER_ID}/bob/refresh`,
    ]);
  });
});

describe('McpOAuthService.disconnectAll', () => {
  it("revokes every user's grant and clears the server's tokens from the vault", async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('alice'), tokenRow('bob')], respond: ok });
    // A leftover no row points at, and values that belong elsewhere.
    h.vault.set(`token/${HARNESS_SERVER_ID}/carol/refresh`, 'RT-orphan');
    h.vault.set('token/other-server/alice/access', 'AT-other');
    h.vault.set(`client/${encodeURIComponent(HARNESS_ISSUER)}/secret`, 'client-secret');

    const results = await h.svc.disconnectAll(h.server, { revoke: true });

    assert.deepEqual(
      [...results].sort((a, b) => a.userKey.localeCompare(b.userKey)),
      [
        { userKey: 'alice', revocation: 'revoked' },
        { userKey: 'bob', revocation: 'revoked' },
      ],
    );
    assert.deepEqual(
      h.requests.map((r) => r.form.get('token')).sort(),
      ['AT-alice', 'AT-bob', 'RT-alice', 'RT-bob'],
    );
    assert.deepEqual([...h.vault.keys()].sort(), [
      `client/${encodeURIComponent(HARNESS_ISSUER)}/secret`,
      'token/other-server/alice/access',
    ]);
  });
});

describe('disconnect and delete routes', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  type Audit = Parameters<NonNullable<AgentBuilderRouterOptions['auditMcpOAuthDisconnect']>>[0];

  /** The operator router over the harness. The server is on `service`
   *  delegation, so the acting identity is the shared `operator`. */
  async function api(h: ReturnType<typeof mcpOAuthHarness>): Promise<{
    base: string;
    audits: Audit[];
    deletedServers: string[];
    changed: string[];
  }> {
    (h.server as { delegation: string }).delegation = 'service';
    const audits: Audit[] = [];
    const deletedServers: string[] = [];
    const changed: string[] = [];
    Object.assign(h.graph, {
      deleteMcpServer: async (id: string) => {
        deletedServers.push(id);
      },
    });
    const options: AgentBuilderRouterOptions = {
      getConfigStore: () => ({}) as never,
      getGraphStore: () => h.graph,
      getRegistry: () => undefined,
      mcpOAuth: h.svc,
      mcpOAuthUserKey: 'operator',
      onMcpServerChanged: (id) => changed.push(id),
      auditMcpOAuthDisconnect: async (entry) => {
        audits.push(entry);
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v1/operator', createAgentBuilderRouter(options));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
      base: `http://127.0.0.1:${String(port)}/api/v1/operator/mcp-servers/${HARNESS_SERVER_ID}`,
      audits,
      deletedServers,
      changed,
    };
  }

  it('DELETE …/token revokes, removes, audits and reports the outcome', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('operator')], respond: ok });
    const a = await api(h);
    const res = await fetch(`${a.base}/token`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { revocation: 'revoked' });
    assert.equal(h.requests.length, 2);
    assert.equal(h.row('operator'), undefined);
    assert.deepEqual(tokenKeys(h.vault), []);
    assert.deepEqual(a.changed, [HARNESS_SERVER_ID]);
    assert.equal(a.audits.length, 1);
    assert.deepEqual(
      {
        serverId: a.audits[0]?.serverId,
        serverName: a.audits[0]?.serverName,
        identity: a.audits[0]?.identity,
        cause: a.audits[0]?.cause,
        revocation: a.audits[0]?.revocation,
      },
      {
        serverId: HARNESS_SERVER_ID,
        serverName: 'srv',
        identity: 'operator',
        cause: 'disconnect',
        revocation: 'revoked',
      },
    );
    assert.doesNotMatch(JSON.stringify(a.audits), /AT-operator|RT-operator/);
  });

  it('DELETE …/token tells the caller when the provider offers no revocation', async () => {
    const h = mcpOAuthHarness({
      rows: [tokenRow('operator')],
      authServer: { revocationEndpoint: null },
    });
    const a = await api(h);
    const res = await fetch(`${a.base}/token`, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { revocation: 'unsupported' });
    assert.equal(a.audits[0]?.revocation, 'unsupported');
  });

  it('DELETE …/token with nothing stored writes no audit row', async () => {
    const h = mcpOAuthHarness({});
    const a = await api(h);
    const res = await fetch(`${a.base}/token`, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { revocation: 'not_connected' });
    assert.deepEqual(a.audits, []);
  });

  it('DELETE /mcp-servers/:id revokes and clears every token before the row goes', async () => {
    const h = mcpOAuthHarness({ rows: [tokenRow('operator'), tokenRow('bob')], respond: ok });
    const a = await api(h);
    const res = await fetch(a.base, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.deepEqual(a.deletedServers, [HARNESS_SERVER_ID]);
    assert.equal(h.requests.length, 4);
    assert.deepEqual(tokenKeys(h.vault), []);
    assert.deepEqual(
      a.audits.map((e) => `${e.identity}:${e.cause}:${e.revocation}`).sort(),
      ['bob:server_delete:revoked', 'operator:server_delete:revoked'],
    );
  });
});
