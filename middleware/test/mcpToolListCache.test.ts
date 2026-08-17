import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  McpManager,
  mcpToolListCacheKey,
  mcpToolListTtlMs,
  MCP_TOOLLIST_DEFAULT_TTL_MS,
  MCP_TOOLLIST_MAX_TTL_MS,
  type McpAuthProvider,
  type McpServerConfig,
} from '@omadia/orchestrator';

/**
 * Tool-list caching rules (#545, MCP 2026-07-28 `CacheableResult`; ADR-0009).
 *
 * The pure rules — TTL normalisation, scope keying — are pinned as unit tests.
 * The stateful behaviour (hit, expiry, `fresh` bypass, `close()` purge,
 * `list_changed` purge) runs against the same stdio fixture the pool tests use
 * (`test/fixtures/stdioMcpServer.mjs`): its `list <pid>` marker lines are the
 * ground truth for "did the wire get asked again", so a cache hit is asserted
 * on server-observed behaviour rather than on internal maps.
 *
 * FOOTPRINT: spawns stdio children — suites run at `concurrency: 1`, like
 * `mcpPool.test.ts` and for the same reason.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdioMcpServer.mjs');

function stdioServer(
  id: string,
  marker: string,
  env: Record<string, string> = {},
): McpServerConfig {
  return {
    id,
    name: `fixture-${id}`,
    transport: 'stdio',
    endpoint: `"${process.execPath}" "${FIXTURE}"`,
    env: { MCP_FIXTURE_MARKER: marker, MCP_FIXTURE_MODE: 'ok', ...env },
  };
}

/** The `list <pid>` lines the fixture appended — one per `tools/list` served. */
async function listCalls(marker: string): Promise<number> {
  try {
    const text = await readFile(marker, 'utf8');
    return text.split('\n').filter((line) => line.startsWith('list ')).length;
  } catch {
    return 0;
  }
}

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

describe('mcpToolListTtlMs (pure rules)', () => {
  it('honours a server ttlMs and clamps it to the ceiling', () => {
    assert.equal(mcpToolListTtlMs(5_000, 60_000), 5_000);
    assert.equal(mcpToolListTtlMs(86_400_000, 60_000), MCP_TOOLLIST_MAX_TTL_MS);
  });

  it('reads ttlMs: 0 as "do not cache" — the default must not resurrect it', () => {
    assert.equal(mcpToolListTtlMs(0, 60_000), 0);
  });

  it('reads a negative ttlMs as 0 (spec)', () => {
    assert.equal(mcpToolListTtlMs(-1, 60_000), 0);
  });

  it('falls back to the default when ttlMs is absent or malformed (ADR-0009)', () => {
    assert.equal(mcpToolListTtlMs(undefined, 60_000), 60_000);
    assert.equal(mcpToolListTtlMs('60000', 60_000), 60_000);
    assert.equal(mcpToolListTtlMs(Number.NaN, 60_000), 60_000);
  });

  it('a defaultTtlMs of 0 restores the spec-strict reading', () => {
    assert.equal(mcpToolListTtlMs(undefined, 0), 0);
  });

  it('clamps the default too — no path escapes the ceiling', () => {
    assert.equal(mcpToolListTtlMs(undefined, 86_400_000), MCP_TOOLLIST_MAX_TTL_MS);
  });
});

describe('mcpToolListCacheKey (pure rules)', () => {
  it('shares a public list under the bare server id', () => {
    assert.equal(mcpToolListCacheKey('srv#abc123', 'srv', 'public'), 'srv');
  });

  it('keeps private, absent, and unrecognised scopes under the pool key', () => {
    assert.equal(mcpToolListCacheKey('srv#abc123', 'srv', 'private'), 'srv#abc123');
    assert.equal(mcpToolListCacheKey('srv#abc123', 'srv', undefined), 'srv#abc123');
    assert.equal(mcpToolListCacheKey('srv#abc123', 'srv', 'org'), 'srv#abc123');
  });
});

