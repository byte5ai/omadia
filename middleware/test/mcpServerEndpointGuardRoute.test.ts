import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createAgentBuilderRouter,
  type AgentBuilderRouterOptions,
} from '../src/routes/agentBuilder.js';
import { MCP_STDIO_DISABLED_MESSAGE } from '../src/services/mcpOutboundHostGuard.js';

/**
 * Route tests for issues #1341 / #1342: the operator outbound host rule at
 * save time (`POST /mcp-registries`, `POST /mcp-servers`), the stdio switch
 * (`MCP_STDIO_ENABLED`) at save time (manual + catalog import) and connect
 * time (Discover), and the OAuth routes that would otherwise fetch metadata
 * from a refused host.
 */

const BLOCKED_ID = '44444444-4444-4444-8444-444444444441';
const STDIO_ID = '44444444-4444-4444-8444-444444444442';

function serverRow(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: 'row',
    transport: 'http',
    endpoint: 'http://169.254.169.254/',
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    delegation: 'service',
    source: 'manual',
    registryId: null,
    license: null,
    author: null,
    sourceUrl: null,
    privacyBypass: false,
    kgIngest: false,
    configSchema: [],
    config: {},
    headers: {},
    ...overrides,
  };
}

interface Harness {
  baseUrl: string;
  created: {
    servers: Array<Record<string, unknown>>;
    registries: Array<Record<string, unknown>>;
  };
  audits: Array<Record<string, unknown>>;
  oauthCalls: string[];
  close(): Promise<void>;
}

