/**
 * M1 library code for #309 Shape-3 OpenClaw.
 *
 * This loopback Streamable-HTTP MCP server binds to 127.0.0.1 on an ephemeral
 * port, enforces a bearer token, and relies entirely on injected dependencies
 * with no global state. It lives in the orchestrator package because it uses
 * the dispatch service and the MCP SDK this package already depends on.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import type {
  DispatchableToolSpec,
  ToolDispatchService,
} from './toolDispatchService.js';
import { sortByToolName } from './toolOrdering.js';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** #545 — `ttlMs` advertised on `tools/list` (5 minutes). Any value is true
 *  for as long as this per-turn server exists; 5 minutes comfortably covers a
 *  turn without pretending the list is immortal across turns. */
const LOOPBACK_TOOLLIST_TTL_MS = 300_000;

class PayloadTooLargeError extends Error {}

export interface LoopbackMcpServerDeps {
  readonly dispatch: ToolDispatchService;
  readonly bearer: string;
  readonly tools: readonly DispatchableToolSpec[];
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export interface LoopbackMcpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly bearer: string;
}

export class LoopbackMcpServer {
  private http?: HttpServer;
  private started = false;

  constructor(private readonly deps: LoopbackMcpServerDeps) {
    if (!deps.bearer) {
      throw new Error(
        'LoopbackMcpServer: bearer must be a non-empty string',
      );
    }
  }

  async start(): Promise<LoopbackMcpServerHandle> {
    if (this.started) {
      // Throwing makes double-start a visible lifecycle bug instead of silently
      // reusing stale transport state.
      throw new Error('LoopbackMcpServer: already started');
    }

    this.http = createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const http = this.http;
      if (!http) {
        reject(new Error('LoopbackMcpServer: HTTP server missing'));
        return;
      }
      http.once('error', reject);
      // The listen callback bounds readiness and gives us the ephemeral port.
      // Security note (P2-4): this binds 127.0.0.1 on an ephemeral port and is
      // bearer-gated, so any local process that can read the 0600 mcp-config
      // bearer can call omadia's tools — a local-process trust boundary.
      http.listen(0, '127.0.0.1', () => {
        http.removeListener('error', reject);
        resolve();
      });
    });

    const address = this.http.address() as AddressInfo;
    const port = address.port;
    const url = `http://127.0.0.1:${port}/mcp`;
    this.started = true;
    return { url, port, bearer: this.deps.bearer };
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.http) {
      await new Promise<void>((resolve) => {
        this.http?.close(() => resolve());
      });
    }

    this.http = undefined;
    this.started = false;
  }

  /**
   * Builds a fresh MCP server + transport pair for a single HTTP request.
   *
   * W1-2 — `sessionIdGenerator: undefined` selects the SDK's stateless mode:
   * no session id is issued and no session validation happens, so a client may
   * skip the `initialize` handshake and never send `Mcp-Session-Id`. The SDK
   * enforces the other half of that contract — a stateless transport throws
   * "Stateless transport cannot be reused across requests" on its second use —
   * so the transport (and the `Server` bound to it) is per-request by
   * construction, matching the SDK's own stateless example.
   *
   * Cost is negligible: both objects are pure in-memory handler tables with no
   * I/O, and this server sees a handful of requests per CLI turn. Nothing here
   * held cross-request state worth keeping — the tool list and the dispatch
   * service are owned by `deps`, and the bearer token is what actually scopes
   * access. `enableJsonResponse` stays on: JSON replies keep the client simple
   * and also guarantee the response is fully written by the time
   * `handleRequest` resolves, which is what makes per-request teardown safe.
   */
  private createRequestScopedServer(): {
    mcp: McpServer;
    transport: StreamableHTTPServerTransport;
  } {
    const mcp = new McpServer(
      {
        name: this.deps.serverName ?? 'omadia-loopback',
        version: this.deps.serverVersion ?? '0.0.0',
      },
      { capabilities: { tools: {} } },
    );

    // W0-3 — advertise name-sorted. `ToolDispatchService` already sorts, but
    // `deps.tools` is caller-supplied, so sorting here makes the wire order a
    // property of this server rather than a convention every caller must know.
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: sortByToolName(this.deps.tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
      })),
      // #545 — MCP 2026-07-28 `CacheableResult`. Both fields are honest by
      // construction: `deps.tools` is readonly and this server lives exactly
      // one turn, so the list cannot change while anyone holds it (`ttlMs` can
      // afford to be generous), and it is identical for every caller — there
      // is one bearer and no per-principal filtering (`public`).
      ttlMs: LOOPBACK_TOOLLIST_TTL_MS,
      cacheScope: 'public',
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await this.deps.dispatch.dispatch(name, args ?? {});
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    return { mcp, transport };
  }

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const authorization = req.headers.authorization;
    const expected = `Bearer ${this.deps.bearer}`;

    // Single enforcement point for loopback auth. If tokens ever become
    // per-tool/per-call, request-level McpError handling is an M2 seam.
    if (
      typeof authorization !== 'string' ||
      !this.constantTimeEquals(authorization, expected)
    ) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        }),
      );
      return;
    }

    if (!this.started) {
      throw new McpError(ErrorCode.InternalError, 'Transport not started');
    }

    // W1-2 — POST only. The MCP spec makes the GET standalone SSE stream
    // optional and blesses 405 when a server does not offer one, and this
    // server has nothing to deliver over it: `enableJsonResponse` answers every
    // request inline and there are no server-initiated notifications.
    //
    // Declining it explicitly also avoids a leak introduced by the per-request
    // transport: a GET opens a stream that never ends, so `handleRequest` never
    // resolves, so the `finally` below never runs and the request-scoped
    // server/transport pair stays alive until the client disconnects. Under the
    // old stateful transport a session-less GET was simply rejected with 400,
    // so nothing regresses here.
    if (req.method !== 'POST') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        Allow: 'POST',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method Not Allowed' },
          id: null,
        }),
      );
      return;
    }

    // Read the body BEFORE building the per-request server so an oversized
    // POST still fails with 413 without paying for the handler wiring.
    let session: ReturnType<typeof this.createRequestScopedServer> | undefined;
    try {
      const parsedBody = await this.parsePostBody(req);

      session = this.createRequestScopedServer();
      await session.mcp.connect(session.transport);
      await session.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }

      if (error instanceof PayloadTooLargeError) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: 413, message: 'Payload Too Large' },
            id: null,
          }),
        );
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Internal server error';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message },
          id: null,
        }),
      );
    } finally {
      // A stateless transport is single-use; dropping it here is what keeps
      // the next request from hitting the SDK's reuse guard. Safe at this
      // point because `enableJsonResponse` means the response is already
      // fully written when `handleRequest` resolves.
      await session?.transport.close().catch(() => {});
      await session?.mcp.close().catch(() => {});
    }
  }

  /** Reads and JSON-parses a POST body, or `undefined` when the body is empty. */
  private async parsePostBody(req: IncomingMessage): Promise<unknown> {
    const rawBody = await this.readBody(req);
    return rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buffer.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        throw new PayloadTooLargeError('Payload Too Large');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private constantTimeEquals(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }

    let diff = 0;
    for (let index = 0; index < left.length; index += 1) {
      diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return diff === 0;
  }
}