describe('McpManager tool-list cache (stdio fixture)', { concurrency: 1 }, () => {
  const dirs: string[] = [];
  const managers: McpManager[] = [];

  async function bench(): Promise<(name: string) => string> {
    const dir = await mkdtemp(join(tmpdir(), 'omadia-mcp-toollist-'));
    dirs.push(dir);
    return (name: string) => join(dir, `${name}.marker`);
  }

  function manager(options?: ConstructorParameters<typeof McpManager>[0]): McpManager {
    const m = new McpManager(options);
    managers.push(m);
    return m;
  }

  after(async () => {
    await Promise.all(managers.map((m) => m.closeAll()));
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('serves the second listing from cache when the server sends a ttlMs', async () => {
    const marker = (await bench())('ttl');
    const cfg = stdioServer('cache-hit', marker, { MCP_FIXTURE_LIST_TTL_MS: '60000' });
    const m = manager();
    const first = await m.listTools(cfg);
    assert.equal(first.length, 1);
    const second = await m.listTools(cfg);
    assert.deepEqual(second, first);
    assert.equal(await listCalls(marker), 1);
  });

  it('applies the ADR-0009 default when the server sends no ttlMs', async () => {
    const marker = (await bench())('default');
    const cfg = stdioServer('cache-default', marker);
    const m = manager(); // no toolListTtlMs option → MCP_TOOLLIST_DEFAULT_TTL_MS
    assert.equal(MCP_TOOLLIST_DEFAULT_TTL_MS > 0, true);
    await m.listTools(cfg);
    await m.listTools(cfg);
    assert.equal(await listCalls(marker), 1);
  });

  it('toolListTtlMs: 0 is spec-strict — no ttlMs, no cache', async () => {
    const marker = (await bench())('strict');
    const cfg = stdioServer('cache-strict', marker);
    const m = manager({ toolListTtlMs: 0 });
    await m.listTools(cfg);
    await m.listTools(cfg);
    assert.equal(await listCalls(marker), 2);
  });

  it('OMADIA_MCP_TOOLLIST_TTL_MS=0 opts the env path into spec-strict too', async () => {
    const marker = (await bench())('env-strict');
    const cfg = stdioServer('cache-env-strict', marker);
    const m = manager(); // no option → the env var decides
    process.env['OMADIA_MCP_TOOLLIST_TTL_MS'] = '0';
    try {
      await m.listTools(cfg);
      await m.listTools(cfg);
    } finally {
      delete process.env['OMADIA_MCP_TOOLLIST_TTL_MS'];
    }
    assert.equal(await listCalls(marker), 2);
  });

  it('a server ttlMs of 0 is never cached, even with a default configured', async () => {
    const marker = (await bench())('zero');
    const cfg = stdioServer('cache-zero', marker, { MCP_FIXTURE_LIST_TTL_MS: '0' });
    const m = manager({ toolListTtlMs: 60_000 });
    await m.listTools(cfg);
    await m.listTools(cfg);
    assert.equal(await listCalls(marker), 2);
  });

  it('fresh: true bypasses a still-fresh cache (Discovery/Rescan path)', async () => {
    const marker = (await bench())('fresh');
    const cfg = stdioServer('cache-fresh', marker, { MCP_FIXTURE_LIST_TTL_MS: '60000' });
    const m = manager();
    await m.listTools(cfg);
    await m.listTools(cfg, { fresh: true });
    assert.equal(await listCalls(marker), 2);
    // …and the fresh result re-primes the cache.
    await m.listTools(cfg);
    assert.equal(await listCalls(marker), 2);
  });

  it('an expired entry is re-fetched', async () => {
    const marker = (await bench())('expiry');
    const cfg = stdioServer('cache-expiry', marker, { MCP_FIXTURE_LIST_TTL_MS: '20' });
    const m = manager();
    await m.listTools(cfg);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await m.listTools(cfg);
    assert.equal(await listCalls(marker), 2);
  });

  it('close(serverId) purges the cached list along with the connections', async () => {
    const marker = (await bench())('close');
    const cfg = stdioServer('cache-close', marker, { MCP_FIXTURE_LIST_TTL_MS: '60000' });
    const m = manager();
    await m.listTools(cfg);
    await m.close(cfg.id);
    await m.listTools(cfg);
    assert.equal(await listCalls(marker), 2);
  });

  it('OMADIA_MCP_TOOLLIST_TTL_MS with a negative value reads as 0 — same rule as the option path', async () => {
    const marker = (await bench())('env-negative');
    const cfg = stdioServer('cache-env-negative', marker);
    const m = manager();
    process.env['OMADIA_MCP_TOOLLIST_TTL_MS'] = '-5';
    try {
      await m.listTools(cfg);
      await m.listTools(cfg);
    } finally {
      delete process.env['OMADIA_MCP_TOOLLIST_TTL_MS'];
    }
    assert.equal(await listCalls(marker), 2);
  });

  it('a caller mutating the returned descriptors cannot poison the cache', async () => {
    const marker = (await bench())('mutate');
    const cfg = stdioServer('cache-mutate', marker, { MCP_FIXTURE_LIST_TTL_MS: '60000' });
    const m = manager();
    const first = await m.listTools(cfg);
    // Plugins get these objects via `ctx.mcp.listTools()`; `readonly` only
    // protects at the type level, so simulate a misbehaving JS caller.
    (first[0] as { name: string }).name = 'poisoned';
    first.pop();
    const second = await m.listTools(cfg);
    assert.equal(await listCalls(marker), 1); // still served from cache …
    assert.equal(second[0]?.name, 'ping'); // … and unpoisoned
    (second[0] as { name: string }).name = 'poisoned-again'; // hit path too
    const third = await m.listTools(cfg);
    assert.equal(third[0]?.name, 'ping');
  });

  it('notifications/tools/list_changed purges a still-fresh entry', async () => {
    const marker = (await bench())('changed');
    const cfg = stdioServer('cache-changed', marker, {
      MCP_FIXTURE_LIST_TTL_MS: '60000',
      MCP_FIXTURE_LIST_CHANGED: '1',
    });
    const m = manager();
    await m.listTools(cfg);
    // The notification is written by the child right after its first list
    // response; give the client loop a beat to dispatch it.
    await waitFor(
      'list_changed to invalidate the cache',
      async () => {
        await m.listTools(cfg);
        return (await listCalls(marker)) >= 2;
      },
      2_000,
    );
  });
});

/**
 * Scope keying end-to-end: the stdio fixture cannot exercise it, because
 * `poolKey()` deliberately ignores the token for stdio (the child never sees
 * it). This hand-rolled streamable-HTTP fixture records the `Authorization`
 * header of every `tools/list` it serves — so "token rotation ⇒ cache miss"
 * (private) and "token rotation ⇒ shared hit" (public) are asserted on what
 * the server actually saw.
 */
describe('McpManager tool-list cache scope keying (HTTP fixture)', { concurrency: 1 }, () => {
  const managers: McpManager[] = [];
  const closers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(managers.map((m) => m.closeAll()));
    await Promise.all(closers.map((close) => close()));
  });

  /** Minimal stateless streamable-HTTP MCP server: JSON replies, no session
   *  ids — the same mode the SDK's stateless example (and our own loopback)
   *  uses. Requests with an id get a JSON-RPC result; notifications get 202. */
  async function httpFixture(list: {
    ttlMs: number;
    cacheScope: string;
  }): Promise<{ cfg: McpServerConfig; listAuths: string[] }> {
    const listAuths: string[] = [];
    const server = createServer((req, res) => {
      // POST-only, like the loopback server: the spec makes the standalone GET
      // SSE stream optional and blesses 405, and the SDK client tolerates it.
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const msg = JSON.parse(body) as {
          id?: number | string | null;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (msg.id === undefined || msg.id === null) {
          res.writeHead(202).end();
          return;
        }
        const reply = (result: unknown): void => {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') {
          reply({
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'http-fixture', version: '0.0.1' },
          });
          return;
        }
        if (msg.method === 'tools/list') {
          listAuths.push(String(req.headers.authorization ?? ''));
          reply({
            tools: [
              {
                name: 'ping',
                description: 'Replies with pong.',
                inputSchema: { type: 'object', properties: {}, required: [] },
              },
            ],
            ttlMs: list.ttlMs,
            cacheScope: list.cacheScope,
          });
          return;
        }
        reply({});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const { port } = server.address() as AddressInfo;
    const cfg: McpServerConfig = {
      id: `http-${port}`,
      name: `http-fixture-${port}`,
      transport: 'http',
      endpoint: `http://127.0.0.1:${port}/mcp`,
    };
    return { cfg, listAuths };
  }

  /** Hands out the given tokens in order; the last one repeats. */
  function authWithTokens(...values: readonly (string | null)[]): McpAuthProvider {
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

  function manager(auth: McpAuthProvider): McpManager {
    const m = new McpManager({ auth });
    managers.push(m);
    return m;
  }

  it('private scope: a rotated token is a new cache context — miss, then hit under the new token', async () => {
    const { cfg, listAuths } = await httpFixture({ ttlMs: 60_000, cacheScope: 'private' });
    const m = manager(authWithTokens('tok-a', 'tok-b'));
    await m.listTools(cfg); // tok-a → fetch
    await m.listTools(cfg); // tok-b → new pool key → fetch
    await m.listTools(cfg); // tok-b again → hit
    assert.deepEqual(listAuths, ['Bearer tok-a', 'Bearer tok-b']);
  });

  it('public scope: the list is shared across tokens under the bare server id', async () => {
    const { cfg, listAuths } = await httpFixture({ ttlMs: 60_000, cacheScope: 'public' });
    const m = manager(authWithTokens('tok-a', 'tok-b'));
    await m.listTools(cfg); // tok-a → fetch, filed under the server id
    await m.listTools(cfg); // tok-b → different pool key, same public entry → hit
    assert.deepEqual(listAuths, ['Bearer tok-a']);
  });

  it('a token-less caller’s private list is never shared with a tokened caller', async () => {
    // The token-less pool key IS the bare server id, so this private entry
    // lands in the same slot the public probe reads — it must stay invisible
    // there. (Regression: the probe used to accept it and served the anonymous
    // list to the tokened caller.)
    const { cfg, listAuths } = await httpFixture({ ttlMs: 60_000, cacheScope: 'private' });
    const m = manager(authWithTokens(null, 'tok-b'));
    await m.listTools(cfg); // no token → filed under the bare server id
    await m.listTools(cfg); // tok-b → other auth context → must hit the wire
    await m.listTools(cfg); // tok-b again → hit under its own pool key
    assert.deepEqual(listAuths, ['', 'Bearer tok-b']);
  });
});
