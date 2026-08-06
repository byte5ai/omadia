import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';

/**
 * Server-state mutations must reach the live connection (issue #563).
 *
 * `mcpConfigService` documents that a config change applies on the next call,
 * but nothing dropped the pooled connection, so a deleted / reconfigured /
 * disconnected server kept being served by a client holding the OLD command,
 * env, headers and bearer token. These tests assert at the ROUTE boundary —
 * the boundary the operator actually crosses — that each of the three
 * mutating handlers announces the change exactly once, for its own server id.
 */

const SERVER_ID = '7c1a9f10-4d0e-4a71-9c0b-2f5a1e3b8d44';

function serverRow(): Record<string, unknown> {
  return {
    id: SERVER_ID,
    name: 'fixture-server',
    transport: 'stdio',
    endpoint: 'node ./server.mjs',
    headers: {},
    secretRef: null,
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    source: 'manual',
    registryId: null,
    license: null,
    author: null,
    sourceUrl: null,
    privacyBypass: false,
    kgIngest: false,
    configSchema: [],
    config: {},
  };
}

/** Minimal stub of the store surface the three handlers touch. Anything else
 *  is absent, so the harness cannot silently drift onto another code path. */
function makeStubGraph(): Record<string, unknown> {
  return {
    listMcpServers: () => Promise.resolve([serverRow()]),
    deleteMcpServer: () => Promise.resolve(),
    setMcpServerConfig: () => Promise.resolve(),
    setMcpServerConfigSchema: () => Promise.resolve(),
    bumpMcpGrantEpoch: () => Promise.resolve(),
    deleteMcpOAuthToken: () => Promise.resolve(),
    // Read by refreshMcpGrantPolicy on the config-save path.
    listMcpToolVerdicts: () => Promise.resolve([]),
    listMcpToolVerdictAcks: () => Promise.resolve([]),
  };
}

interface Harness {
  readonly baseUrl: string;
  readonly changed: string[];
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const changed: string[] = [];
  const graph = makeStubGraph();
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/operator',
    createAgentBuilderRouter({
      getConfigStore: () => ({}) as never,
      getGraphStore: () => graph as never,
      getRegistry: () => undefined,
      onMcpServerChanged: (serverId: string) => changed.push(serverId),
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    changed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const h = await makeHarness();
  harnesses.push(h);
  return h;
}

after(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
});

describe('MCP server mutations invalidate the pooled connection (#563)', () => {
  it('DELETE /mcp-servers/:id announces the deleted server once', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/api/v1/operator/mcp-servers/${SERVER_ID}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(h.changed, [SERVER_ID]);
  });

  it('PUT /mcp-servers/:id/config announces the reconfigured server once', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/api/v1/operator/mcp-servers/${SERVER_ID}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { API_BASE: 'https://example.invalid' } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(h.changed, [SERVER_ID]);
  });

  it('DELETE /mcp-servers/:id/token announces the disconnected server once', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/api/v1/operator/mcp-servers/${SERVER_ID}/token`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(h.changed, [SERVER_ID]);
  });
});