async function makeHarness(
  opts: {
    stdioEnabled?: boolean;
    rows?: ReadonlyArray<Record<string, unknown>>;
    registries?: ReadonlyArray<Record<string, unknown>>;
  } = {},
): Promise<Harness> {
  const created: Harness['created'] = { servers: [], registries: [] };
  const audits: Array<Record<string, unknown>> = [];
  const oauthCalls: string[] = [];
  const rows = [...(opts.rows ?? [])];
  const graph = {
    listMcpServers: () => Promise.resolve(rows),
    listMcpRegistries: () => Promise.resolve(opts.registries ?? []),
    createMcpServer: (input: Record<string, unknown>) => {
      created.servers.push(input);
      const row = serverRow(`55555555-5555-4555-8555-55555555555${String(created.servers.length)}`, input);
      rows.push(row);
      return Promise.resolve(row);
    },
    createMcpRegistry: (input: Record<string, unknown>) => {
      created.registries.push(input);
      return Promise.resolve({ id: '66666666-6666-4666-8666-666666666666', ...input });
    },
    listMcpToolVerdicts: () => Promise.resolve([]),
    listMcpToolVerdictAcks: () => Promise.resolve([]),
  };
  const refuseOauth = (name: string) => () => {
    oauthCalls.push(name);
    return Promise.reject(new Error(`${name} must not be called for a refused host`));
  };
  const options: AgentBuilderRouterOptions = {
    getConfigStore: () => ({}) as never,
    getGraphStore: () => graph as never,
    getRegistry: () => undefined,
    ...(opts.stdioEnabled !== undefined ? { mcpStdioEnabled: opts.stdioEnabled } : {}),
    auditMcpStdioServerSaved: (entry) => {
      audits.push({ ...entry });
      return Promise.resolve();
    },
    mcpOAuth: {
      redirectUri: 'http://localhost/cb',
      isProtected: refuseOauth('isProtected'),
      issuerFor: refuseOauth('issuerFor'),
      describeAuth: refuseOauth('describeAuth'),
      beginAuthorization: refuseOauth('beginAuthorization'),
      completeAuthorization: refuseOauth('completeAuthorization'),
      setManualClient: refuseOauth('setManualClient'),
      getValidAccessToken: () => Promise.resolve(null),
    },
    mcpOAuthUserKey: 'operator',
  };
  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/operator', createAgentBuilderRouter(options));
  const httpServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator`,
    created,
    audits,
    oauthCalls,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function post(url: string, body: unknown = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('MCP outbound host guard + stdio switch — routes (#1341 / #1342)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('POST /mcp-registries refuses a metadata URL with 400 blocked_host and stores nothing', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-registries`, {
      name: 'ssrf-test',
      url: 'http://169.254.169.254/catalog',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'invalid_registry',
      code: 'blocked_host',
      message: 'link-local/metadata address refused: 169.254.169.254',
    });
    assert.equal(h.created.registries.length, 0);
  });

  it('POST /mcp-registries keeps accepting a private/intranet registry', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-registries`, {
      name: 'intranet',
      url: 'http://postgres:5432/',
    });
    assert.equal(res.status, 200);
    assert.equal(h.created.registries.length, 1);
  });

  it('POST /mcp-servers refuses an http endpoint at 169.254.169.254 and stores nothing', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-servers`, {
      name: 'meta-test',
      transport: 'http',
      endpoint: 'http://169.254.169.254/',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'mcp_endpoint_refused',
      code: 'blocked_host',
      message: 'link-local/metadata address refused: 169.254.169.254',
    });
    assert.equal(h.created.servers.length, 0);
  });

  it('POST /mcp-servers refuses an sse endpoint at an IPv6 link-local literal', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-servers`, {
      name: 'v6',
      transport: 'sse',
      endpoint: 'http://[fe80::1]/sse',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'blocked_host');
    assert.equal(h.created.servers.length, 0);
  });

  for (const endpoint of ['http://postgres:5432/', 'http://localhost:8080/mcp']) {
    it(`POST /mcp-servers keeps accepting ${endpoint}`, async () => {
      h = await makeHarness();
      const res = await post(`${h.baseUrl}/mcp-servers`, {
        name: 'intranet',
        transport: 'http',
        endpoint,
      });
      assert.equal(res.status, 200);
      assert.equal(h.created.servers.length, 1);
    });
  }

  it('POST /mcp-servers does not newly reject a templated endpoint (the connect guard is the backstop)', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-servers`, {
      name: 'templated',
      transport: 'http',
      endpoint: 'https://{tenant}.example.com/mcp',
    });
    assert.equal(res.status, 200);
  });

  it('POST /mcp-servers refuses stdio with 400 stdio_disabled when MCP_STDIO_ENABLED=false', async () => {
    h = await makeHarness({ stdioEnabled: false });
    const res = await post(`${h.baseUrl}/mcp-servers`, {
      name: 'stdio-test',
      transport: 'stdio',
      endpoint: 'sh -c "whoami > /tmp/stdio-test"',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'mcp_stdio_disabled',
      code: 'stdio_disabled',
      message: MCP_STDIO_DISABLED_MESSAGE,
    });
    assert.equal(h.created.servers.length, 0);
    assert.equal(h.audits.length, 0);
  });

  it('POST /mcp-servers saves stdio by default and audits it without the command line', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-servers`, {
      name: 'stdio-ok',
      transport: 'stdio',
      endpoint: 'npx -y -- some-server --token=SECRET',
    });
    assert.equal(res.status, 200);
    assert.equal(h.created.servers.length, 1);
    assert.equal(h.audits.length, 1);
    const audit = h.audits[0] ?? {};
    assert.equal(audit['serverName'], 'stdio-ok');
    assert.equal(audit['source'], 'manual');
    assert.doesNotMatch(JSON.stringify(audit), /SECRET|npx/);
  });

  it('POST /mcp-servers does not audit an http server', async () => {
    h = await makeHarness();
    const res = await post(`${h.baseUrl}/mcp-servers`, {
      name: 'remote',
      transport: 'http',
      endpoint: 'http://localhost:8080/mcp',
    });
    assert.equal(res.status, 200);
    assert.equal(h.audits.length, 0);
  });

  it('POST /mcp-servers/:id/discover maps a refused existing row to 502 blocked_host, no OAuth probe', async () => {
    h = await makeHarness({ rows: [serverRow(BLOCKED_ID, { name: 'meta-test' })] });
    const res = await post(`${h.baseUrl}/mcp-servers/${BLOCKED_ID}/discover`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: 'mcp_discover_failed',
      code: 'blocked_host',
      message: 'link-local/metadata address refused: 169.254.169.254',
    });
    assert.deepEqual(h.oauthCalls, []);
  });

  it('POST /mcp-servers/:id/discover refuses an existing stdio row while disabled, without spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-route-'));
    const marker = join(dir, 'spawned');
    try {
      h = await makeHarness({
        stdioEnabled: false,
        rows: [serverRow(STDIO_ID, { name: 'stdio-test', transport: 'stdio', endpoint: `touch ${marker}` })],
      });
      const res = await post(`${h.baseUrl}/mcp-servers/${STDIO_ID}/discover`);
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), {
        error: 'mcp_discover_failed',
        code: 'stdio_disabled',
        message: MCP_STDIO_DISABLED_MESSAGE,
      });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(existsSync(marker), false, 'no child process may be spawned');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('GET /mcp-servers/:id/auth-status refuses a blocked endpoint before describeAuth', async () => {
    h = await makeHarness({ rows: [serverRow(BLOCKED_ID, {})] });
    const res = await fetch(`${h.baseUrl}/mcp-servers/${BLOCKED_ID}/auth-status`);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { code: string }).code, 'blocked_host');
    assert.deepEqual(h.oauthCalls, []);
  });

  it('POST /mcp-servers/:id/authorize refuses a blocked endpoint before beginAuthorization', async () => {
    h = await makeHarness({ rows: [serverRow(BLOCKED_ID, {})] });
    const res = await post(`${h.baseUrl}/mcp-servers/${BLOCKED_ID}/authorize`);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { code: string }).code, 'blocked_host');
    assert.deepEqual(h.oauthCalls, []);
  });

  it('auth-status checks the endpoint AFTER config substitution', async () => {
    h = await makeHarness({
      rows: [
        serverRow(BLOCKED_ID, {
          endpoint: 'http://{host}/mcp',
          config: { host: '169.254.169.254' },
        }),
      ],
    });
    const res = await fetch(`${h.baseUrl}/mcp-servers/${BLOCKED_ID}/auth-status`);
    assert.equal(res.status, 502);
    assert.deepEqual(h.oauthCalls, []);
  });
});

describe('POST /mcp-servers/from-registry with a stdio catalog entry (#1342)', () => {
  const REGISTRY_ID = '77777777-7777-4777-8777-777777777777';
  const catalog = {
    servers: [
      {
        name: 'io.github.example/stdio-server',
        description: 'stdio only',
        packages: [{ registry_type: 'npm', identifier: 'example-mcp-server' }],
      },
    ],
  };
  let h: Harness | undefined;
  let originalFetch: typeof fetch | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
    if (originalFetch) globalThis.fetch = originalFetch;
    originalFetch = undefined;
  });

  /** The router's registry client captures `globalThis.fetch` at creation, so
   *  the catalog stub is installed before the harness and delegates all other
   *  requests (the test's own HTTP calls) to the real fetch. */
  async function harnessWithCatalog(stdioEnabled?: boolean): Promise<Harness> {
    const realFetch = globalThis.fetch;
    originalFetch = realFetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('http://registry.test')) {
        return Promise.resolve(
          new Response(JSON.stringify(catalog), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;
    return makeHarness({
      ...(stdioEnabled !== undefined ? { stdioEnabled } : {}),
      registries: [
        { id: REGISTRY_ID, name: 'test', url: 'http://registry.test/', authKind: 'none', kind: 'generic' },
      ],
    });
  }

  it('refuses the import with 400 stdio_disabled when stdio is off', async () => {
    h = await harnessWithCatalog(false);
    const res = await post(`${h.baseUrl}/mcp-servers/from-registry`, {
      registryId: REGISTRY_ID,
      catalogEntryId: 'io.github.example/stdio-server',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'mcp_stdio_disabled',
      code: 'stdio_disabled',
      message: MCP_STDIO_DISABLED_MESSAGE,
    });
    assert.equal(h.created.servers.length, 0);
  });

  it('imports it by default and audits the marketplace source', async () => {
    h = await harnessWithCatalog();
    const res = await post(`${h.baseUrl}/mcp-servers/from-registry`, {
      registryId: REGISTRY_ID,
      catalogEntryId: 'io.github.example/stdio-server',
    });
    assert.equal(res.status, 200);
    assert.equal(h.created.servers[0]?.['transport'], 'stdio');
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0]?.['source'], 'marketplace');
    assert.doesNotMatch(JSON.stringify(h.audits[0]), /npx/);
  });
});
