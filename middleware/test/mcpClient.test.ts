import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  LoopbackMcpServer,
  McpManager,
  type McpServerConfig,
} from '@omadia/orchestrator';
import type { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';

/**
 * W0-5 — the first REAL `McpManager` → MCP-server round trip in the repo.
 *
 * Everything that existed before only ever exercised failure paths or stubs:
 * `mcpCallAudit.test.ts` dials 127.0.0.1:9 (connection refused, no handshake
 * possible), `mcpRescan.test.ts` stubs `listTools`, and the cliBridge tests stub
 * the loopback server. So no test ever proved the client can complete an
 * `initialize` → `tools/list` → `tools/call` sequence over the wire. Everything
 * later (including the eventual SDK v2 port) leans on this file.
 *
 * The tests below drive a live in-process `LoopbackMcpServer` — a real
 * Streamable-HTTP MCP server — sometimes through a thin recording proxy that can
 * inject one transport-level failure so the retry/pool behaviour is observable
 * instead of inferred.
 */

const BEARER = 'loopback-secret-token';
const TOOL = 'ping';

function serverConfig(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: '00000000-0000-4000-8000-00000000c0de',
    name: 'loopback',
    transport: 'http',
    endpoint: url,
    ...overrides,
  };
}

function fakeDispatch(seen: Array<{ name: string; input: unknown }>): ToolDispatchService {
  return {
    async dispatch(name: string, input: unknown) {
      seen.push({ name, input });
      return { content: `dispatch:${name}:${JSON.stringify(input)}` };
    },
  } as unknown as ToolDispatchService;
}

function isSandboxListenError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as { code?: string }).code === 'EPERM'
  );
}

/** Count how many times the manager dropped a pooled connection. `close` is the
 *  single invalidation point (connect failure, call failure, stale token). */
function recordPoolInvalidations(manager: McpManager): () => readonly string[] {
  const closed: string[] = [];
  const original = manager.close.bind(manager);
  manager.close = async (id: string): Promise<void> => {
    closed.push(id);
    await original(id);
  };
  return () => closed;
}

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

function forwardableHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

interface RecordingProxy {
  readonly url: string;
  readonly postCount: () => number;
  readonly toolCallCount: () => number;
  readonly stop: () => Promise<void>;
}

/**
 * Transparent HTTP proxy in front of the real MCP server(s). Records POSTs (so a
 * doomed extra attempt is countable) and can answer the FIRST `tools/call` with
 * a JSON-RPC transport error, which is the only way to observe the deliberate
 * once-retry without stubbing the client.
 *
 * `targets` may hold more than one upstream: after the injected failure the
 * proxy advances to the next one. The retry legitimately reconnects (the manager
 * drops the pooled connection first), and a `LoopbackMcpServer` holds exactly
 * one Streamable-HTTP session — a second `initialize` against the same instance
 * is rejected with "Server already initialized". Two instances model the hosted
 * proxy this mitigation exists for, where the reconnect lands on a healthy node.
 */
