import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  McpManager,
  type McpCallLogEntry,
  type McpServerConfig,
} from '../packages/harness-orchestrator/src/mcp/mcpClient.js';
import { isSandboxListenDenied } from './_helpers/listenLoopback.js';

/**
 * ADR-0205 — what `McpManager.callTool` does when a request fails or runs long,
 * against a hand-rolled Streamable-HTTP server that sees every request:
 *
 *  - #1905: a failed request ends only itself; other callers' in-flight
 *    requests on the same pooled connection finish and are not re-sent.
 *  - #1919: every `tools/call` carries a progress token, and progress keeps a
 *    long tool alive past the idle timeout.
 *  - #1945: an HTTP 404 on a request that carried an `Mcp-Session-Id` starts a
 *    new session and sends the call once more.
 */

interface TestServer {
  readonly url: string;
  readonly calls: Array<{ tool: string; progressToken: unknown }>;
  readonly initializeCount: () => number;
  readonly writes: () => number;
  /** Forget every session, as a restarted server would. */
  readonly forgetSessions: () => void;
  readonly stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startServer(): Promise<TestServer> {
  const sessions = new Set<string>();
  const calls: Array<{ tool: string; progressToken: unknown }> = [];
  let initializes = 0;
  let writes = 0;
  const open = new Set<ServerResponse>();

  const json = (res: ServerResponse, status: number, body?: unknown, headers = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405);
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const message = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
    };
    const sid = req.headers['mcp-session-id'];
    if (message.method === 'initialize') {
      initializes += 1;
      const id = randomUUID();
      sessions.add(id);
      json(
        res,
        200,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'resend-policy', version: '1.0.0' },
          },
        },
        { 'mcp-session-id': id },
      );
      return;
    }
    if (typeof sid !== 'string' || !sessions.has(sid)) {
      json(res, 404, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32001, message: 'Session not found' },
      });
      return;
    }
    if (message.id === undefined) {
      json(res, 202);
      return;
    }
    if (message.method !== 'tools/call') {
      json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
      return;
    }
    const tool = String(message.params?.name);
    const args = message.params?.arguments ?? {};
    const progressToken = message.params?._meta?.['progressToken'];
    calls.push({ tool, progressToken });
    const result = (text: string): unknown => ({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text }] },
    });

    if (tool === 'progress_tool') {
      // Streams progress as SSE on the POST response, then the result.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      open.add(res);
      const steps = Number(args['steps']);
      for (let i = 1; i <= steps; i += 1) {
        await sleep(Number(args['stepMs']));
        if (progressToken === undefined) continue;
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: i, total: steps },
          })}\n\n`,
        );
      }
      res.write(`event: message\ndata: ${JSON.stringify(result('done'))}\n\n`);
      res.end();
      open.delete(res);
      return;
    }
    if (tool === 'write') writes += 1;
    open.add(res);
    await sleep(Number(args['waitMs'] ?? 0));
    open.delete(res);
    if (!res.writableEnded) json(res, 200, result(`${tool} ok`));
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
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
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    calls,
    initializeCount: () => initializes,
    writes: () => writes,
    forgetSessions: () => sessions.clear(),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function cfgFor(url: string): McpServerConfig {
  return {
    id: '00000000-0000-4000-8000-0000000c1905',
    name: 'resend-policy',
    transport: 'http',
    endpoint: url,
  };
}

function withEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

describe('MCP call re-send policy (ADR-0205)', () => {
  let server: TestServer | undefined;
  let manager: McpManager | undefined;
  const restores: Array<() => void> = [];

  afterEach(async () => {
    await manager?.closeAll();
    await server?.stop();
    for (const restore of restores.splice(0)) restore();
    manager = undefined;
    server = undefined;
  });

  async function start(t: { skip: (reason: string) => void }): Promise<TestServer | undefined> {
    try {
      server = await startServer();
      return server;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  it("#1905 — one caller's timeout does not interrupt or re-send another caller's write", async (t) => {
    const s = await start(t);
    if (!s) return;
    restores.push(withEnv('OMADIA_MCP_CALL_TIMEOUT_MS', '1000'));
    const audit: McpCallLogEntry[] = [];
    manager = new McpManager({ onToolCall: (e) => audit.push(e) });
    const cfg = cfgFor(s.url);

    // Both share the one token-less pooled connection.
    const slow = manager.callTool(cfg, 'slow', { waitMs: 3000 });
    await sleep(500);
    const write = manager.callTool(cfg, 'write', { waitMs: 700 });

    const [slowResult, writeResult] = await Promise.all([slow, write]);

    assert.match(slowResult, /^Error: outcome unknown/, 'the timed-out call is not re-sent');
    assert.equal(writeResult, 'write ok', "the neighbour's call finished normally");
    assert.equal(s.writes(), 1, 'the write reached the server exactly once');
    assert.equal(s.initializeCount(), 1, 'the shared connection was never torn down');
    assert.equal(s.calls.filter((c) => c.tool === 'slow').length, 1);
  });

  it('#1919 — every tools/call carries a progress token', async (t) => {
    const s = await start(t);
    if (!s) return;
    manager = new McpManager();

    await manager.callTool(cfgFor(s.url), 'write', {});

    assert.equal(s.calls.length, 1);
    assert.notEqual(s.calls[0]!.progressToken, undefined);
  });

  it('#1919 — progress keeps a long tool alive past the idle timeout, sent once', async (t) => {
    const s = await start(t);
    if (!s) return;
    restores.push(withEnv('OMADIA_MCP_CALL_TIMEOUT_MS', '600'));
    manager = new McpManager();

    // 6 × 250 ms = 1.5 s of work, more than twice the 600 ms idle budget.
    const result = await manager.callTool(cfgFor(s.url), 'progress_tool', {
      steps: 6,
      stepMs: 250,
    });

    assert.equal(result, 'done');
    assert.equal(s.calls.length, 1, 'a tool that reports progress is never re-sent');
  });

  it('#1945 — a lost session is re-established and the call sent once more', async (t) => {
    const s = await start(t);
    if (!s) return;
    const audit: McpCallLogEntry[] = [];
    manager = new McpManager({ onToolCall: (e) => audit.push(e) });
    const cfg = cfgFor(s.url);

    assert.equal(await manager.callTool(cfg, 'write', {}), 'write ok');
    s.forgetSessions();
    const second = await manager.callTool(cfg, 'write', {});

    assert.equal(second, 'write ok', 'the turn gets the tool result, not the 404');
    assert.equal(s.initializeCount(), 2, 'a new session was started');
    assert.equal(s.writes(), 2, 'the 404 never ran the tool, so it ran once per call');
    assert.deepEqual(
      audit.map((e) => e.outcome),
      ['ok', 'fail', 'ok'],
      'the refused attempt has its own audit row',
    );
    assert.match(audit[1]!.error ?? '', /session not found/);
  });
});
