/**
 * W2-3 (issue #542) — the public, stateless, API-key-authenticated MCP server.
 *
 * ─── Why this is a new class and not a flag on `LoopbackMcpServer` ───────────
 *
 * `LoopbackMcpServer` binds `127.0.0.1` on an ephemeral port and authenticates
 * ONE static bearer with a constant-time compare. Its own security note states
 * the trust boundary it was designed for: "any local process that can read the
 * 0600 mcp-config bearer can call omadia's tools — a local-process trust
 * boundary." Not one clause of that transfers to an internet-facing route.
 * There is no single bearer, no local-process assumption, no "the token is the
 * whole authorization", and no acceptable version of "sees the FULL native tool
 * registry" (which is what the loopback path documents itself as doing). A flag
 * would leave both behaviors in one class where the dangerous default is one
 * boolean away from every caller.
 *
 * What IS shared is the stateless-transport lifecycle, and that part is copied
 * deliberately rather than reinvented — see `createRequestScopedServer`.
 *
 * ─── The authorization model ────────────────────────────────────────────────
 *
 * Four independent gates, all default-deny, in this order:
 *
 *  1. AUTHENTICATION — `requireApiKey` (mounted by the router, not here) does
 *     the constant-time hash compare and answers 401. It deliberately does not
 *     populate `req.session`; that is preserved, and nothing here reads it.
 *  2. BINDING — the key must have an enabled `public_mcp_key_bindings` row.
 *     No row ⇒ zero tools. The row names ONE agent, which is what makes key A
 *     unable to reach agent B's tools even though the native tool registry is
 *     process-wide.
 *  3. ALLOWLIST — the tool must be named in that row. Enforced on `tools/call`
 *     AND on `tools/list`, because a tool name the key cannot call is itself a
 *     disclosure (it tells a third party which integrations this install runs).
 *  4. SCOPE — `mcp:list` to enumerate, `mcp:invoke` to call, and additionally
 *     the exact `mcp:write:<tool>` for anything the row lists as a write.
 *     `WILDCARD_SCOPE` does not satisfy a write scope; `hasScope` enforces that
 *     for every caller.
 *
 * `tools/list` returns exactly the set the key could successfully CALL — not
 * "everything it may see". A key holding `mcp:list` but not `mcp:invoke` gets
 * an empty list, and a write tool appears only when its per-tool write scope is
 * present. Any looser rule turns the list into an inventory of what to attack.
 */

