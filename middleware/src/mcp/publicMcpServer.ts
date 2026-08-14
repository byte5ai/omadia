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
 *  3. ALLOWLIST — the tool must be named in that row AND advertised by the
 *     agent. Enforced on `tools/call` AND on `tools/list` through the SAME
 *     predicate (`callableToolNames`), because a tool name the key cannot call
 *     is itself a disclosure (it tells a third party which integrations this
 *     install runs), and two predicates that disagree hand a caller a working
 *     oracle for the binding's contents.
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

import { randomBytes, randomUUID } from 'node:crypto';

import type { Request, RequestHandler, Response } from 'express';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  McpServer as ModernMcpServer,
  createMcpHandler,
  inputRequired,
  isLegacyRequest,
  type RequestStateCodec,
  type Tool as ModernTool,
} from '@modelcontextprotocol/server';

import type { ApiKeyPrincipal, RateLimiter } from '@omadia/api-key-auth';
import { hasScope, hasWriteScope, MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import {
  AI_PROVENANCE_HEADER,
  AI_PROVENANCE_META_KEY,
  ENVELOPE_PROVENANCE,
} from '@omadia/channel-sdk';
import { REPLAY_ARG_KEY } from '@omadia/orchestrator';
import type {
  DispatchableToolSpec,
  PrivacyTurnHandle,
  ToolDispatchOptions,
  ToolDispatchResult,
} from '@omadia/orchestrator';

import { rawBodyBytes } from '../http/rawBodySize.js';
import {
  carriesInputResponses,
  inputRequestBounceError,
  inputRequestMalformedError,
  parseToolEmittedInputRequest,
  renderInputRequiredResult,
  type McpInputRequiredResult,
} from './publicMcpInputRequired.js';
import type { PublicMcpKeyBinding, PublicMcpKeyBindingStore } from './publicMcpKeyBindings.js';
import {
  flattenInputResponses,
  toEmbeddedInputRequests,
} from './publicMcpModernMrtr.js';
import {
  createFailClosedPrivacyGate,
  isPubliclyServableTool,
  type PublicMcpPrivacyGate,
} from './publicMcpPrivacy.js';
import {
  PUBLIC_MCP_MAX_INPUT_ROUNDS,
  createPublicMcpRequestStateCodec,
  type PublicMcpRequestState,
} from './publicMcpRequestState.js';

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
  /**
   * HMAC codec for the 2026-07-28 `requestState` (issue #700).
   *
   * SHOULD be supplied by the wiring from the vault-backed key, because the
   * endpoint is stateless and horizontally scaled: the instance that verifies
   * an echoed state is usually not the one that minted it, and a per-process
   * key makes retries fail only when they land elsewhere — intermittently,
   * under load, which is the worst way to discover a key problem.
   *
   * Omitted, this class generates a process-local key and says so once. That
   * keeps single-process installs and tests working with the integrity check
   * fully intact, rather than degrading to an unverified passthrough, which is
   * the one option that would be silently insecure.
   *
   * A resolver rather than a value because the key comes from the vault, which
   * is async, while the mount that supplies it is not. Called at most once.
   */
  readonly resolveRequestStateCodec?: () => Promise<RequestStateCodec<PublicMcpRequestState>>;
}

/** Deliberately identical for "no such tool", "not allowlisted for this key",
 *  and "allowlisted but the agent does not advertise it". Distinguishing them
 *  would confirm a tool's existence — or a binding's contents — to a caller not
 *  entitled to know, which is the same disclosure `tools/list` filtering exists
 *  to prevent. */
function unavailableToolMessage(name: string): string {
  return `Tool \`${name}\` is not available to this API key.`;
}

/**
 * The handler context fields the 2026-07-28 leg reads (#700).
 *
 * Typed structurally and read defensively: both are absent on the ORIGINAL
 * call and present only on a retry, so every access here is on a value the
 * seam may legitimately not have populated.
 */
