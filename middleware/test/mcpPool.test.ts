import { describe, it, after, before, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import {
  McpManager,
  mcpPoolScopeMatches,
  type McpAuthProvider,
  type McpServerConfig,
} from '@omadia/orchestrator';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';

/**
 * Connection-lifetime rules of the MCP pool (issue #563).
 *
 * The pool had no direct coverage at all, which is how a per-token stdio child
 * process, an unbounded map and a `close()` that never reached the runtime
 * survived. Every rule the manager now promises is pinned here against a real
 * spawned child (`test/fixtures/stdioMcpServer.mjs`) — the marker file that
 * fixture appends to is the spawn counter, so "one process per server" is
 * asserted on process identity, not on an internal map.
 *
 * FOOTPRINT: `npm test` runs one OS process per test *file*, all of them in
 * parallel, and this is the only file in the suite that spawns grandchildren.
 * It therefore keeps both halves of the issue — the pool rules and the route
 * handlers that drive them — in a single file, runs its suites at
 * `concurrency: 1`, and boots exactly one loopback listener for all three
 * route assertions. Splitting this back into two files buys nothing and costs
 * the timing-sensitive suites elsewhere in the repo real wall-clock; AGENTS.md
 * documents that cross-file pollution as a known, still-open bug class.
 *
 * No external I/O: stdio children plus one 127.0.0.1 listener.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdioMcpServer.mjs');

function stdioServer(
  id: string,
  marker: string,
  mode: 'ok' | 'unauthorized' = 'ok',
): McpServerConfig {
  return {
    id,
    name: `fixture-${id}`,
    transport: 'stdio',
    // Quoted: `splitCommand` honours double quotes, and process.execPath may
    // live under a path with spaces.
    endpoint: `"${process.execPath}" "${FIXTURE}"`,
    env: { MCP_FIXTURE_MARKER: marker, MCP_FIXTURE_MODE: mode },
  };
}

/** An auth provider handing out the given tokens in order (the last one
 *  repeats). `onAuthFailure` returns null so a failure surfaces raw. */
function authWithTokens(...values: readonly string[]): McpAuthProvider {
  let next = 0;
  return {
    getToken: (): Promise<string | null> => {
      const value = values[Math.min(next, values.length - 1)] ?? null;
      next += 1;
      return Promise.resolve(value);
    },
    onAuthFailure: (): Promise<string | null> => Promise.resolve(null),
  };
}

/** The `start <pid>` lines the fixture appended — one per spawned process. */
async function readStarts(marker: string): Promise<string[]> {
  try {
    const text = await readFile(marker, 'utf8');
    return text.split('\n').filter((line) => line.startsWith('start '));
  } catch {
    return [];
  }
}

async function readPids(marker: string): Promise<number[]> {
  return (await readStarts(marker)).map((line) => Number(line.slice('start '.length)));
}

/** Poll instead of sleeping a fixed amount — process death and file appends
 *  are not synchronous, and a fixed sleep is how this suite would go flaky. */
async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

interface Bench {
  readonly marker: (name: string) => string;
  readonly cleanup: () => Promise<void>;
}

async function bench(): Promise<Bench> {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mcp-pool-'));
  return {
    marker: (name: string) => join(dir, `${name}.log`),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// `concurrency: 1` is the subtest default, but it is spelled out because it is
// load-bearing here: these tests count child processes, so overlapping them
// would both break the counting and multiply this file's footprint.
describe('McpManager connection pooling (#563)', { concurrency: 1 }, () => {
  it('spawns ONE stdio child for two tokens and kills it on closeAll (AC1, AC4)', async () => {
    const { marker, cleanup } = await bench();
    const log = marker('single');
    const manager = new McpManager({ auth: authWithTokens('token-a', 'token-b') });
    const server = stdioServer('e2f7c0aa-single', log);
    try {
      assert.equal(await manager.callTool(server, 'ping', {}), 'pong');
      assert.equal(await manager.callTool(server, 'ping', {}), 'pong');
      // The stdio transport is spawned with command/args/env only — it never
      // sees the token, so a token-keyed pool bought a second identical child.
      assert.equal((await readStarts(log)).length, 1);
      assert.equal(manager.poolSize, 1);

      // AC4 rides on this child rather than spawning one of its own: the
      // shutdown rule is about the pooled process, and this IS a pooled
      // process.
      const [pid] = await readPids(log);
      assert.ok(pid !== undefined && Number.isInteger(pid), 'fixture must report its pid');
      assert.equal(isDead(pid), false);

      await manager.closeAll();
      assert.equal(manager.poolSize, 0);
      await waitFor(`pid ${String(pid)} to exit`, () => isDead(pid), 2_000);
    } finally {
      await manager.closeAll();
      await cleanup();
    }
  });

  it('scopes a pool key to its server id and never to a prefix sibling (AC2a)', () => {
    assert.equal(mcpPoolScopeMatches('srv', 'srv'), true);
    assert.equal(mcpPoolScopeMatches('srv#0123456789ab', 'srv'), true);
    // Genuine string-prefix siblings: a bare startsWith would drop these too.
    assert.equal(mcpPoolScopeMatches('srvx', 'srv'), false);
    assert.equal(mcpPoolScopeMatches('srvx#0123456789ab', 'srv'), false);
    assert.equal(mcpPoolScopeMatches('other#0123456789ab', 'srv'), false);
    // A full pool key passed as the argument matches only itself.
    assert.equal(mcpPoolScopeMatches('srv#0123456789ab', 'srv#0123456789ab'), true);
    assert.equal(mcpPoolScopeMatches('srv', 'srv#0123456789ab'), false);
  });

  it('closes only the named server, leaving its prefix sibling pooled (AC2b)', async () => {
    const { marker, cleanup } = await bench();
    const logX = marker('x');
    const logY = marker('y');
    const manager = new McpManager({ auth: authWithTokens('token-a') });
    // `pool-scope-2` starts with `pool-scope`: the no-collateral rule is what
    // keeps closing X from taking Y down with it.
    const x = stdioServer('pool-scope', logX);
    const y = stdioServer('pool-scope-2', logY);
    try {
      assert.equal(await manager.callTool(x, 'ping', {}), 'pong');
      assert.equal(await manager.callTool(y, 'ping', {}), 'pong');
      assert.equal(manager.poolSize, 2);

      await manager.close(x.id);
      assert.equal(manager.poolSize, 1);

      assert.equal(await manager.callTool(y, 'ping', {}), 'pong');
      assert.equal((await readStarts(logY)).length, 1, 'Y must not have been reconnected');
      assert.equal(await manager.callTool(x, 'ping', {}), 'pong');
      assert.equal((await readStarts(logX)).length, 2, 'X must have been reconnected exactly once');
      assert.equal(manager.poolSize, 2);
    } finally {
      await manager.closeAll();
      await cleanup();
    }
  });

  it('evicts an entry idle longer than idleTtlMs and reconnects (AC3)', async () => {
    const { marker, cleanup } = await bench();
    const log = marker('ttl');
    const manager = new McpManager({ idleTtlMs: 25, auth: authWithTokens('token-a') });
    const server = stdioServer('4f0f6c1e-ttl', log);
    try {
      assert.equal(await manager.callTool(server, 'ping', {}), 'pong');
      assert.equal(manager.poolSize, 1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(await manager.callTool(server, 'ping', {}), 'pong');
      assert.equal((await readStarts(log)).length, 2, 'the idle entry must have been evicted');
      // The evicted entry is replaced, never accumulated.
      assert.equal(manager.poolSize, 1);
    } finally {
      await manager.closeAll();
      await cleanup();
    }
  });

  it('drops the failing server on a rejected token and nothing else (AC5)', async () => {
    const { marker, cleanup } = await bench();
    const logOk = marker('ok');
    const logDenied = marker('denied');
    const manager = new McpManager({ auth: authWithTokens('stale-token') });
    const healthy = stdioServer('9c2b1d55-healthy', logOk);
    const denied = stdioServer('9c2b1d55-denied', logDenied, 'unauthorized');
    try {
      assert.equal(await manager.callTool(healthy, 'ping', {}), 'pong');
      assert.equal(manager.poolSize, 1);

      const failure = await manager.callTool(denied, 'ping', {});
      assert.match(failure, /401 Unauthorized/);
      // Only the rejected server's connection is gone — the healthy one stays.
      assert.equal(manager.poolSize, 1);
      assert.equal(await manager.callTool(healthy, 'ping', {}), 'pong');
      assert.equal((await readStarts(logOk)).length, 1, 'the healthy server must stay pooled');

      // …and the next call to the failing server reconnects with fresh creds.
      assert.match(await manager.callTool(denied, 'ping', {}), /401 Unauthorized/);
      assert.equal((await readStarts(logDenied)).length, 2, 'the failing server must reconnect');
    } finally {
      await manager.closeAll();
      await cleanup();
    }
  });
});

/**
 * Server-state mutations must reach the live connection (issue #563).
 *
 * `mcpConfigService` documents that a config change applies on the next call,
 * but nothing dropped the pooled connection, so a deleted / reconfigured /
 * disconnected server kept being served by a client holding the OLD command,
 * env, headers and bearer token. These tests assert at the ROUTE boundary —
 * the boundary the operator actually crosses — that each of the three mutating
 * handlers announces the change exactly once, for its own server id.
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
 *  is absent, so the harness cannot silently drift onto another code path.
 *  Every stub is stateless, which is what lets the three tests share one
 *  listener instead of booting — and leaking — three. */
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

describe('MCP server mutations invalidate the pooled connection (#563)', { concurrency: 1 }, () => {
  const changed: string[] = [];
  let server: Server | undefined;
  let baseUrl = '';

  before(async () => {
    const app: Express = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator',
      createAgentBuilderRouter({
        getConfigStore: () => ({}) as never,
        getGraphStore: () => makeStubGraph() as never,
        getRegistry: () => undefined,
        onMcpServerChanged: (serverId: string) => changed.push(serverId),
      }),
    );
    const started = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    server = started;
    baseUrl = `http://127.0.0.1:${String((started.address() as AddressInfo).port)}`;
  });

  after(async () => {
    const running = server;
    server = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  beforeEach(() => {
    changed.length = 0;
  });

  it('DELETE /mcp-servers/:id announces the deleted server once', async () => {
    const res = await fetch(`${baseUrl}/api/v1/operator/mcp-servers/${SERVER_ID}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(changed, [SERVER_ID]);
  });

  it('PUT /mcp-servers/:id/config announces the reconfigured server once', async () => {
    const res = await fetch(`${baseUrl}/api/v1/operator/mcp-servers/${SERVER_ID}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { API_BASE: 'https://example.invalid' } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(changed, [SERVER_ID]);
  });

  it('DELETE /mcp-servers/:id/token announces the disconnected server once', async () => {
    const res = await fetch(`${baseUrl}/api/v1/operator/mcp-servers/${SERVER_ID}/token`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(changed, [SERVER_ID]);
  });
});
