/**
 * M1 library code for #309 Shape-3 OpenClaw.
 *
 * This loopback Streamable-HTTP MCP server binds to 127.0.0.1 on an ephemeral
 * port, enforces a bearer token, and relies entirely on injected dependencies
 * with no global state. It lives in the orchestrator package because it uses
 * the dispatch service and the MCP SDK this package already depends on.
 */

import { randomUUID } from 'node:crypto';
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

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

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
  private transport?: StreamableHTTPServerTransport;
  private mcp?: McpServer;
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

    this.mcp = new McpServer(
      {
        name: this.deps.serverName ?? 'omadia-loopback',
        version: this.deps.serverVersion ?? '0.0.0',
      },
      { capabilities: { tools: {} } },
    );

    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.deps.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
      })),
    }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await this.deps.dispatch.dispatch(name, args ?? {});
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    // Stateless-ish loopback transport; JSON responses simplify the client and
    // session IDs remain required by the protocol.
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await this.mcp.connect(this.transport);

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

    await this.mcp?.close().catch(() => {});
    await this.transport?.close().catch(() => {});

    if (this.http) {
      await new Promise<void>((resolve) => {
        this.http?.close(() => resolve());
      });
    }

    this.http = undefined;
    this.transport = undefined;
    this.mcp = undefined;
    this.started = false;
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

    try {
      const transport = this.transport;
      if (!transport) {
        throw new McpError(ErrorCode.InternalError, 'Transport not started');
      }

      if (req.method === 'POST') {
        const rawBody = await this.readBody(req);
        const parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      await transport.handleRequest(req, res);
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
    }
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
