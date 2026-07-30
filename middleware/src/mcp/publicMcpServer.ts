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

import { randomUUID } from 'node:crypto';

import type { Request, RequestHandler, Response } from 'express';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import type { ApiKeyPrincipal, RateLimiter } from '@omadia/api-key-auth';
import { hasScope, hasWriteScope, MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import type {
  DispatchableToolSpec,
  PrivacyTurnHandle,
  ToolDispatchOptions,
  ToolDispatchResult,
} from '@omadia/orchestrator';

import type { PublicMcpKeyBinding, PublicMcpKeyBindingStore } from './publicMcpKeyBindings.js';
import {
  createFailClosedPrivacyGate,
  isPubliclyServableTool,
  type PublicMcpPrivacyGate,
} from './publicMcpPrivacy.js';

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
 *
 * `isWriteCapable` is the dispatch layer's OWN predicate
 * (`isWriteCapableTool(writeCapabilities)`): declaration-driven, never derived
 * from a tool's name. It is the source of truth for "may this mutate data",
 * and this endpoint reads it rather than inventing a second answer.
 */
export interface PublicMcpDispatcher {
  dispatch(
    name: string,
    input: unknown,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult>;
  listDispatchableToolSpecs(): readonly DispatchableToolSpec[];
  isWriteCapable(name: string): boolean;
  /**
   * Runs `fn` with `handle` installed as the dispatcher's privacy dependency.
   *
   * `ToolDispatchService` takes `privacy` as a per-SERVICE dependency, but this
   * endpoint needs a per-CALL handle: the fail-closed gate carries per-call
   * state (`maskingFailed()`), and a shared one would let one caller's masking
   * failure discard another caller's good result. The wiring builds the
   * dispatcher around a mutable slot and exposes this to fill it for exactly the
   * duration of one dispatch — see `wirePublicMcp.ts`.
   *
   * Optional in the type, but LOAD-BEARING in practice whenever a privacy
   * provider is installed: the endpoint gates on `gate.masked()`, and a
   * dispatcher that never receives the gate's handle can never set it. A host
   * that omits this while masking is required has every call refused — loudly,
   * which is the correct direction for a privacy control.
   */
  withPrivacy?<T>(handle: PrivacyTurnHandle, fn: () => Promise<T>): Promise<T>;
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
   * Builds the privacy data-plane handle for ONE dispatch.
   *
   * REQUIRED in practice — see `requirePrivacyMasking`. This endpoint runs
   * entirely outside `turnContext.run(...)`, so `ToolDispatchService`'s ambient
   * fallback resolves to `undefined` here and results would flow to the caller
   * with PII intact. The handle must be supplied explicitly; the scope ids are
   * per-request because the Privacy Shield keys its Dataset Store on
   * `(sessionId, turnId)` and sharing them across callers would let one
   * caller's digest resolve against another's rows.
   *
   * Returns `undefined` when no `privacyRedact` provider is installed at all.
   */
  readonly privacy?: (scope: { sessionId: string; turnId: string }) => PrivacyTurnHandle | undefined;
  /**
   * Whether a tool call is refused when masking is unavailable or fails.
   *
   * DEFAULTS TO TRUE. Three fail-open paths sit between a raw tool result and an
   * internet caller, and `publicMcpPrivacy.ts` documents how each is closed. The
   * one this flag governs is the coarsest: no privacy provider installed ⇒
   * `ToolDispatchService` passes results through unchanged, by design and in
   * parity with the chat path. For an operator's own chat that is an accepted
   * configuration; for a third party over HTTP it is a data leak with a
   * config-shaped cause.
   *
   * Set false ONLY on a deliberate, documented operator decision — e.g. an
   * install whose allowlisted tools provably carry no personal data.
   */
  readonly requirePrivacyMasking?: boolean;
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

  private get privacyMaskingRequired(): boolean {
    return this.deps.requirePrivacyMasking ?? true;
  }

  /**
   * Whether a call to `name` may MUTATE data, and therefore needs the per-tool
   * write scope, the tighter write budget, and at-most-once protection.
   *
   * The UNION of two sources, and the union is the security-relevant part:
   *
   *  - `dispatcher.isWriteCapable(name)` — the dispatch layer's own
   *    declaration-driven predicate (`isWriteCapableTool`). Authoritative when a
   *    tool declares `writeCapabilities`, and the right source of truth: a
   *    name-derived guess is the silent-rollback failure the contract exists to
   *    prevent.
   *  - `binding.writeTools.includes(name)` — the operator's declaration.
   *
   * Neither alone is safe. `isWriteCapable` returns FALSE for an unannotated
   * write tool (its own docs call that a plugin bug, but a plugin bug must not
   * become a public write escalation), so the operator list covers it. And the
   * operator list can put a tool under `read_tools` by mistake, which the
   * annotation then overrides — a tool that declares it mutates data is a write
   * even if the binding says otherwise. Union, so a MISTAKE IN EITHER DIRECTION
   * fails toward "treat it as a write".
   */
  private isEffectiveWrite(
    dispatcher: PublicMcpDispatcher,
    binding: PublicMcpKeyBinding,
    name: string,
  ): boolean {
    return dispatcher.isWriteCapable(name) || binding.writeTools.includes(name);
  }

  /**
   * Enforces the 8 MB ceiling.
   *
   * NOT `express.json({ limit })`. The kernel mounts a global
   * `express.json({ limit: '10mb' })` before every `/api` router (index.ts), so
   * by the time a request reaches this one the stream is already consumed and
   * parsed: a route-level parser would be a silent no-op and the loopback
   * server's 8 MB ceiling would quietly become the kernel's 10 MB one.
   *
   * Mounting this router BEFORE `express.json` would allow a real streaming
   * cap, but would also put it in front of the `/api` requireAuth mount and
   * throw away the `publicPaths` half of the defense this route is required to
   * use. The cap is the cheaper thing to reimplement.
   *
   * Two checks, and they are NOT two independent gates — be precise about which
   * does the work:
   *
   *  - The re-serialized body length is the ACTUAL enforcement. It catches
   *    every oversized body, including a chunked upload carrying no
   *    `Content-Length` at all.
   *  - `Content-Length` is a COST optimization in front of it: re-serializing
   *    an 8 MB body to measure it is itself expensive, and a client that
   *    honestly declares an oversized payload can be refused without paying
   *    that. It is not a security control on its own — a lying header cannot be
   *    trusted, and one that declares 9 MB while sending 100 bytes never
   *    reaches this middleware anyway (`express.json` is still waiting for the
   *    rest of the body). Treat it as the fast path, not as the gate.
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
      // MCP standardizes no idempotency field, so it rides in `params._meta`,
      // the spec's designated passthrough. Advisory by construction — see the
      // idempotency section of the endpoint README for what a consumer may
      // actually rely on.
      const meta = request.params._meta as { idempotencyKey?: unknown } | undefined;
      const idempotencyKey =
        typeof meta?.idempotencyKey === 'string' && meta.idempotencyKey.length > 0
          ? meta.idempotencyKey
          : undefined;
      const result = await this.callToolFor(principal, name, args ?? {}, idempotencyKey);
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

    const callable = this.callableToolNames(principal, binding, dispatcher);
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
    dispatcher: PublicMcpDispatcher,
  ): ReadonlySet<string> {
    if (!hasScope(principal.scopes, MCP_INVOKE_SCOPE)) return new Set();
    const callable = new Set<string>();
    for (const tool of [...binding.readTools, ...binding.writeTools]) {
      // Never servable regardless of the operator's allowlist: a tool the
      // Privacy Shield deliberately exempts from masking would reach a third
      // party in clear. See `publicMcpPrivacy.ts` header, point 3.
      if (!isPubliclyServableTool(tool)) continue;
      if (this.isEffectiveWrite(dispatcher, binding, tool)) {
        // Per-tool, and wildcard-proof: `hasWriteScope` routes through
        // `hasScope`, which refuses to let `*` satisfy a `mcp:write:` scope.
        if (hasWriteScope(principal.scopes, tool)) callable.add(tool);
        continue;
      }
      callable.add(tool);
    }
    return callable;
  }

  private async callToolFor(
    principal: ApiKeyPrincipal,
    name: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<ToolDispatchResult> {
    const startedAt = Date.now();
    const binding = await this.deps.bindings.get(principal.keyId);

    // No binding ⇒ nothing is callable, and there is no agent to attribute the
    // attempt to. Audited with the key id so a probing key is still visible.
    if (!binding) {
      this.record(principal, 'unbound', name, false, 'no public MCP binding', startedAt, false);
      throw new McpError(ErrorCode.InvalidParams, unavailableToolMessage(name));
    }

    // The dispatcher is resolved BEFORE the authorization checks now, because
    // `isEffectiveWrite` consults its declaration-driven `isWriteCapable`. That
    // reordering is safe — resolving a dispatcher runs no tool and reveals
    // nothing to the caller — and it is necessary: deciding "is this a write"
    // from the binding alone would miss an annotated write tool the operator
    // filed under `read_tools`.
    const dispatcher = this.deps.resolveDispatcher(binding.agentId);
    if (!dispatcher) {
      this.record(principal, binding.agentId, name, false, 'agent not active', startedAt, false);
      throw new McpError(ErrorCode.InternalError, unavailableToolMessage(name));
    }

    const isWrite = this.isEffectiveWrite(dispatcher, binding, name);
    const callable = this.callableToolNames(principal, binding, dispatcher);
    if (!callable.has(name)) {
      this.record(principal, binding.agentId, name, false, 'not allowlisted', startedAt, isWrite);
      throw new McpError(ErrorCode.InvalidParams, unavailableToolMessage(name));
    }

    // Stricter budget for writes, on its own limiter instance. Checked AFTER
    // authorization so a caller cannot map the allowlist by watching which
    // names cost quota, and BEFORE the concurrency slot so an over-budget
    // caller cannot occupy one.
    if (
      isWrite &&
      !this.deps.writeRateLimiter.tryConsume(principal.keyId, binding.writeRateLimitPerMinute)
    ) {
      this.record(principal, binding.agentId, name, false, 'write rate limited', startedAt, true);
      throw new McpError(
        ErrorCode.InvalidRequest,
        `write rate limit exceeded: this key is limited to ${String(binding.writeRateLimitPerMinute)} write calls/minute`,
      );
    }

    // The privacy data-plane handle for THIS dispatch. Per-request scope ids:
    // the Privacy Shield keys its Dataset Store on `(sessionId, turnId)`, so
    // sharing them across callers would let one caller's digest resolve against
    // another caller's rows.
    const scope = { sessionId: `public-mcp:${principal.keyId}`, turnId: randomUUID() };
    const base = this.deps.privacy?.(scope);
    if (!base) {
      // No `privacyRedact` provider installed. `ToolDispatchService` would pass
      // the raw result straight through — parity with the chat path, and a data
      // leak here. Refusing at CALL time rather than at boot keeps `tools/list`
      // honest so an integrator can still discover the contract.
      if (this.privacyMaskingRequired) {
        this.record(
          principal,
          binding.agentId,
          name,
          false,
          'privacy provider absent',
          startedAt,
          isWrite,
        );
        throw new McpError(
          ErrorCode.InternalError,
          'public MCP tool calls are disabled: no privacy provider is installed, so a response could carry unmasked personal data',
        );
      }
    }
    const gate = base ? createFailClosedPrivacyGate(base) : undefined;

    if (this.inFlight >= this.maxConcurrentCalls) {
      this.record(principal, binding.agentId, name, false, 'concurrency ceiling', startedAt, isWrite);
      throw new McpError(
        ErrorCode.InternalError,
        'public MCP endpoint is at capacity — retry shortly',
      );
    }

    // The seam the sibling unit built, consumed. A CARRIER only — it performs no
    // authorization, which is why every gate above already ran. `principal` is
    // the API-key id so an audit consumer beneath dispatch can attribute the
    // call; `scopes` is passed for downstream policy, not because anything under
    // dispatch enforces it.
    const options: ToolDispatchOptions = {
      caller: {
        principal: principal.keyId,
        scopes: principal.scopes,
        requestId: scope.turnId,
      },
      // Applied by the dispatch layer to write-capable tools ONLY, and only
      // when an idempotency store is wired. Advisory — see the README.
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    this.inFlight += 1;
    try {
      const result = await this.withTimeout(name, () =>
        this.dispatchWithPrivacy(dispatcher, name, input, options, gate),
      );

      // FAIL CLOSED. The gate turned a masking exception into a placeholder
      // rather than letting the dispatcher's fail-open branch return the raw
      // rows, so the result in hand may be that placeholder — or, worse if this
      // check were missing, a partially-masked body. Discard it entirely.
      if (gate?.maskingFailed() === true) {
        this.record(
          principal,
          binding.agentId,
          name,
          false,
          'privacy masking failed',
          startedAt,
          isWrite,
        );
        throw new McpError(
          ErrorCode.InternalError,
          'privacy masking failed for this tool result — the result was discarded rather than returned unmasked',
        );
      }

      // FAIL CLOSED, second half: the boundary must have been CROSSED, not
      // merely "not failed".
      //
      // `maskingFailed()` cannot tell "masking succeeded" from "masking never
      // ran", and "never ran" is the shape every leak in this family has taken:
      // a dispatch branch that skipped `afterDispatch` entirely (the throwing
      // -handler bug), a handler returning a non-string that the masker declines
      // to walk, an intern-exempt name that slipped past the allowlist. In each
      // case the raw bytes are already in hand and every check above is happy.
      //
      // So gate on the positive signal instead. `masked()` is true only when
      // `internToolResultV4` actually returned a digest for this dispatch, which
      // is the one thing that cannot be true by accident.
      //
      // ONE exception: `origin === 'dispatcher'` marks content the dispatch
      // layer authored itself — "unknown tool", "plugin not ready" — which
      // names only the tool the caller asked for and the owning plugin id, and
      // carries no tool data for masking to have crossed. Anything else,
      // INCLUDING an `origin`-less result from a dispatcher that predates the
      // field, must have been masked.
      if (gate !== undefined && result.origin !== 'dispatcher' && !gate.masked()) {
        this.record(
          principal,
          binding.agentId,
          name,
          false,
          'privacy masking skipped',
          startedAt,
          isWrite,
        );
        throw new McpError(
          ErrorCode.InternalError,
          'privacy masking did not run for this tool result — the result was discarded rather than returned unmasked',
        );
      }

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
      // An McpError raised above is already audited; re-auditing would double
      // -count it. Only genuinely unexpected throws land a second row.
      if (!(error instanceof McpError)) {
        this.record(principal, binding.agentId, name, false, String(error), startedAt, isWrite);
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Dispatches with the fail-closed privacy gate installed.
   *
   * The gate is handed over as `ToolDispatchService`'s `privacy` dependency —
   * which is a per-SERVICE dep, not a per-call one. Since the gate must be
   * per-call (its `maskingFailed()` is per-call state), the dispatcher supplied
   * by the wiring reads the handle through a mutable slot this method fills for
   * the duration of one dispatch. `PublicMcpDispatcher` therefore carries an
   * optional `withPrivacy` escape hatch; when the wiring does not provide one,
   * the dispatcher was built with a handle already bound and this is a plain
   * call.
   */
  private async dispatchWithPrivacy(
    dispatcher: PublicMcpDispatcher,
    name: string,
    input: unknown,
    options: ToolDispatchOptions,
    gate: PublicMcpPrivacyGate | undefined,
  ): Promise<ToolDispatchResult> {
    if (gate && dispatcher.withPrivacy) {
      return dispatcher.withPrivacy(gate.handle, () => dispatcher.dispatch(name, input, options));
    }
    return dispatcher.dispatch(name, input, options);
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
