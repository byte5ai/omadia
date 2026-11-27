/**
 * #2312 / ADR-0301 — a directory person connects a per_user MCP server with
 * their Teams SSO token: the flow is keyed on their object id and marked
 * `teams-sso`; it completes only through that path, only for the same person.
 */
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import { createDirectoryConnectRouter } from '../src/directory/directoryConnectRoutes.js';
import type { DirectoryPerson } from '../src/directory/directoryStore.js';
import { McpOAuthCompleterMismatchError, McpOAuthService } from '../src/services/mcpOAuthService.js';
import { mcpOAuthTeamsHandBackPage } from '../src/routes/mcpOAuthCallbackPage.js';

const TENANT = '11111111-2222-4333-8444-555555555555';
const OID = '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

const person = (status: DirectoryPerson['status'] = 'active'): DirectoryPerson => ({
  id: 'p1',
  source: 'entra',
  tenantId: TENANT,
  externalId: OID,
  upn: 'paula@contoso.com',
  mail: null,
  displayName: 'Paula',
  accountEnabled: true,
  status,
  firstSeenAt: new Date(0),
  syncedAt: new Date(0),
  deprovisionedAt: null,
});

const SERVER = { id: 'srv-1', name: 'Notion', delegation: 'per_user', transport: 'http', endpoint: 'https://mcp.example' };

