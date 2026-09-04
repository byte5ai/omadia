/**
 * M1 library code for #309 Shape-3 OpenClaw.
 *
 * This loopback Streamable-HTTP MCP server binds to 127.0.0.1 on an ephemeral
 * port, enforces a bearer token, and relies entirely on injected dependencies
 * with no global state. It lives in the orchestrator package because it uses
 * the dispatch service and the MCP SDK this package already depends on.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
// #562 Phase 1 — this surface is served by the `@modelcontextprotocol/*@2`
// family. `createMcpHandler` IS the per-request-instance model this file used
// to hand-roll (see `handleHttp`), and `toNodeHandler` bridges its
// web-standard `fetch` back to the Node `(req, res)` this server speaks.
//
// The v1 SDK stays a dependency of this package: the MCP *client*
// (`mcp/mcpClient.ts`) is deliberately NOT ported in this phase, because v2
// changes how `input_required` (MRTR, #544/#570) travels on a 2025-era
// connection. See the #562 issue thread.
import { createMcpHandler, McpServer, type Tool } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

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

/** #1015 — upper bound on `stop()`, so teardown can never hang a turn. */
const STOP_TIMEOUT_MS = 2_000;

class PayloadTooLargeError extends Error {}

export interface LoopbackMcpServerDeps {
  readonly dispatch: ToolDispatchService;
  readonly bearer: string;
  readonly tools: readonly DispatchableToolSpec[];
  readonly serverName?: string;
  readonly serverVersion?: string;
  /**
   * The turn's async context, captured by the caller at its public entry
   * point (#1016). Preferred over the construction-time snapshot below,
   * because this server is built inside an async generator whose body runs at
   * first iteration rather than at call time.
   */
  readonly runInTurnContext?: <T>(fn: () => T) => T;
  /**
   * Throws when the restored context does not belong to this turn (#1016).
   * Runs inside the restored context, immediately before dispatch.
   */
  readonly assertTurnOwner?: () => void;
}

export interface LoopbackMcpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly bearer: string;
}

export class LoopbackMcpServer {
  private http?: HttpServer;
  private started = false;
  /** #562 — the long-lived serving entry; see `nodeHandler()`. */
  private handler?: ReturnType<typeof toNodeHandler>;

  /**
   * OM-82 (#993) — the async context this server was CONSTRUCTED in.
   *
   * On the subscription path a tool call arrives as an HTTP request from the
   * external `claude` process, so the `tools/call` handler runs in a fresh
   * async root with none of the AsyncLocalStorage values the caller had set
   * around `chat()`. That is why `manage_routine` answered "no user context"
   * to a user who was in a channel. The server is constructed inside the turn
   * (see `cliChatAgent.runLifecycle`), so we snapshot the context here and run
   * every dispatch inside it.
   *
   * The snapshot restores whatever stores are active where it was taken: on
   * the CLI path today that is `routineTurnContext` (entered by the channel
   * adapter around `chat()`); the orchestrator's own `turnContext` is NOT set
   * on this path, because the CLI owns the loop. Any store a caller enters in
   * the future is carried automatically. `AsyncLocalStorage.snapshot()` needs
   * Node >= 20; this package requires >= 20.
   *
   * #1016 — prefer `deps.runInTurnContext`, captured by the caller at its
   * public entry point. Constructing this server happens inside an async
   * generator, whose body runs at first iteration rather than at call time, so
   * a snapshot taken here can belong to whoever iterated. The
   * construction-time snapshot remains the fallback for callers that pass
   * nothing.
   *
   * Restoring a context is not the same as trusting it: `routineTurnContext`
   * is entered with `enterWith`, which has no scope exit, so a stale async
   * chain can still carry an older turn's value. `deps.assertTurnOwner` is the
   * hook that turns that back into a refusal. It cannot DEFAULT to anything
   * here, because the store it reads lives in the application layer, so the
   * kernel publishes the implementation (`createRoutineTurnOwnerGuard`, service
   * `routineTurnOwnerGuard`) and `buildOrchestratorForAgent` forwards it into
   * `CliChatAgent`. Absent — a host that publishes no such service, or a unit
   * test — the context is restored without a cross-check.
   */
  private readonly runInTurnContext: <T>(fn: () => T) => T;

  /**
   * The tool names this server advertises, as a set (#1015).
   *
   * `tools/call` used to dispatch any name the client sent. That is a wider
   * set than what is advertised: `toolDispatchService` keeps handler-only
   * registrations dispatchable but unadvertised, and filters out tools whose
   * plugin failed the readiness gate. `dispatch` fails closed on a genuinely
   * unknown name, so the exposure was bounded to real omadia tools
   * deliberately kept off the wire — but `--allowedTools mcp__omadia__*`
   * pre-approves the entire namespace, which makes this handler the only
   * enforcement point there is.
   */
  private readonly advertisedToolNames: ReadonlySet<string>;