interface ModernCallContext {
  readonly mcpReq?: {
    readonly inputResponses?: unknown;
    readonly requestState?: <T>() => T | undefined;
  };
}

/** The client's embedded answers on a retry, or `undefined` on a first call. */
function readInputResponses(ctx: unknown): unknown {
  return (ctx as ModernCallContext | undefined)?.mcpReq?.inputResponses;
}

/**
 * The VERIFIED `requestState` payload.
 *
 * Safe to trust: the seam ran `requestState.verify` before the handler, and a
 * value that failed it never gets this far — the request was already answered
 * with the frozen `-32602`. What arrives here is the codec's decoded payload,
 * not the wire string.
 */
function readVerifiedState(ctx: unknown): PublicMcpRequestState | undefined {
  const accessor = (ctx as ModernCallContext | undefined)?.mcpReq?.requestState;
  if (typeof accessor !== 'function') return undefined;
  const state = accessor<PublicMcpRequestState>();
  return state !== null && typeof state === 'object' && typeof state.round === 'number'
    ? state
    : undefined;
}

export class PublicMcpServer {
  private inFlight = 0;

  /** Memoised so a generated fallback key stays stable for this process —
   *  minting per request would refuse every retry, including its own. */
  private resolvedCodec?: Promise<RequestStateCodec<PublicMcpRequestState>>;

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
      // What actually arrived on the wire, recorded by the global parser's
      // `verify` hook. Preferred over the re-serialized length because JSON is
      // mostly insignificant whitespace: a chunked body of 9 MB of spaces around
      // `{}` declares no `Content-Length`, re-serializes to two bytes, and so
      // passed both of the other two checks while costing the full 9 MB to
      // receive and parse.
      const received = rawBodyBytes(req);
      const receivedTooLarge = received !== undefined && received > MAX_REQUEST_BYTES;
      // Kept as the fallback for a request that never met a `verify`-wired
      // parser (a raw-body route, a hand-built test request). Weaker, but a
      // weaker check is better than none where the real figure is unknown.
      const actualTooLarge =
        req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8') > MAX_REQUEST_BYTES;
      if (declaredTooLarge || receivedTooLarge || actualTooLarge) {
        res.status(413).json({
          jsonrpc: '2.0',
          error: { code: 413, message: 'Payload Too Large' },
          id: null,
        });
        return;
      }
      // A JSON-RPC BATCH is one HTTP request carrying many messages, and every
      // per-request control on this endpoint is charged once per HTTP request:
      // `requireApiKey`'s rate limiter takes a single token, and `tools/list`
      // never touches the concurrency counter at all. So one sub-8-MB array of
      // tens of thousands of `tools/list` calls costs the caller one token and
      // costs the server that many `bindings.get` round-trips to Postgres. The
      // write limiter still covers writes; reads and listing were free.
      //
      // The SDK's transport does accept arrays (`webStandardStreamableHttp`
      // maps over `rawMessage` when `Array.isArray`), so this is reachable, not
      // theoretical. Refusing them outright is both the smaller fix and the
      // spec-correct one: MCP removed JSON-RPC batching in the 2025-06-18
      // revision and this endpoint implements 2026-07-28. Rate-limiting
      // per-message instead would mean charging a limiter that lives one
      // middleware upstream, for a shape the protocol no longer defines.
      //
      // Deliberately BEFORE `requireApiKey`: an unauthenticated batch should
      // also cost nothing, and this is the cheapest place to say no.
      if (Array.isArray(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message:
              'JSON-RPC batching is not supported: send one request per HTTP call. Batching was removed from MCP in the 2025-06-18 revision.',
          },
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

  /**
   * Anything a request handler throws that is not already an `McpError` becomes
   * a generic one.
   *
   * The outer `handleHttp` catch LOOKS like it covers this and does not. The SDK
   * turns a handler rejection into a JSON-RPC error response built from
   * `error.message` (`shared/protocol.js`: `message: error.message ?? 'Internal
   * error'`) and then RESOLVES normally — so `handleRequest` never rejects, the
   * catch never runs, and the raw message is already on the wire.
   *
   * Concretely: `bindings.get` failing hands an external, merely
   * API-key-authenticated caller a Postgres diagnostic — `relation
   * "public_mcp_key_bindings" does not exist`, a host name, a driver string.
   * Exactly the class of detail `handleHttp`'s catch exists to withhold.
   *
   * `McpError`s raised deliberately by this class are caller-facing text by
   * design ("not allowlisted", "at capacity", the masking refusals) and pass
   * through untouched.
   */
  private async sanitized<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof McpError) throw error;
      console.warn(`[public-mcp] ${what} handler failed: ${String(error)}`);
      throw new McpError(ErrorCode.InternalError, 'Internal server error');
    }
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

    // ── era routing (#700) ──────────────────────────────────────────────────
    // Two SDK generations serve this one path, and the protocol era of the
    // request decides which — never configuration, and never a per-deployment
    // flag. The reason is that neither generation can serve both eras here:
    //
    //  - The v1 line has no `server/discover`, so a 2026-07-28 client
    //    negotiating against it always falls back to the legacy era, where a
    //    modern client STRIPS `resultType` off the reply. MRTR is invisible to
    //    it no matter which dialect the body carries.
    //  - The v2 line refuses to emit omadia's 2025-era `inputRequests` array at
    //    all, on either era ("each inputRequests entry must be an embedded
    //    elicitation/create, sampling/createMessage, or roots/list request"),
    //    so serving legacy traffic from it would withdraw the dialect this
    //    endpoint's README documents and existing integrations are built on.
    //
    // Routing is the SDK's own documented composition for exactly this
    // situation. `isLegacyRequest` is authoritative and must not be
    // second-guessed: everything it calls non-legacy — including malformed
    // envelopes and unsupported-revision claims — belongs to the modern path,
    // which owns those error answers.
    if (!(await isLegacyRequest(this.toWebRequest(req), req.body))) {
      await this.handleModern(req, res, principal);
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

    mcp.setRequestHandler(ListToolsRequestSchema, async () =>
      // #647 — no `_meta` provenance here on purpose: a listing is not an AI
      // answer, and the envelope-level marking (the endpoint is an AI system) is
      // carried by the response header, which is set for every reply. The
      // per-call `_meta` twin rides only the `tools/call` result below.
      this.sanitized('tools/list', async () => ({
        tools: await this.listToolsFor(principal),
      })),
    );

    mcp.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.sanitized('tools/call', async () => {
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
        // #544 (server half) — MRTR. A tool that cannot finish without one more
        // value from the human says so in-band; render it as
        // `resultType: "input_required"` so the caller can collect the values
        // and retry, instead of shipping our internal sentinel JSON as if it
        // were an answer. Failed calls are excluded: a failure has no pending
        // continuation, and treating one as a prompt would turn every tool error
        // into a question for the user.
        const pendingInput = result.isError
          ? undefined
          : this.resolveInputRequired(name, args, result.content);
        const body =
          pendingInput !== undefined
            ? pendingInput
            : {
                content: [{ type: 'text' as const, text: result.content }],
                ...(result.isError ? { isError: true } : {}),
              };
        return {
          ...body,
          // #647 — AI-Act Art. 50 provenance, per call. The envelope-level twin
          // of the router's response header, carried in the spec's designated
          // passthrough (`_meta`) so an existing client that does not read the
          // key ignores it and the JSON-RPC result stays backward-compatible.
          _meta: { [AI_PROVENANCE_META_KEY]: ENVELOPE_PROVENANCE },
        };
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    return { mcp, transport };
  }

  // ── the 2026-07-28 leg (#700) ─────────────────────────────────────────────

  /**
   * The `requestState` codec, resolved once.
   *
   * A generated key is a real fallback, not a disabled check: states are still
   * signed and still verified, they just stop being verifiable by a SIBLING
   * instance. The warning names that, because the symptom (a retry failing only
   * when it lands on another process) is otherwise very hard to read.
   */
  private codec(): Promise<RequestStateCodec<PublicMcpRequestState>> {
    // The PROMISE is memoised, not its value: two concurrent first requests
    // must not each resolve a key, or the second would mint under a key the
    // first never used and every retry would land on a coin flip.
    this.resolvedCodec ??= (async () => {
      const resolve = this.deps.resolveRequestStateCodec;
      if (resolve) return resolve();
      console.warn(
        '[public-mcp] ⚠ MRTR requestState key GENERATED per process — a retry served by another instance will be refused. Wire `resolveRequestStateCodec` from the vault.',
      );
      return createPublicMcpRequestStateCodec(randomBytes(32));
    })();
    return this.resolvedCodec;
  }

  /**
   * Rebuild the Express request as a web-standard `Request`.
   *
   * Built from the ALREADY-PARSED body rather than the socket: `express.json()`
   * consumed the stream long before this runs, so a handler that tried to read
   * `req` again would hang on a stream with nothing left in it. The parsed body
   * is handed to the SDK separately (`parsedBody`) for the same reason — this
   * copy exists so the request classifier and the transport see identical
   * bytes.
   */
  private toWebRequest(req: Request): globalThis.Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const url = `http://${req.headers.host ?? 'public-mcp.invalid'}${req.originalUrl}`;
    return new globalThis.Request(url, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
  }

  /**
   * Serve one 2026-07-28 request.
   *
   * The handler is built per request, like the legacy session above and for the
   * same reason: the principal is baked into the factory's closure, so there is
   * no window in which one caller's server instance can answer another
   * caller's request. This surface is internet-facing and its whole
   * authorization model is per-key; a shared instance would put that model one
   * refactor away from a cross-key leak, and building a handler is cheaper than
   * the server-plus-transport pair the legacy path already builds per request.
   */
  private async handleModern(
    req: Request,
    res: Response,
    principal: ApiKeyPrincipal,
  ): Promise<void> {
    const handler = createMcpHandler(() => this.createModernServer(principal), {
      // The legacy era never reaches here — `handleHttp` routed it to the v1
      // path already. Saying so explicitly means a routing regression fails
      // loudly at this boundary instead of quietly serving 2025 traffic from
      // the generation that cannot speak omadia's dialect.
      legacy: 'reject',
    });
    const response = await handler.fetch(this.toWebRequest(req), {
      parsedBody: req.body,
      // Pass-through only: authentication already happened in `requireApiKey`.
      // The token is deliberately NOT forwarded — nothing downstream needs the
      // secret, and the key id is what the `requestState` binding needs.
      authInfo: { token: '', clientId: principal.keyId, scopes: [...principal.scopes] },
    });
    await this.writeWebResponse(res, response);
  }

  /** Copy a web `Response` onto the Express response. */
  private async writeWebResponse(res: Response, response: globalThis.Response): Promise<void> {
    response.headers.forEach((value, name) => {
      // The provenance header is already set by the router's middleware for
      // every reply on this route; letting the SDK's copy overwrite it would
      // make the AI-Act marking depend on which leg answered (#647).
      if (name.toLowerCase() === AI_PROVENANCE_HEADER) return;
      res.setHeader(name, value);
    });
    res.status(response.status);
    const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
    if (body === undefined || body.length === 0) {
      res.end();
      return;
    }
    res.end(body);
  }

  /**
   * The 2026-07-28 server instance for ONE request.
   *
   * Every authorization decision goes through the SAME `listToolsFor` /
   * `callToolFor` the legacy leg uses. That is the point: the four gates
   * (binding, allowlist, scope, privacy) are not reimplemented per era, so
   * there is no second place for them to disagree. Only the MRTR dialect and
   * the round accounting differ, and both live in the handler below.
   */
  private async createModernServer(principal: ApiKeyPrincipal): Promise<ModernMcpServer> {
    const codec = await this.codec();
    const mcp = new ModernMcpServer(
      {
        name: this.deps.serverName ?? 'omadia-public-mcp',
        version: this.deps.serverVersion ?? '0.0.0',
      },
      {
        capabilities: { tools: {} },
        // BOTH of these belong on the SERVER options. Passing either to
        // `createMcpHandler` compiles, runs, and does nothing — a tampered
        // `requestState` is then accepted while the endpoint looks healthy.
        // Measured; do not move them.
        inputRequired: { legacyShim: false },
        requestState: { verify: codec.verify },
      },
    );

    mcp.server.setRequestHandler('tools/list', async () =>
      this.sanitized('tools/list', async () => ({
        // Same projection the legacy leg serves. The cast asserts what
        // TypeScript cannot prove about a caller-supplied JSON Schema: v2
        // models `inputSchema` as a concrete JSON value where this endpoint
        // carries it as `unknown`. The runtime value is the identical object
        // the v1 leg puts on the wire — nothing here reshapes it.
        tools: (await this.listToolsFor(principal)) as unknown as ModernTool[],
      })),
    );

    mcp.server.setRequestHandler('tools/call', async (request, ctx) =>
      this.sanitized('tools/call', async () => {
        const params = request.params as unknown as {
          name: string;
          arguments?: Record<string, unknown>;
          _meta?: { idempotencyKey?: unknown };
        };
        const name = params.name;
        const idempotencyKey =
          typeof params._meta?.idempotencyKey === 'string' && params._meta.idempotencyKey.length > 0
            ? params._meta.idempotencyKey
            : undefined;

        // The retry leg. The human's answers arrive as a spec `ElicitResult`
        // and are handed to the tool as the SAME flat object the 2025-era
        // dialect delivers, so a tool never learns which era its caller spoke.
        const answered = flattenInputResponses(readInputResponses(ctx));
        const args: Record<string, unknown> = {
          ...(params.arguments ?? {}),
          ...(answered !== undefined ? { [REPLAY_ARG_KEY]: answered } : {}),
        };

        const result = await this.callToolFor(principal, name, args, idempotencyKey);
        const pending = result.isError
          ? undefined
          : parseToolEmittedInputRequest(result.content);

        if (pending === undefined || !pending.ok) {
          if (pending !== undefined && pending.rejection.kind === 'unusable') {
            return this.modernBody({
              content: [
                { type: 'text' as const, text: inputRequestMalformedError(name, pending.rejection.reason) },
              ],
              isError: true,
            });
          }
          return this.modernBody({
            content: [{ type: 'text' as const, text: result.content }],
            ...(result.isError ? { isError: true } : {}),
          });
        }

        // The bounce cap, read off the SIGNED round rather than inferred from
        // the arguments. On the 2025-era dialect a caller that strips
        // `inputResponses` gets a fresh card forever; here it cannot, because
        // the count it would have to forge is under the endpoint's own MAC.
        const round = (readVerifiedState(ctx)?.round ?? 0) + 1;
        if (round > PUBLIC_MCP_MAX_INPUT_ROUNDS) {
          return this.modernBody({
            content: [{ type: 'text' as const, text: inputRequestBounceError(name) }],
            isError: true,
          });
        }

        const rendered = renderInputRequiredResult(pending.request);
        return inputRequired({
          inputRequests: toEmbeddedInputRequests(pending.request, rendered.message ?? ''),
          requestState: await codec.mint({ tool: name, round }, ctx),
        });
      }),
    );

    return mcp;
  }

  /** Attach the per-call AI-Act provenance twin, exactly as the legacy leg
   *  does (#647) — the marking must not depend on which era answered. */
  private modernBody<T extends Record<string, unknown>>(
    body: T,
  ): T & { _meta: Record<string, unknown> } {
    return { ...body, _meta: { [AI_PROVENANCE_META_KEY]: ENVELOPE_PROVENANCE } };
  }

  /**
   * The tools this key can actually CALL, name-sorted.
   *
   * Not "the tools it may see" — the two ARE the same set, because both come
   * from `callableToolNames`. A name the caller cannot invoke is a free hint
   * about which integrations this install runs, which is exactly the enumeration
   * the issue's own security notes warn about.
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

    // `callable` is already a SUBSET of what the agent advertises (see
    // `callableToolNames`), so this filter only projects the specs — it can no
    // longer narrow the set. Kept as the projection step, not as a second
    // predicate: describing a tool requires its spec, and the spec is what this
    // iteration is here to fetch.
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
   *
   * ─── W4: the ADVERTISED filter belongs here, not only in `listToolsFor` ─────
   *
   * `tools/list` used to intersect this set with `listDispatchableToolSpecs()`
   * while `tools/call` authorized on this set alone and then dispatched by raw
   * name. A tool named in a binding but NOT advertised by the agent was
   * therefore hidden from list yet accepted by call — where it failed deep in
   * the dispatcher as ``Error: unknown tool `x` `` instead of the uniform
   * refusal. List being stricter is the safe direction, but the two error
   * shapes are a working oracle: a caller can distinguish "in your binding but
   * unavailable" from "not in your binding" and map the binding's contents one
   * probe at a time. Moving the filter here collapses both to
   * `unavailableToolMessage`, and makes the invariant documented above actually
   * true.
   */
  private callableToolNames(
    principal: ApiKeyPrincipal,
    binding: PublicMcpKeyBinding,
    dispatcher: PublicMcpDispatcher,
  ): ReadonlySet<string> {
    if (!hasScope(principal.scopes, MCP_INVOKE_SCOPE)) return new Set();
    const advertised = new Set(
      dispatcher.listDispatchableToolSpecs().map((spec) => spec.name),
    );
    const callable = new Set<string>();
    for (const tool of [...binding.readTools, ...binding.writeTools]) {
      // The agent must actually offer it. Covers a stale binding, a plugin
      // whose readiness gate is closed (`listDispatchableToolSpecs` filters
      // those), and a handler-only registration that carries no spec.
      if (!advertised.has(tool)) continue;
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

  /**
   * #544 (server half) — decide whether this successful dispatch is really a
   * request for more input, and render it.
   *
   * Returns `undefined` for every ordinary result, which is the overwhelming
   * majority: the caller then builds the normal body and nothing about this
   * endpoint changes. Three outcomes when the sentinel IS present:
   *
   *   - malformed request  → an ordinary tool error naming the reason. A tool
   *     that emits an unrenderable request has a bug; shipping its raw sentinel
   *     JSON to the caller as a "result" is how that bug stays invisible.
   *   - already answered   → an ordinary tool error. The caller already sent
   *     `inputResponses` once, so a second request means the tool would bounce
   *     the human indefinitely. Mirrors `MCP_INPUT_MAX_REPLAY_DEPTH` on the
   *     client half — one round trip, not a loop.
   *   - otherwise          → the MRTR body.
   *
   * The two error outcomes deliberately produce `isError`, not a request: they
   * ARE failed calls, and the client half's `isInputRequiredResult` refuses to
   * read an `isError` result as a card — so mislabelling either one would make
   * omadia's own endpoint unreadable by omadia's own client.
   */
  private resolveInputRequired(
    name: string,
    args: unknown,
    content: string,
  ):
    | McpInputRequiredResult
    | { content: Array<{ type: 'text'; text: string }>; isError: true }
    | undefined {
    const parsed = parseToolEmittedInputRequest(content);
    if (!parsed.ok) {
      if (parsed.rejection.kind === 'absent') return undefined;
      return {
        content: [
          { type: 'text', text: inputRequestMalformedError(name, parsed.rejection.reason) },
        ],
        isError: true,
      };
    }
    if (carriesInputResponses(args)) {
      return {
        content: [{ type: 'text', text: inputRequestBounceError(name) }],
        isError: true,
      };
    }
    return renderInputRequiredResult(parsed.request);
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
      // The masking assertion, moved to where it can also stop a bad body being
      // CACHED. Running it only after `dispatch()` returned was too late: the
      // idempotency store had already retained an unmasked result, so the first
      // request was correctly refused and the RETRY replayed that raw body —
      // flagged `replayed`, and therefore exempt from the assertion that had
      // just rejected it. Throwing from inside the store's `exec` means nothing
      // is retained, and a concurrent duplicate inherits the rejection instead
      // of the body. The post-dispatch check below stays as defence in depth.
      validateResult: (produced) => {
        this.assertMaskingCrossed(produced, gate);
      },
    };

    // One row per call, written exactly once. The flag is what lets the catch
    // below audit a failure without risking a double-count, whatever kind of
    // error it was.
    let audited = false;
    const audit = (ok: boolean, error: string | null): void => {
      if (audited) return;
      audited = true;
      this.record(principal, binding.agentId, name, ok, error, startedAt, isWrite);
    };

    this.inFlight += 1;
    // The slot is released when the WORK settles, not when this request's race
    // does. `withTimeout` is a `Promise.race`, and losing a race does not cancel
    // the loser: the Odoo/M365/MCP/sub-agent call keeps running with no
    // AbortSignal to stop it. Releasing in a `finally` on the race therefore
    // reopened the slot while the call was still alive, so a caller hammering a
    // tool that hangs on an upstream connection accumulates unbounded sockets,
    // promises and external work — all while the endpoint still advertises a
    // ceiling of `maxConcurrentCalls`.
    //
    // Cancelling the work outright would mean threading an AbortSignal through
    // ToolDispatchService into every handler; that is a real change and belongs
    // on its own. Holding the slot until the work actually finishes is what
    // makes the ceiling mean what it says in the meantime: at most N tool calls
    // in flight, timed out or not.
    let released = false;
    const releaseSlot = (): void => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
    try {
      const work = this.dispatchWithPrivacy(dispatcher, name, input, options, gate);
      // Attached to the WORK, so a post-timeout settle still frees the slot.
      // Both arms, so a late rejection is handled rather than surfacing as an
      // unhandled rejection once the race has already rejected.
      void work.then(releaseSlot, releaseSlot);
      const result = await this.withTimeout(name, work);

      // Defence in depth. `validateResult` already ran this on the freshly
      // produced body, inside the idempotency `exec` so a refused result is
      // never retained. Repeating it here covers the replay path and any future
      // dispatcher that ignores the option, and costs two boolean reads.
      this.assertMaskingCrossed(result, gate);

      audit(
        result.isError !== true,
        result.isError === true ? 'tool reported an error' : null,
      );
      return result;
    } catch (error) {
      // EVERY failure lands exactly one row, and the bookkeeping is a flag
      // rather than "is it an McpError".
      //
      // That heuristic was wrong in both directions. It over-assumed: the
      // TIMEOUT is an `McpError` minted inside `withTimeout`, which audits
      // nothing — so a write that may well have committed upstream produced no
      // row at all. And it grew a second hole when the masking assertion moved
      // into `validateResult`: that throw now surfaces from inside `dispatch`,
      // so it never reaches the explicit record that used to sit beside the
      // check.
      if (!audited) {
        audit(false, this.maskingRefusalReason(error, gate) ?? String(error));
      }
      throw error;
    }
    // No `finally` releasing the slot: that is the defect this shape fixes. The
    // release rides on `work` above and fires whenever the work settles, which
    // may be long after this request has answered with a timeout.
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
   * accepts an AbortSignal). Recorded here so nobody reads this as
   * cancellation: the caller gets a timeout, the WORK carries on. The
   * concurrency slot therefore stays held until the work settles — see the
   * release wired to `work` in `callTool`, which is what keeps
   * `maxConcurrentCalls` an honest ceiling rather than a ceiling on
   * *un-timed-out* calls only.
   *
   * Takes the already-started promise rather than a thunk, so there is exactly
   * one execution for both the race and the slot release to observe.
   */
  /**
   * FAIL CLOSED, both halves. Throws rather than returning a verdict so it can
   * be handed to `ToolDispatchOptions.validateResult` and run BEFORE the
   * idempotency store retains anything — see that field for why "may this be
   * returned" and "may this be cached" have to be the same question.
   *
   * Half one: the gate turned a masking exception into a placeholder rather
   * than letting the dispatcher's fail-open branch return the raw rows, so the
   * body in hand may be that placeholder — or, worse if this were missing, a
   * partially-masked one. Discard it entirely.
   *
   * Half two: the boundary must have been CROSSED, not merely "not failed".
   * `maskingFailed()` cannot tell "masking succeeded" from "masking never ran",
   * and "never ran" is the shape every leak in this family has taken: a
   * dispatch branch that skipped `afterDispatch` (the throwing-handler bug), a
   * handler returning a non-string the masker declines to walk, an
   * intern-exempt name that slipped past the allowlist. In each case the raw
   * bytes are already in hand and every other check is happy. So gate on the
   * POSITIVE signal: `masked()` is true only when `internToolResultV4` actually
   * returned a digest for this dispatch, which cannot be true by accident.
   *
   * TWO exceptions, both narrow.
   *
   * 1. `origin === 'dispatcher'` marks content the dispatch layer authored
   *    itself — "unknown tool", "plugin not ready" — naming only the tool asked
   *    for and the owning plugin id, with no tool data for masking to have
   *    crossed. Anything else, INCLUDING an `origin`-less result from a
   *    dispatcher predating the field, must have been masked.
   *
   * 2. `replayed` marks an idempotency cache hit: no handler ran for THIS
   *    request, so the per-request gate cannot have observed a masking call
   *    however well the cached body was masked when produced. Without it a
   *    legitimate retry is refused with "privacy masking did not run" — the
   *    worst answer to a retried write, since the caller learns nothing about
   *    whether the mutation committed. Safe ONLY because this same assertion
   *    now runs before retention: a body that would fail it never enters the
   *    cache, so `replayed` cannot smuggle one back out.
   */
  /** Audit reason for a masking refusal, or `undefined` when `error` is
   *  something else. Keeps the two refusals distinguishable in `mcp_call_log`
   *  now that they surface from inside `dispatch` rather than beside the check. */
  private maskingRefusalReason(
    error: unknown,
    gate: PublicMcpPrivacyGate | undefined,
  ): string | undefined {
    if (!(error instanceof McpError)) return undefined;
    if (!/privacy masking/.test(error.message)) return undefined;
    return gate?.maskingFailed() === true ? 'privacy masking failed' : 'privacy masking skipped';
  }

  private assertMaskingCrossed(
    result: ToolDispatchResult,
    gate: PublicMcpPrivacyGate | undefined,
  ): void {
    if (gate?.maskingFailed() === true) {
      throw new McpError(
        ErrorCode.InternalError,
        'privacy masking failed for this tool result — the result was discarded rather than returned unmasked',
      );
    }
    if (
      gate !== undefined &&
      result.origin !== 'dispatcher' &&
      result.replayed !== true &&
      !gate.masked()
    ) {
      throw new McpError(
        ErrorCode.InternalError,
        'privacy masking did not run for this tool result — the result was discarded rather than returned unmasked',
      );
    }
  }

  private async withTimeout(
    toolName: string,
    work: Promise<ToolDispatchResult>,
  ): Promise<ToolDispatchResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
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