async function serve(opts: { oid?: string; personStatus?: DirectoryPerson['status']; delegation?: string }) {
  const calls: { begin: unknown[]; complete: { completer: string | null; opts: unknown }[] } = { begin: [], complete: [] };
  const app = express();
  app.use(express.json());
  // Stands in for the kernel's Teams SSO gate.
  app.use((req, _res, next) => {
    if (opts.oid) req.teamsSsoUser = { oid: opts.oid, tenantId: TENANT, appId: 'app' };
    next();
  });
  app.use(
    createDirectoryConnectRouter({
      store: {
        findByExternalId: async (_s, tenant, oid) =>
          tenant === TENANT && oid === OID ? person(opts.personStatus) : null,
      },
      listServers: async () => [{ ...SERVER, delegation: opts.delegation ?? 'per_user' } as never],
      oauth: {
        isProtected: async () => true,
        beginAuthorization: async (_server, userKey, actor, o) => {
          calls.begin.push({ userKey, actor, o });
          return { authorizeUrl: 'https://as.example/authorize?state=ST' };
        },
        completeAuthorization: async (_state, _code, _iss, completingUserKeyFor, o) => {
          const completer = await completingUserKeyFor({ serverId: 'srv-1', userKey: OID });
          calls.complete.push({ completer, opts: o });
          if (completer !== OID) throw new McpOAuthCompleterMismatchError();
          return { serverId: 'srv-1' };
        },
      },
      audit: () => ({ record: async () => undefined }),
      log: () => undefined,
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('ADR-0301 · directory connect routes', () => {
  it('starts a teams-sso flow keyed on the object id of an active person', async () => {
    const h = await serve({ oid: OID.toUpperCase() });
    try {
      const res = await h.post('/mcp/srv-1/start');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { startUrl: '/api/v1/directory/connect/go/ST' });
      assert.deepEqual(h.calls.begin, [{ userKey: OID, actor: { email: 'directory:p1' }, o: { completion: 'teams-sso' } }]);
    } finally {
      await h.close();
    }
  });

  it('refuses a token of nobody in the directory, a deprovisioned person, and a service server', async () => {
    for (const [opts, status, code] of [
      [{ oid: 'someone-else' }, 403, 'directory.not_a_person'],
      [{ oid: OID, personStatus: 'deprovisioned' as const }, 403, 'directory.not_a_person'],
      [{ oid: OID, delegation: 'service' }, 409, 'directory.not_per_user'],
    ] as const) {
      const h = await serve(opts);
      try {
        const res = await h.post('/mcp/srv-1/start');
        assert.equal(res.status, status);
        assert.equal(((await res.json()) as { code: string }).code, code);
        assert.equal(h.calls.begin.length, 0);
      } finally {
        await h.close();
      }
    }
  });

  it('completes only for the same person; another token consumes the flow and stores nothing', async () => {
    const ok = await serve({ oid: OID });
    try {
      const res = await ok.post('/mcp/complete', { state: 'ST', code: 'C' });
      assert.equal(res.status, 200);
      assert.deepEqual(ok.calls.complete, [{ completer: OID, opts: { completion: 'teams-sso' } }]);
    } finally {
      await ok.close();
    }
    const other = await serve({ oid: 'someone-else' });
    try {
      const res = await other.post('/mcp/complete', { state: 'ST', code: 'C' });
      assert.equal(res.status, 403);
      assert.equal(other.calls.complete[0]?.completer, null);
    } finally {
      await other.close();
    }
  });
});

describe('ADR-0301 · McpOAuthService completion modes', () => {
  const flow = (completion?: string) => ({
    state: 'ST',
    serverId: 'srv-1',
    userKey: OID,
    issuer: 'https://as.example',
    codeVerifier: 'V',
    redirectUri: 'https://host/cb',
    scopes: null,
    tokenEndpoint: 'https://as.example/token',
    authorizationEndpoint: 'https://as.example/authorize',
    issRequired: false,
    ...(completion ? { completion } : {}),
  });
  const service = (f: Record<string, unknown>, exchanged: { n: number }) => {
    let pending: Record<string, unknown> | undefined = f;
    return new McpOAuthService({
      graph: {
        takeMcpOAuthFlow: async () => {
          const t = pending;
          pending = undefined;
          return t;
        },
        getMcpOAuthClient: async () => ({ clientId: 'cid', clientSecretRef: null }),
        upsertMcpOAuthToken: async () => undefined,
      } as never,
      vault: { get: async () => undefined, set: async () => undefined } as never,
      redirectUri: 'https://host/cb',
      client: {
        exchangeCode: async () => {
          exchanged.n += 1;
          return { accessToken: 'AT', refreshToken: null, expiresInSec: null, scope: null };
        },
      } as never,
    });
  };

  it('a teams-sso flow never completes at the session callback, a session flow never via Teams', async () => {
    const exchanged = { n: 0 };
    await assert.rejects(
      service(flow('teams-sso'), exchanged).completeAuthorization('ST', 'C', null, async () => OID),
      McpOAuthCompleterMismatchError,
    );
    await assert.rejects(
      service(flow(), exchanged).completeAuthorization('ST', 'C', null, async () => OID, { completion: 'teams-sso' }),
      McpOAuthCompleterMismatchError,
    );
    assert.equal(exchanged.n, 0);
    await service(flow('teams-sso'), exchanged).completeAuthorization('ST', 'C', null, async () => OID, {
      completion: 'teams-sso',
    });
    assert.equal(exchanged.n, 1);
  });
});

describe('ADR-0301 · hand-back page', () => {
  it('embeds the payload as escaped JSON, not as script source', () => {
    const { html, csp } = mcpOAuthTeamsHandBackPage('en', { state: 'S', code: '</script><b>x', iss: null, error: null });
    assert.match(csp, /^default-src 'none'; script-src 'sha256-/);
    assert.match(html, /integrity="sha384-/);
    assert.ok(!html.includes('</script><b>'));
    assert.ok(html.includes('\\u003c/script>\\u003cb>x'));
    assert.match(html, /notifySuccess/);
  });
});

describe('ADR-0301 · connect redirect and connect requests', () => {
  it('redirects only to a stored https authorize URL', async () => {
    const { createDirectoryConnectRedirect } = await import('../src/directory/directoryConnectRoutes.js');
    const app = express();
    app.use(
      '/go',
      createDirectoryConnectRedirect({
        authorizeUrl: async (state) =>
          state === 'ST' ? 'https://as.example/authorize?state=ST' : state === 'BAD' ? 'javascript:alert(1)' : undefined,
      }),
    );
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const ok = await fetch(`${base}/go/ST`, { redirect: 'manual' });
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get('location'), 'https://as.example/authorize?state=ST');
      assert.equal((await fetch(`${base}/go/BAD`, { redirect: 'manual' })).status, 404);
      assert.equal((await fetch(`${base}/go/unknown`, { redirect: 'manual' })).status, 404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reads the server of a minted connect prompt', async () => {
    const { parseMcpConnectRequest } = await import('../packages/harness-orchestrator/src/mcp/mcpAuthPromptMint.js');
    const prompt =
      '🔒 The MCP server "A&amp;B" needs authorization.\n<mcp-auth-required serverId="srv-1" server="A&amp;B" needsClient="false"></mcp-auth-required>';
    assert.deepEqual(parseMcpConnectRequest(prompt), { serverId: 'srv-1', serverName: 'A&B' });
    assert.equal(parseMcpConnectRequest('no block'), undefined);
  });
});

describe('ADR-0301 · public path', () => {
  it('opens only the connect routes, nothing else under /api/v1/directory', async () => {
    const { STATIC_PUBLIC_PATHS } = await import('../src/auth/publicPaths.js');
    const pub = (p: string) => STATIC_PUBLIC_PATHS.some((r) => r.test(p));
    assert.ok(pub('/api/v1/directory/connect/mcp/srv/start'));
    assert.ok(pub('/api/v1/directory/connect/go/STATE'));
    assert.ok(!pub('/api/v1/directory/connect'));
    assert.ok(!pub('/api/v1/directory/connectx/mcp/'));
    assert.ok(!pub('/api/v1/admin/directory'));
  });
});

describe('#2312 · connect requests are per turn', () => {
  it('two concurrent turns keep their own servers', async () => {
    const { turnContext } = await import('../packages/harness-orchestrator/src/turnContext.js');
    const mapA = new Map();
    const mapB = new Map();
    await Promise.all([
      turnContext.run({ turnId: 'a', turnDate: 'd', mcpConnectRequests: mapA }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        turnContext.current()?.mcpConnectRequests?.set('srv-a', { serverId: 'srv-a', serverName: 'A' });
      }),
      turnContext.run({ turnId: 'b', turnDate: 'd', mcpConnectRequests: mapB }, async () => {
        turnContext.current()?.mcpConnectRequests?.set('srv-b', { serverId: 'srv-b', serverName: 'B' });
      }),
    ]);
    assert.deepEqual([...mapA.keys()], ['srv-a']);
    assert.deepEqual([...mapB.keys()], ['srv-b']);
  });
});