async function startRecordingProxy(
  targets: readonly string[],
  options: { failFirstToolCall?: boolean } = {},
): Promise<RecordingProxy> {
  let posts = 0;
  let toolCalls = 0;
  let targetIdx = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    const body = Buffer.concat(chunks);
    if (req.method === 'POST') {
      posts += 1;
      const text = body.toString('utf8');
      if (text.includes('"tools/call"')) {
        toolCalls += 1;
        if (options.failFirstToolCall === true && toolCalls === 1) {
          const id = (JSON.parse(text) as { id?: unknown }).id ?? null;
          targetIdx = Math.min(targetIdx + 1, targets.length - 1);
          res.writeHead(200, { 'content-type': 'application/json' });
          // -32000 "Connection closed" is what a flaky hosted proxy actually
          // returns; `looksTransient` must classify it as retry-worthy.
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'Connection closed' },
            }),
          );
          return;
        }
      }
    }

    const upstream = await fetch(targets[targetIdx] ?? targets[0]!, {
      method: req.method ?? 'GET',
      headers: forwardableHeaders(req.headers),
      ...(body.length > 0 ? { body } : {}),
    });
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        res.write(Buffer.from(chunk as Uint8Array));
      }
    }
    res.end();
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    postCount: () => posts,
    toolCallCount: () => toolCalls,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('McpManager against a live MCP server (W0-5)', () => {
  const servers: LoopbackMcpServer[] = [];
  let proxy: RecordingProxy | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    await manager?.closeAll();
    await proxy?.stop();
    for (const s of servers.splice(0)) await s.stop();
    manager = undefined;
    proxy = undefined;
  });

  async function startServer(
    t: { skip: (reason: string) => void },
    seen: Array<{ name: string; input: unknown }> = [],
  ): Promise<string | undefined> {
    const server = new LoopbackMcpServer({
      dispatch: fakeDispatch(seen),
      bearer: BEARER,
      tools: [
        {
          name: TOOL,
          description: 'echo the input back',
          input_schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
      ],
    });
    try {
      const handle = await server.start();
      servers.push(server);
      return handle.url;
    } catch (error) {
      if (isSandboxListenError(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  it('completes listTools AND callTool over the wire', async (t) => {
    const seen: Array<{ name: string; input: unknown }> = [];
    const url = await startServer(t, seen);
    if (!url) return;

    manager = new McpManager();
    const cfg = serverConfig(url, { headers: { Authorization: `Bearer ${BEARER}` } });

    const tools = await manager.listTools(cfg);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, TOOL);
    assert.equal(tools[0]?.description, 'echo the input back');
    assert.equal(tools[0]?.inputSchema?.['type'], 'object');

    const result = await manager.callTool(cfg, TOOL, { value: 'hello' });
    assert.equal(result, 'dispatch:ping:{"value":"hello"}');
    assert.deepEqual(seen, [{ name: TOOL, input: { value: 'hello' } }]);

    // A second call must reuse the pooled connection, not reconnect.
    const again = await manager.callTool(cfg, TOOL, { value: 'again' });
    assert.equal(again, 'dispatch:ping:{"value":"again"}');
  });

  it('audits a successful call as ok (the audit path had no success coverage)', async (t) => {
    const url = await startServer(t);
    if (!url) return;

    const entries: Array<{ ok: boolean; toolName: string; error: string | null }> = [];
    manager = new McpManager({
      onToolCall: (e) => entries.push({ ok: e.ok, toolName: e.toolName, error: e.error }),
    });
    const cfg = serverConfig(url, { headers: { Authorization: `Bearer ${BEARER}` } });

    await manager.callTool(cfg, TOOL, {});
    assert.deepEqual(entries, [{ ok: true, toolName: TOOL, error: null }]);
  });

  it('surfaces a genuine Unauthorized immediately — no retry, one pool invalidation', async (t) => {
    const url = await startServer(t);
    if (!url) return;
    proxy = await startRecordingProxy([url]);

    // The loopback server answers a bad bearer with JSON-RPC code -32001, which
    // `looksTransient` used to match as a bare number — so a real auth failure
    // got one doomed retry before the user saw the authorize prompt.
    manager = new McpManager({
      auth: {
        getToken: async () => 'stale-token',
        onAuthFailure: async () => '🔒 authorize here: https://auth.example/authorize',
      },
    });
    const closed = recordPoolInvalidations(manager);

    const result = await manager.callTool(serverConfig(proxy.url), TOOL, {});

    assert.match(result, /authorize here/);
    assert.equal(
      proxy.postCount(),
      1,
      'an Unauthorized must not be retried — a second POST means -32001 is still classified transient',
    );
    assert.equal(
      closed().length,
      1,
      'the stale-token connection must be invalidated exactly once (handleFailure), not twice',
    );
  });

  it('retries a genuinely transient failure exactly once, then succeeds', async (t) => {
    const seen: Array<{ name: string; input: unknown }> = [];
    const first = await startServer(t, seen);
    if (!first) return;
    const second = await startServer(t, seen);
    if (!second) return;
    proxy = await startRecordingProxy([first, second], { failFirstToolCall: true });

    manager = new McpManager();
    const closed = recordPoolInvalidations(manager);
    const cfg = serverConfig(proxy.url, {
      headers: { Authorization: `Bearer ${BEARER}` },
    });

    const result = await manager.callTool(cfg, TOOL, { value: 'retry-me' });

    // The shipped once-retry mitigation (flaky hosted proxy) must stay: the
    // first tools/call fails transiently, the second one succeeds.
    assert.equal(result, 'dispatch:ping:{"value":"retry-me"}');
    assert.equal(proxy.toolCallCount(), 2, 'exactly one retry — no more, no fewer');
    assert.equal(
      closed().length,
      1,
      'the retry must drop the pooled connection once so it reconnects fresh',
    );
    assert.deepEqual(seen, [{ name: TOOL, input: { value: 'retry-me' } }]);
  });

  it('a stale token invalidates the pool and the next call reconnects and succeeds', async (t) => {
    const url = await startServer(t);
    if (!url) return;

    const tokens = ['stale-token', BEARER];
    manager = new McpManager({
      auth: {
        getToken: async () => tokens.shift() ?? BEARER,
        // Not an OAuth-protected server: the raw failure must stand so the
        // pooling behaviour is what the assertions observe.
        onAuthFailure: async () => null,
      },
    });
    const closed = recordPoolInvalidations(manager);

    const failed = await manager.callTool(serverConfig(url), TOOL, {});
    assert.match(failed, /^Error: could not connect to MCP server "loopback"/);
    assert.equal(closed().length, 1, 'the rejected token must be evicted from the pool');

    // Same server, fresh (valid) token — a reconnect must happen and succeed.
    const recovered = await manager.callTool(serverConfig(url), TOOL, { value: 'after-refresh' });
    assert.equal(recovered, 'dispatch:ping:{"value":"after-refresh"}');
    assert.equal(
      closed().length,
      1,
      'a successful reconnect must not invalidate anything further',
    );
  });
});