  constructor(private readonly deps: LoopbackMcpServerDeps) {
    if (!deps.bearer) {
      throw new Error(
        'LoopbackMcpServer: bearer must be a non-empty string',
      );
    }
    this.runInTurnContext = deps.runInTurnContext ?? AsyncLocalStorage.snapshot();
    this.advertisedToolNames = new Set(deps.tools.map((tool) => tool.name));
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

  /**
   * Stop listening, and do it in bounded time (#1015).
   *
   * `close()` alone resolves only once every live connection has ended. The
   * CLI child keeps a keep-alive socket to this server, so on an abort or
   * timeout path — where the child may still be running — awaiting `close()`
   * could block indefinitely, and the caller's kill escalation never ran.
   * `closeAllConnections()` drops those sockets first, and the race is the
   * backstop for anything `close()` still fails to settle.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    const http = this.http;
    if (http) {
      http.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolve) => {
          http.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    }

    this.http = undefined;
    this.started = false;
  }

  /**
   * Builds a fresh MCP server for a single HTTP request.
   *
   * #562 — the per-request lifetime is unchanged, but it is now the SERVING
   * ENTRY's model rather than something this file arranges. `createMcpHandler`
   * calls this factory once per request and owns the transport, so the
   * hand-rolled "build a stateless transport, connect, handle, tear down" dance
   * is gone along with the constraint that produced it (v1 threw "Stateless
   * transport cannot be reused across requests" on second use, which is why the
   * pair had to be per-request in the first place).
   *
   * Statelessness is preserved and is still the point: no session id is issued
   * and none is validated, so a client may skip `initialize` and never send
   * `Mcp-Session-Id`. Cost stays negligible — a pure in-memory handler table,
   * no I/O, a handful of requests per CLI turn. Nothing here held cross-request
   * state worth keeping: the tool list and dispatch service are owned by
   * `deps`, and the bearer token is what actually scopes access.
   */
  private createRequestScopedServer(): McpServer {
    const mcp = new McpServer(
      {
        name: this.deps.serverName ?? 'omadia-loopback',
        version: this.deps.serverVersion ?? '0.0.0',
      },
      { capabilities: { tools: {} } },
    );

    // #562 — v2 keys handlers on the method string instead of a Zod schema,
    // and they hang off `.server`. Same two methods, same shapes on the wire.
    //
    // W0-3 — advertise name-sorted. `ToolDispatchService` already sorts, but
    // `deps.tools` is caller-supplied, so sorting here makes the wire order a
    // property of this server rather than a convention every caller must know.
    mcp.server.setRequestHandler('tools/list', async () => ({
      tools: sortByToolName(this.deps.tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        // `input_schema` is a JSON Schema object whose `properties` we model as
        // `Record<string, unknown>`; v2 types the field as a concrete JSON
        // value. The runtime value is the same object v1 put on the wire — the
        // cast asserts what TypeScript cannot prove about caller-supplied JSON,
        // and nothing here reshapes it.
        inputSchema: tool.input_schema as unknown as Tool['inputSchema'],
      })),
      // #545 — MCP 2026-07-28 `CacheableResult`. Both fields are honest by
      // construction: `deps.tools` is readonly and this server lives exactly
      // one turn, so the list cannot change while anyone holds it (`ttlMs` can
      // afford to be generous), and it is identical for every caller — there
      // is one bearer and no per-principal filtering (`public`).
      ttlMs: LOOPBACK_TOOLLIST_TTL_MS,
      cacheScope: 'public',
    }));

    mcp.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      // #1015 — only what this server advertised. Anything else is refused
      // here, because the pre-approval the CLI runs with covers the whole
      // `mcp__omadia__*` namespace and cannot tell an advertised tool from an
      // unadvertised one.
      if (!this.advertisedToolNames.has(name)) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `LoopbackMcpServer: tool "${name}" is not advertised by this server`,
        );
      }

      // OM-82 (#993) — run the dispatch inside the turn's captured async
      // context so context-bound tools (`manage_routine`) see the same
      // (tenant, user) the in-process path would. #1016 — and refuse when that
      // context does not belong to this turn, so a stale chain fails closed
      // instead of acting as the previous principal.
      const result = await this.runInTurnContext(() => {
        this.deps.assertTurnOwner?.();
        return this.deps.dispatch.dispatch(name, args ?? {});
      });
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    return mcp;
  }

  /**
   * The web-standard MCP handler, adapted to Node.
   *
   * Built lazily and then reused: `createMcpHandler` is the long-lived object
   * (it instantiates a server PER REQUEST via the factory above), so rebuilding
   * it per request would defeat its own model. `toNodeHandler` converts the
   * Node request, calls `fetch`, and writes the `Response` back to `res`.
   */
  private nodeHandler(): ReturnType<typeof toNodeHandler> {
    this.handler ??= toNodeHandler(
      createMcpHandler(() => this.createRequestScopedServer()),
    );
    return this.handler;
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

    // Read the body BEFORE handing off so an oversized POST still fails with
    // 413 without paying for the handler wiring. The parsed value is passed
    // through, so the adapter does not re-read a stream we already consumed.
    try {
      const parsedBody = await this.parsePostBody(req);
      await this.nodeHandler()(req, res, parsedBody);
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
    // #562 — no `finally` teardown any more. The per-request server and its
    // transport are created and disposed by `createMcpHandler`; the old block
    // existed only to dodge v1's single-use stateless transport.
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