import type { Request, RequestHandler, Response } from 'express';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import type { ApiKeyPrincipal, ApiKeyScope, RateLimiter } from '@omadia/api-key-auth';
import { hasScope, hasWriteScope, MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import type { DispatchableToolSpec, ToolDispatchResult } from '@omadia/orchestrator';

import type { PublicMcpKeyBinding, PublicMcpKeyBindingStore } from './publicMcpKeyBindings.js';

/** Mirrors `LoopbackMcpServer`'s ceiling. See `enforceBodyCap` for why it is
 *  re-checked here instead of being handed to `express.json`. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Per-tool wall clock. A public caller must not be able to pin a dispatch
 *  slot open indefinitely; without this, `maxConcurrentCalls` below is a
 *  denial-of-service budget rather than a protection. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Process-wide ceiling on tool calls in flight from this endpoint. Tools reach
 *  Odoo/M365/Confluence and the LLM providers; an unbounded public fan-in
 *  starves the operator-facing chat path that shares those pools. */
export const DEFAULT_MAX_CONCURRENT_CALLS = 4;

/**
 * The subset of `ToolDispatchService` this server uses.
 *
 * Structural rather than the concrete class so the wiring can supply a
 * per-agent dispatcher without this module importing the orchestrator's
 * construction path — and so tests exercise the real gates against a fake
 * dispatcher instead of a whole orchestrator.
 */
export interface PublicMcpDispatcher {
  dispatch(name: string, input: unknown): Promise<ToolDispatchResult>;
  listDispatchableToolSpecs(): readonly DispatchableToolSpec[];
}

/**
 * WHO is calling — assembled here and handed to dispatch.
 *
 * ─── WHERE THIS BRANCH MEETS `feat/w3-b-dispatch-privacy-seam-and-idempotency`
 *
 * `ToolDispatchService.dispatch(name, input)` today carries no tenant, no user
 * and no principal, and its trailing SEAM comment records that privacy
 * interning and trace capture are NOT replicated versus
 * `Orchestrator.dispatchToolInner`. The sibling unit closes that seam and adds
 * an optional caller-context parameter. This type is the shape this endpoint
 * offers it; `PublicMcpServerDeps.dispatchWithContext` is the single injection
 * point where the two branches join. Nothing in `toolDispatchService.ts` is
 * touched by this branch.
 */
export interface PublicMcpCallerContext {
  /** Stable id of the API key. Becomes `apikey:<keyId>` in the audit trail. */
  readonly keyId: string;
  readonly label?: string;
  readonly scopes: readonly ApiKeyScope[];
  /** The agent whose tools this call runs against. */
  readonly agentId: string;
  /** True when the tool is declared write-capable by the key's binding. */
  readonly write: boolean;
}

/** One audit row per call, written by the wiring. Mirrors the vocabulary the
 *  base branch established on `mcp_call_log` (`actingIdentity`, with the
 *  literal `unresolved` for an identity that could not be established). */
export interface PublicMcpAuditEntry {
  readonly keyId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly durationMs: number;
  readonly calledAt: Date;
  readonly actingIdentity: string;
  readonly write: boolean;
}

/** Fire-and-forget. Implementations MUST NOT throw — an audit failure must
 *  never fail a caller's request, and must never be the reason a call
 *  succeeds either. */
export type PublicMcpAuditSink = (entry: PublicMcpAuditEntry) => void;

export interface PublicMcpServerDeps {
  /**
   * Resolves the dispatcher for ONE agent. `undefined` when that agent is not
   * currently active — which fails the call closed rather than falling back to
   * any other agent's dispatcher.
   */
  readonly resolveDispatcher: (agentId: string) => PublicMcpDispatcher | undefined;
  readonly bindings: PublicMcpKeyBindingStore;
  /**
   * Budget for WRITES only, separate from the general per-key limiter
   * `requireApiKey` already applies. Two limiter instances, not one shared
   * bucket: reads are cheap and idempotent, writes are neither, and a
   * read-heavy integration's unused read headroom must not fund a write burst.
   */
  readonly writeRateLimiter: RateLimiter;
  readonly audit?: PublicMcpAuditSink;
  /**
   * Where the sibling privacy-seam branch plugs in. When present, EVERY tool
   * call goes through it instead of calling `dispatch` directly.
   */
  readonly dispatchWithContext?: (
    dispatcher: PublicMcpDispatcher,
    name: string,
    input: unknown,
    caller: PublicMcpCallerContext,
  ) => Promise<ToolDispatchResult>;
  /**
   * Whether a call is refused when `dispatchWithContext` is absent.
   *
   * DEFAULTS TO TRUE, i.e. the endpoint refuses to serve tool calls until the
   * privacy/trace seam is closed. `ToolDispatchService` applies no PII masking
   * — the chat path's masking lives in `Orchestrator.dispatchToolInner`, which
   * this dispatcher explicitly does not replicate — so serving without the
   * seam means a public HTTP response can carry unmasked personal data straight
   * out of Odoo or M365. That is not a trade to make silently, so the default
   * is to fail closed and say why. Set false ONLY with a deliberate,
   * documented operator decision.
   */
  readonly requirePrivacySeam?: boolean;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly toolTimeoutMs?: number;
  readonly maxConcurrentCalls?: number;
}

/** Deliberately identical for "no such tool" and "not allowlisted for this
 *  key". Distinguishing them would confirm a tool's existence to a caller not
 *  entitled to know, which is the same disclosure `tools/list` filtering
 *  exists to prevent. */
function unavailableToolMessage(name: string): string {
  return `Tool \`${name}\` is not available to this API key.`;
}

export class PublicMcpServer {
  private inFlight = 0;

  constructor(private readonly deps: PublicMcpServerDeps) {}

  private get toolTimeoutMs(): number {
    return this.deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  private get maxConcurrentCalls(): number {
    return this.deps.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS;
  }

  private get privacySeamRequired(): boolean {
    return this.deps.requirePrivacySeam ?? true;
  }

  /**
   * Enforces the 8 MB ceiling.
   *
   * NOT `express.json({ limit })`. The kernel mounts a global
   * `express.json({ limit: '10mb' })` before every `/api` router (index.ts), so
   * by the time a request reaches this one the stream is already consumed and
   * parsed: a route-level parser would be a silent no-op and the loopback
   * server's 8 MB ceiling would quietly become the kernel's 10 MB one. So the
   * check runs on the two signals still available after parsing —
   * `Content-Length` (the only pre-parse number, sent by any well-behaved
   * client) and the re-serialized body length (which covers a chunked upload
   * that carries no `Content-Length` at all).
   *
   * Mounting this router BEFORE `express.json` would allow a real streaming
   * cap, but would also put it in front of the `/api` requireAuth mount and
   * throw away the `publicPaths` half of the defense this route is required to
   * use. The cap is the cheaper thing to reimplement.
   */
  bodyCapMiddleware(): RequestHandler {
    return (req: Request, res: Response, next): void => {
      const declared = Number(req.headers['content-length']);
      const declaredTooLarge = Number.isFinite(declared) && declared > MAX_REQUEST_BYTES;
      const actualTooLarge =
        req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8') > MAX_REQUEST_BYTES;
      if (declaredTooLarge || actualTooLarge) {
        res.status(413).json({
          jsonrpc: '2.0',
          error: { code: 413, message: 'Payload Too Large' },
          id: null,
        });
        return;
      }
      next();
    };
  }

  /** The express handler. Mount behind `requireApiKey`, which is what
   *  guarantees `req.apiKey` is present. */
  handler(): RequestHandler {
    return (req: Request, res: Response): void => {
      void this.handleHttp(req, res);
    };
  }

  private async handleHttp(req: Request, res: Response): Promise<void> {
    // POST only, for the same two reasons `LoopbackMcpServer` gives: the MCP
    // spec makes the standalone GET SSE stream optional and blesses 405 when a
    // server does not offer one, and — decisive here — a per-request transport
    // LEAKS on GET, because an SSE stream never ends, so `handleRequest` never
    // resolves and the `finally` that tears the pair down never runs.
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed' },
        id: null,
      });
      return;
    }

    const principal = req.apiKey;
    if (!principal) {
      // Unreachable behind `requireApiKey`. Answering 401 rather than throwing
      // means a future mis-mount degrades to "authentication required" instead
      // of to an unauthenticated 500 that still ran the handler.
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }

    let session: ReturnType<typeof this.createRequestScopedServer> | undefined;
    try {
      session = this.createRequestScopedServer(principal);
      await session.mcp.connect(session.transport);
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      // No error detail on the wire: this is a public surface, and a dispatch
      // stack trace names internal tools, plugins and hosts.
      console.warn(`[public-mcp] request failed: ${String(error)}`);
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    } finally {
      // A stateless transport is SINGLE-USE — the SDK throws "Stateless
      // transport cannot be reused across requests" on its second use — so
      // dropping it here is what makes the next request work at all. Safe at
      // this point because `enableJsonResponse` means the response is fully
      // written by the time `handleRequest` resolves.
      await session?.transport.close().catch(() => {});
      await session?.mcp.close().catch(() => {});
    }
  }

  /**
   * A fresh `Server` + transport pair for ONE HTTP request.
   *
   * `sessionIdGenerator: undefined` selects the SDK's stateless mode: no
   * session id is issued, no session validation happens, and a client may skip
   * the `initialize` handshake and never send `Mcp-Session-Id`. That is the
   * whole premise of the issue — horizontal scalability requires that any
   * process can answer any request — and it is why the pair is per-request by
   * construction rather than by convention: a shared transport makes only the
   * FIRST request work and 500s every one after it.
   */
  private createRequestScopedServer(principal: ApiKeyPrincipal): {
    mcp: McpServer;
    transport: StreamableHTTPServerTransport;
  } {
    const mcp = new McpServer(
      {
        name: this.deps.serverName ?? 'omadia-public-mcp',
        version: this.deps.serverVersion ?? '0.0.0',
      },
      { capabilities: { tools: {} } },
    );

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.listToolsFor(principal),
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await this.callToolFor(principal, name, args ?? {});
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

  /**
   * The tools this key can actually CALL, name-sorted.
   *
   * Not "the tools it may see" — the two must be the same set. A name the
   * caller cannot invoke is a free hint about which integrations this install
   * runs, which is exactly the enumeration the issue's own security notes warn
   * about.
   */
  private async listToolsFor(
    principal: ApiKeyPrincipal,
  ): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
    if (!hasScope(principal.scopes, MCP_LIST_SCOPE)) {
      // An error, not an empty list: "not scoped for mcp:list" leaks no tool
      // names, and an integrator debugging a misconfigured key deserves to be
      // able to tell a scope problem from an empty allowlist.
      throw new McpError(
        ErrorCode.InvalidRequest,
        `this API key is not scoped for '${MCP_LIST_SCOPE}'`,
      );
    }

    const binding = await this.deps.bindings.get(principal.keyId);
    if (!binding) return [];

    const dispatcher = this.deps.resolveDispatcher(binding.agentId);
    if (!dispatcher) return [];

    const callable = this.callableToolNames(principal, binding);
    if (callable.size === 0) return [];

    // Filter the AGENT's advertised specs by the KEY's callable set. Both
    // directions matter: a tool in the binding that the agent does not
    // advertise cannot be described (and must not be invented), and a tool the
    // agent advertises that the binding omits must not appear.
    return dispatcher
      .listDispatchableToolSpecs()
      .filter((spec) => callable.has(spec.name))
      .map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.input_schema,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * The exact set of tool names this key could successfully invoke.
   *
   * ONE function, used by both `tools/list` and `tools/call`, so the list can
   * never advertise something the call path would refuse (or vice versa —
   * which would be the security-relevant direction).
   */
  private callableToolNames(
    principal: ApiKeyPrincipal,
    binding: PublicMcpKeyBinding,
  ): ReadonlySet<string> {
    if (!hasScope(principal.scopes, MCP_INVOKE_SCOPE)) return new Set();
    const callable = new Set(binding.readTools);
    for (const tool of binding.writeTools) {
      // Per-tool, and wildcard-proof: `hasWriteScope` routes through `hasScope`,
      // which refuses to let `*` satisfy a `mcp:write:` scope.
      if (hasWriteScope(principal.scopes, tool)) callable.add(tool);
    }
    return callable;
  }

  private async callToolFor(
    principal: ApiKeyPrincipal,
    name: string,
    input: unknown,
  ): Promise<ToolDispatchResult> {
    const startedAt = Date.now();
    const binding = await this.deps.bindings.get(principal.keyId);

    // No binding ⇒ nothing is callable, and there is no agent to attribute the
    // attempt to. Audited with the key id so a probing key is still visible.
    if (!binding) {
      this.record(principal, 'unbound', name, false, 'no public MCP binding', startedAt, false);
      throw new McpError(ErrorCode.InvalidParams, unavailableToolMessage(name));
    }

    const isWrite = binding.writeTools.includes(name);
    const callable = this.callableToolNames(principal, binding);
    if (!callable.has(name)) {
      this.record(principal, binding.agentId, name, false, 'not allowlisted', startedAt, isWrite);
      throw new McpError(ErrorCode.InvalidParams, unavailableToolMessage(name));
    }

    // Stricter budget for writes, on its own limiter instance. Checked AFTER
    // authorization so a caller cannot map the allowlist by watching which
    // names cost quota, and BEFORE the concurrency slot so an over-budget
    // caller cannot occupy one.
    if (isWrite && !this.deps.writeRateLimiter.tryConsume(principal.keyId, binding.writeRateLimitPerMinute)) {
      this.record(principal, binding.agentId, name, false, 'write rate limited', startedAt, true);
      throw new McpError(
        ErrorCode.InvalidRequest,
        `write rate limit exceeded: this key is limited to ${String(binding.writeRateLimitPerMinute)} write calls/minute`,
      );
    }

    const dispatcher = this.deps.resolveDispatcher(binding.agentId);
    if (!dispatcher) {
      this.record(principal, binding.agentId, name, false, 'agent not active', startedAt, isWrite);
      throw new McpError(ErrorCode.InternalError, unavailableToolMessage(name));
    }

    if (this.privacySeamRequired && !this.deps.dispatchWithContext) {
      // See `requirePrivacySeam`. Refusing here rather than at boot keeps the
      // endpoint's `tools/list` honest (an integrator can still discover the
      // contract) while making it impossible to move unmasked data.
      this.record(principal, binding.agentId, name, false, 'privacy seam absent', startedAt, isWrite);
      throw new McpError(
        ErrorCode.InternalError,
        'public MCP tool calls are disabled: the dispatch privacy/trace seam is not wired, so a response could carry unmasked personal data',
      );
    }

    if (this.inFlight >= this.maxConcurrentCalls) {
      this.record(principal, binding.agentId, name, false, 'concurrency ceiling', startedAt, isWrite);
      throw new McpError(ErrorCode.InternalError, 'public MCP endpoint is at capacity — retry shortly');
    }

    const caller: PublicMcpCallerContext = {
      keyId: principal.keyId,
      ...(principal.label ? { label: principal.label } : {}),
      scopes: principal.scopes,
      agentId: binding.agentId,
      write: isWrite,
    };

    this.inFlight += 1;
    try {
      const result = await this.withTimeout(name, () =>
        this.deps.dispatchWithContext
          ? this.deps.dispatchWithContext(dispatcher, name, input, caller)
          : dispatcher.dispatch(name, input),
      );
      this.record(
        principal,
        binding.agentId,
        name,
        result.isError !== true,
        result.isError === true ? 'tool reported an error' : null,
        startedAt,
        isWrite,
      );
      return result;
    } catch (error) {
      this.record(principal, binding.agentId, name, false, String(error), startedAt, isWrite);
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Bounds one dispatch.
   *
   * The timer is cleared on BOTH paths. A dangling timer would keep the
   * process's event loop alive per call, and — worse for a public endpoint —
   * the losing side of the race is the only thing that ever clears it, so a
   * fast tool would leak one timer per successful call.
   *
   * Note the dispatch itself is not cancelled (nothing in `ToolDispatchService`
   * accepts an AbortSignal); the SLOT is released, which is what the
   * concurrency ceiling needs. Recorded here so nobody reads this as
   * cancellation.
   */
  private async withTimeout(
    toolName: string,
    run: () => Promise<ToolDispatchResult>,
  ): Promise<ToolDispatchResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new McpError(
                  ErrorCode.InternalError,
                  `tool \`${toolName}\` exceeded the ${String(this.toolTimeoutMs)}ms public MCP timeout`,
                ),
              ),
            this.toolTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One audit row per call ATTEMPT, including every refusal. A refusal that
   *  leaves no trace is the one an operator cannot investigate. */
  private record(
    principal: ApiKeyPrincipal,
    agentId: string,
    toolName: string,
    ok: boolean,
    error: string | null,
    startedAt: number,
    write: boolean,
  ): void {
    if (!this.deps.audit) return;
    try {
      this.deps.audit({
        keyId: principal.keyId,
        agentId,
        toolName,
        ok,
        error,
        durationMs: Math.max(0, Date.now() - startedAt),
        calledAt: new Date(startedAt),
        // Same vocabulary the base branch established: a resolved identity, or
        // the literal `unresolved` when there is none to name.
        actingIdentity: principal.keyId ? `apikey:${principal.keyId}` : 'unresolved',
        write,
      });
    } catch (err) {
      // An audit sink that throws must not turn a successful call into a
      // failure — nor a refusal into a success.
      console.warn(`[public-mcp] audit sink threw: ${String(err)}`);
    }
  }
}
