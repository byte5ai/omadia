/**
 * MCP client manager (Agent Builder P4).
 *
 * Connects to operator-registered MCP servers (stdio / streamable-HTTP / SSE)
 * via the official `@modelcontextprotocol/sdk`, discovers their tools, and
 * adapts each discovered tool into the two shapes the orchestrator already
 * understands:
 *
 *   - `NativeToolSpec` + `NativeToolHandler` — for tools granted to a
 *     top-level agent (registered on its `NativeToolRegistry`).
 *   - `LocalSubAgentTool`               — for tools granted to a sub-agent
 *     (passed into its `LocalSubAgent` tool list).
 *
 * Connections are pooled per server id and lazily (re)established. A failed
 * connection is dropped so the next call retries — callers layer their own
 * backoff. The manager never throws on `callTool`; it returns an `Error: …`
 * string so a tool failure degrades the turn instead of killing it.
 */

import { createHash, randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  LocalSubAgentTool,
  NativeToolHandler,
  NativeToolSpec,
} from '@omadia/plugin-api';

import { turnContext } from '../turnContext.js';
import {
  MCP_INPUT_MAX_REPLAY_DEPTH,
  extractMcpInputPrompt,
  mcpInputMalformedError,
  mcpInputReplayCappedError,
  mcpInputRequiredSentinel,
  mcpInputUnsupportedError,
  parseMcpInputRequests,
  type PendingMcpInput,
  type PendingMcpInputStore,
} from './pendingMcpInput.js';

/**
 * Relaxed CallToolResult schema: the MCP spec says `structuredContent` MUST be a
 * JSON object, but some hosted proxies (e.g. strava.run.mcp.com.ai) return it as
 * an array. The SDK's strict schema rejects the entire result, and callTool then
 * throws — which we surface as "-32000 Connection closed", making every call on
 * that server look like a dead connection. Accepting any `structuredContent`
 * keeps well-formed servers unchanged while tolerating this one deviation.
 *
 * Issue #547 (W1-3): `structuredContent` is now also read out-of-band via
 * `extractStructured` and handed to `McpManagerOptions.structuredSink`. The
 * lenient schema is what makes that possible for off-spec (array-valued)
 * payloads too — the sink carries whatever the server sent, unnormalised.
 *
 * Issue #544 (W2-1): `resultType` + `inputRequests` (MRTR mid-call user input)
 * are declared here too. Both are readable off the SHIPPED SDK 1.29.0 — no
 * version bump, and no dependency on the `@modelcontextprotocol/{core,client,
 * server}@2.0.0` family (#540).
 *
 * Be precise about what the declaration buys, because it is NOT "makes the
 * fields arrive": SDK 1.29.0's `CallToolResultSchema` derives from
 * `ResultSchema`, which is `.passthrough()`, so an unmodelled key already
 * survives `parse` at runtime. Verified, and pinned by a characterization test
 * in `mcpPendingInput.test.ts`. Declaring them explicitly buys two things:
 *   1. They are typed and intentional rather than an unnamed passthrough
 *      residue, so a reader can see what we consume off the wire.
 *   2. The behaviour stops being hostage to an SDK internal. Passthrough is not
 *      part of the MRTR contract, and this file already carries the scar of a
 *      strict-vs-lenient result schema breaking every call on a server
 *      (`structuredContent`, above); a future SDK that tightens it would break
 *      MRTR silently instead of loudly.
 * Both are typed loosely on purpose — the MRTR shape is not final, so
 * validation lives in `parseMcpInputRequests` where a failure can degrade to a
 * plain tool error instead of rejecting the whole result.
 */
// Cast back to the base schema type: the SDK's callTool overload is typed to the
// strict CallToolResultSchema, but our runtime schema only *widens* what parses
// (any structuredContent, optional resultType/inputRequests), so it is a safe
// superset.
const LENIENT_CALL_TOOL_RESULT_SCHEMA = CallToolResultSchema.extend({
  structuredContent: z.unknown().optional(),
  resultType: z.string().optional(),
  inputRequests: z.unknown().optional(),
}) as unknown as typeof CallToolResultSchema;

/** MRTR result type meaning "I need more information from the human" (#544). */
export const MCP_RESULT_TYPE_INPUT_REQUIRED = 'input_required';

export type McpTransportKind = 'stdio' | 'http' | 'sse';

/**
 * Transports the MCP specification has formally deprecated (issue #541).
 *
 * The MCP 2026-07-28 revision reclassifies the legacy HTTP+SSE transport
 * (two endpoints: `GET /sse` for the event stream plus a separate POST
 * endpoint for messages) as **Deprecated**, with a minimum 12-month removal
 * window. Streamable HTTP (our `'http'`) is the migration target.
 *
 * omadia therefore *discourages* `'sse'` for NEW registrations — the operator
 * picker hides it behind a "show deprecated transports" toggle, and the
 * marketplace importer prefers an `http` remote when a catalog entry offers
 * both. Nothing is hard-blocked: the removal window is open, existing rows
 * keep working unchanged (`SSEClientTransport` stays wired in
 * `McpManager.transportFor`), and the `agent_mcp_servers.transport` CHECK
 * constraint still accepts `'sse'`, so a legacy server can be re-created.
 *
 * This array is the single source of truth for "which transports are
 * deprecated" — the API serializer, the marketplace importer, and the web-ui
 * all derive from it rather than hard-coding `'sse'`.
 */
export const DEPRECATED_MCP_TRANSPORTS = ['sse'] as const;

/** A transport listed in {@link DEPRECATED_MCP_TRANSPORTS}. */
export type DeprecatedMcpTransport = (typeof DEPRECATED_MCP_TRANSPORTS)[number];

/**
 * True when `transport` is deprecated by the MCP spec. Takes a plain `string`
 * so callers holding an unvalidated DB/catalog value can ask without casting.
 */
export function isDeprecatedMcpTransport(transport: string): boolean {
  return (DEPRECATED_MCP_TRANSPORTS as readonly string[]).includes(transport);
}

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransportKind;
  /** URL for http/sse, or a shell command line for stdio. */
  readonly endpoint: string | null;
  /** Non-sensitive headers for http/sse. Secrets resolve via `secretRef`. */
  readonly headers?: Record<string, string>;
  /** Epic #459 — environment variables for a stdio command (config values +
   *  Vault-resolved secrets), merged over a safe base env when the process
   *  spawns. Ignored for http/sse. */
  readonly env?: Record<string, string>;
  /** Epic #459 — operator opted this server out of Privacy Shield masking. */
  readonly privacyBypass?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  /**
   * Issue #547 (W1-3) — the tool's declared `outputSchema` from `tools/list`.
   * Never sent to the model (it would only inflate the prompt); it travels with
   * the structured-result sidecar so a downstream consumer can render the
   * payload against its declared shape. Persisted with the discovered-tool row
   * so it survives a restart without re-discovery.
   */
  readonly outputSchema?: Record<string, unknown>;
}

/** Caller taxonomy for the MCP call audit log (epic #459 W2, issue #462).
 *  Defined once here; skill (#456) and plugin (#458) surfaces identify
 *  themselves via `turnContext.mcpCallerKind`. */
export type McpCallerKind = 'agent' | 'subagent' | 'skill' | 'plugin' | 'unattributed';

/**
 * Issue #544 (W2-1) — what actually happened on a call.
 *
 * The audit trail used to be binary (`ok: true | false`), which MRTR breaks:
 * a parked `input_required` call neither succeeded nor failed. Overloading
 * either value would misreport it — `ok: false` would put a phantom failure in
 * front of operators debugging a healthy server, and a bare `ok: true` would
 * claim the tool delivered a result it never delivered. So the truth gets its
 * own field, and `ok` keeps its narrower documented meaning: "the call
 * completed without failing".
 */
export type McpCallOutcome = 'ok' | 'fail' | 'input_required';

/** One audit entry per `callTool` invocation. Deliberately carries NO tool
 *  arguments — identity and outcome only. */
export interface McpCallLogEntry {
  readonly serverId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly callerKind: McpCallerKind;
  readonly callerAgent: string | null;
  readonly turnId: string | null;
  /** True unless the call FAILED. An `input_required` park is not a failure —
   *  read `outcome` to tell it apart from a delivered result. */
  readonly ok: boolean;
  /**
   * W2-1 — the three-valued truth. Optional so persisters that predate #544
   * (and the `mcp_call_log` table, which has no column for it yet) keep
   * compiling and simply ignore it; every entry the manager emits sets it.
   */
  readonly outcome?: McpCallOutcome;
  readonly error: string | null;
  readonly durationMs: number;
  readonly calledAt: Date;
  /** W0-1 — WHOSE authority this call acted under. `callerAgent` names the
   *  orchestrator; this names the identity its credentials belonged to. The
   *  literal `unresolved` marks a `per_user` server that had no identity to
   *  act as (the call fails closed), which is exactly the case an operator
   *  needs to be able to find in the audit trail. */
  readonly actingIdentity: string | null;
}

/** Observer invoked after every tool call. Implementations must be fast and
 *  MUST NOT throw; the manager additionally guards with try/catch so the
 *  audit path can never break a tool call. */
export type McpCallObserver = (entry: McpCallLogEntry) => void;

/** Dispatch-time policy gate (issue #454, codex-fold 2). Returns a
 *  model-facing error string to DENY the call, or null to allow it. Runs on
 *  every `callTool`, so policy changes (re-discover found a risk, operator
 *  acked one) apply immediately — no registry rebuild required for
 *  enforcement. Denied calls are still audit-logged. */
export type McpCallGuard = (serverId: string, toolName: string) => string | null;

/**
 * Generic MCP authorization hook (epic #459 W9). Provider-agnostic: the manager
 * asks for a bearer token to inject per call, and — when a call fails with an
 * auth error and no working token — asks for an authorize URL to surface. All
 * OAuth/discovery logic lives outside the manager (mcpOAuthService).
 */
export interface McpAuthProvider {
  /** A live bearer token for this server + the current caller, or null. */
  getToken(cfg: McpServerConfig): Promise<string | null>;
  /**
   * Called when a call failed and the server may need authorization. Returns a
   * ready-to-show user message (an "authorize here: <url>" prompt, or a "set it
   * up in the Control Center" instruction when no client is registered yet), or
   * null when the server is not OAuth-protected — in which case the raw error
   * stands. The provider owns the messaging + the protected/needs-client
   * decision, so the manager needs no OAuth knowledge.
   */
  onAuthFailure(cfg: McpServerConfig): Promise<string | null>;
  /**
   * The identity this server's calls act as, for the audit trail (W0-1). Same
   * resolution `getToken` uses, exposed separately so EVERY audited call —
   * including denied ones and calls to servers with no OAuth at all — records
   * who acted. Returns null when the provider cannot attribute the call.
   * Optional: providers that predate W0-1 keep working (identity falls back to
   * the turn context).
   */
  resolveIdentity?(cfg: McpServerConfig): Promise<string | null>;
  /**
   * Secret config values to inject as request headers for this server (epic
   * #459). Resolved from the Vault per call so secrets never live on the pooled
   * config or the DB row. Per-server (not per-caller), so pooling by server id
   * stays correct. Optional — returns `{}` when the server has no secret config.
   */
  getConfigHeaders?(cfg: McpServerConfig): Promise<Record<string, string>>;
  /**
   * Environment variables for a stdio server (epic #459): config values + Vault
   * secrets, passed to the spawned process. Resolved per call so secrets never
   * live on the pooled config or the DB row.
   */
  getConfigEnv?(cfg: McpServerConfig): Promise<Record<string, string>>;
}

// ── out-of-band sidecar (issue #547 W1-3) ───────────────────────────────────
//
// Everything the model sees still travels as the plain string `callTool`
// returns. Anything richer — an MCP `structuredContent` payload today, an
// `input_required` result type tomorrow (#544 MRTR / W2-1) — leaves the manager
// through this second, out-of-band channel instead of widening the return type.
//
// Widening was ruled out deliberately, for two reasons that are not stylistic:
//   1. `NativeToolHandler = (input: unknown) => Promise<string>` is a published
//      plugin contract; every in-tree and out-of-tree plugin implements it.
//   2. The orchestrator gates Privacy Shield masking on
//      `typeof result === 'string'`. A non-string result would silently skip
//      masking — i.e. bypass the shield entirely.
// The sidecar keeps both invariants intact: no downstream hop changes.

/** Discriminator for a sidecar payload. W1-3 shaped this as a union precisely
 *  so W2-1 could add its second member here instead of inventing a parallel
 *  channel; `'input_required'` is that planned member (#544). */
export type McpSidecarKind = 'structured_output' | 'input_required';

/** Identity carried by every sidecar payload: which turn, which server, which
 *  tool. `turnId` is null outside a turn (e.g. an operator test-call). */
export interface McpSidecarIdentity {
  readonly serverId: string;
  readonly toolName: string;
  readonly turnId: string | null;
}

/** An MCP tool returned a `structuredContent` payload alongside its text. */
export interface McpStructuredOutputSidecar extends McpSidecarIdentity {
  readonly kind: 'structured_output';
  /** The parsed payload exactly as the server sent it — object, or an array for
   *  off-spec hosted servers. Never a re-parse of the rendered string. */
  readonly structured: unknown;
  /** The tool's declared `outputSchema`, when discovery captured one. */
  readonly outputSchema?: Record<string, unknown>;
}

/**
 * Issue #544 (W2-1) — an MCP tool answered `resultType: "input_required"` and
 * the call has been parked in the {@link PendingMcpInputStore}. Rides the same
 * out-of-band channel as the structured-output payload for the same reason: the
 * model-facing return stays a plain string (a stable sentinel), so neither the
 * `NativeToolHandler` contract nor the orchestrator's
 * `typeof result === 'string'` Privacy-Shield gate changes.
 */
export interface McpInputRequiredSidecar extends McpSidecarIdentity {
  readonly kind: 'input_required';
  /** The parked record — carries `serverName` so the card can attribute the
   *  request, which is a security requirement, not cosmetics. */
  readonly pending: PendingMcpInput;
}

/** Union of everything the sidecar channel can carry. Add new members here;
 *  consumers switch on `kind`. */
export type McpSidecarPayload =
  | McpStructuredOutputSidecar
  | McpInputRequiredSidecar;

/**
 * Out-of-band sink for payloads that must NOT reach the model as text.
 * Implementations must be fast and MUST NOT throw; the manager additionally
 * guards with try/catch so the sidecar can never break a tool call. Mirrors the
 * `onToolCall` audit-observer contract.
 */
export type McpStructuredSink = (payload: McpSidecarPayload) => void;

export interface McpManagerOptions {
  readonly onToolCall?: McpCallObserver;
  readonly guard?: McpCallGuard;
  readonly auth?: McpAuthProvider;
  /** Issue #547 (W1-3) — see `McpStructuredSink`. Optional: omitting it leaves
   *  behaviour byte-identical to before. */
  readonly structuredSink?: McpStructuredSink;
  /**
   * Issue #544 (W2-1) — where a `resultType: "input_required"` call gets parked
   * until the user answers. Same optional-dependency shape as `auth` /
   * `structuredSink`: omitting it leaves every existing path byte-identical,
   * and an `input_required` result then degrades to a plain tool error
   * (`mcpInputUnsupportedError`) rather than vanishing.
   */
  readonly pendingInput?: PendingMcpInputStore;
}

/** True when an error/result string looks like an authorization failure. */
function looksUnauthorized(text: string): boolean {
  return (
    /-?32401\b/.test(text) ||
    /\b401\b/.test(text) ||
    /unauthorized/i.test(text) ||
    /authentication (error|required)/i.test(text) ||
    /invalid[_ ]token/i.test(text)
  );
}

/** True when a failure looks like a transient transport hiccup worth one retry
 *  (request timeout, dropped/closed connection, socket reset) — NOT an auth or
 *  application-level tool error. */
function looksTransient(text: string): boolean {
  // W0-5 — auth wins. `-32001` used to be matched as a bare numeric code here,
  // which contradicted this function's own contract: the code is only
  // *implementation-defined*, and servers legitimately use it for Unauthorized
  // (omadia's own LoopbackMcpServer does, see its 401 branch). A genuine
  // Unauthorized was therefore retried once — an extra doomed round trip that
  // delayed the auth prompt. A real SDK request timeout still retries: it
  // carries "Request timed out" and matches the timeout pattern below.
  if (looksUnauthorized(text)) return false;
  return (
    /timed?\s*out|timeout/i.test(text) ||
    /connection closed|connection reset|econnreset|socket hang ?up|network error|fetch failed|und_err/i.test(
      text,
    )
  );
}

interface Pooled {
  readonly client: Client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly transport: any;
}

const CLIENT_INFO = { name: 'omadia-agent-builder', version: '0.1.0' } as const;

/**
 * W0-2 — explicit per-call MCP request policy. `callTool` used to pass no
 * `RequestOptions` at all and silently inherited the SDK's 60s default, so the
 * real ceiling was undocumented and un-tunable. Stated here instead:
 *  - `timeout`: idle budget for one request.
 *  - `resetTimeoutOnProgress`: a server streaming progress notifications keeps
 *    its budget alive (long Odoo/Confluence reports do exactly this)…
 *  - `maxTotalTimeout`: …but never past this absolute ceiling, so a chatty
 *    server cannot extend a call forever.
 * Both are env-tunable per deployment.
 *
 * ── ORDERING INVARIANT (W3-A) ───────────────────────────────────────────────
 * These are the INNER bounds. The orchestrator's per-tool dispatch deadline
 * (`OMADIA_TOOL_DISPATCH_TIMEOUT_MS`, see `DEFAULT_TOOL_DISPATCH_TIMEOUT_MS` in
 * `orchestrator.ts`) is the OUTER bound and must stay strictly LOOSER than
 * `maxTotalTimeout` here. It used to default to 120 s — i.e. INSIDE this 180 s
 * ceiling — so an MCP-backed sub-agent legitimately streaming progress for its
 * full allowance was killed by the outer bound first, and the model saw a
 * generic dispatch-deadline error instead of the MCP layer's own diagnosis.
 * `test/orchestrator/timeoutHierarchy.test.ts` fails loudly if a future edit to
 * either knob re-creates the inversion.
 */
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = 180_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * The MCP request policy as it would be applied to the NEXT `callTool` — the
 * same resolution `callTool` performs, exposed so the timeout-hierarchy
 * invariant can be asserted against the real numbers (including env overrides)
 * rather than against a copy of the defaults.
 */
export function resolveMcpCallTimeouts(): {
  readonly timeoutMs: number;
  readonly maxTotalTimeoutMs: number;
} {
  return {
    timeoutMs: envMs('OMADIA_MCP_CALL_TIMEOUT_MS', DEFAULT_MCP_CALL_TIMEOUT_MS),
    maxTotalTimeoutMs: envMs(
      'OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS',
      DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
    ),
  };
}

export class McpManager {
  private readonly pool = new Map<string, Pooled>();
  private readonly connecting = new Map<string, Promise<Pooled>>();
  /** Issue #547 (W1-3) — declared `outputSchema` per `${serverId} ${tool}`.
   *  `callTool` only receives a name, so the schema learned at discovery (or
   *  rehydrated from the persisted descriptor by the adapters below) is cached
   *  here and attached to the sidecar. A miss just omits the schema. */
  private readonly outputSchemas = new Map<string, Record<string, unknown>>();

  /** Optional audit observer + dispatch guard (issues #462/#454). Existing
   *  `new McpManager()` call sites keep working unchanged. */
  constructor(private readonly options?: McpManagerOptions) {}

  /** Emit one audit entry. Caller identity comes from the turn context
   *  (AsyncLocalStorage), so every dispatch path is covered without call-site
   *  threading; non-turn paths degrade deterministically to `unattributed`.
   *  Never throws into the tool-call path. */
  private emitCall(
    cfg: McpServerConfig,
    toolName: string,
    outcome: McpCallOutcome,
    error: string | null,
    startedAt: number,
    actingIdentity: string | null,
  ): void {
    if (!this.options?.onToolCall) return;
    try {
      const ctx = turnContext.current();
      const inTurn = ctx !== undefined && ctx.turnId !== '';
      const callerKind: McpCallerKind =
        ctx?.mcpCallerKind ??
        (ctx?.subAgentOwnerPluginId !== undefined
          ? 'subagent'
          : inTurn
            ? 'agent'
            : 'unattributed');
      this.options.onToolCall({
        serverId: cfg.id,
        serverName: cfg.name,
        toolName,
        callerKind,
        callerAgent: ctx?.mcpCallerId ?? ctx?.agentSlug ?? null,
        turnId: inTurn ? ctx.turnId : null,
        // W2-1: `fail` is the ONLY outcome that clears `ok`. A parked
        // `input_required` call did not fail, so it must not show up in any
        // failure-rate query built on `ok`.
        ok: outcome !== 'fail',
        outcome,
        // Bounded: external error strings can carry upstream data; the audit
        // table is append-only, so cap what gets persisted (codex W2 finding).
        error: error === null ? null : error.length > 300 ? `${error.slice(0, 300)}…` : error,
        durationMs: Date.now() - startedAt,
        calledAt: new Date(),
        // W0-1: never left blank. An unattributable call is recorded AS
        // unattributable rather than silently omitted.
        actingIdentity: actingIdentity ?? ctx?.mcpUserKey ?? null,
      });
    } catch {
      /* the audit trail must never break a tool call */
    }
  }

  /**
   * Issue #547 (W1-3) — remember a tool's declared `outputSchema` so a later
   * `callTool` (which only gets a name) can attach it to the sidecar. Called
   * automatically by `listTools`, and by the adapter factories below so a
   * descriptor rehydrated from the DB after a restart is just as good as a
   * freshly discovered one. Idempotent; a schema-less descriptor is a no-op.
   */
  rememberToolSchema(serverId: string, tool: McpToolDescriptor): void {
    if (!tool.outputSchema) return;
    this.outputSchemas.set(schemaKey(serverId, tool.name), tool.outputSchema);
  }

  /** Emit one structured-result sidecar. Out-of-band by construction: the
   *  caller has already produced the model-facing string and ignores this. */
  private emitStructured(
    cfg: McpServerConfig,
    toolName: string,
    structured: unknown,
  ): void {
    if (!this.options?.structuredSink) return;
    try {
      const ctx = turnContext.current();
      const outputSchema = this.outputSchemas.get(schemaKey(cfg.id, toolName));
      this.options.structuredSink({
        kind: 'structured_output',
        serverId: cfg.id,
        toolName,
        turnId: ctx !== undefined && ctx.turnId !== '' ? ctx.turnId : null,
        structured,
        ...(outputSchema ? { outputSchema } : {}),
      });
    } catch {
      /* the sidecar must never break a tool call */
    }
  }

  /**
   * W2-1 (#544) — park a `resultType: "input_required"` call and hand the model
   * a stable sentinel instead of a result.
   *
   * Every exit here is deliberate and distinguishable; nothing degrades into
   * "looked like success":
   *   - no store wired            → plain tool error (`mcpInputUnsupportedError`)
   *   - unusable `inputRequests`  → plain tool error (`mcpInputMalformedError`)
   *   - bounce cap tripped        → plain tool error (`mcpInputReplayCappedError`)
   *   - second park in one turn   → `MCP_INPUT_ALREADY_PENDING_SENTINEL`
   *   - parked                    → `mcpInputRequiredSentinel`
   *
   * The three error exits audit as `'fail'` (they ARE failed calls — the tool
   * produced nothing usable). The two park exits audit as `'input_required'`,
   * which keeps `ok` true without claiming a result was delivered.
   */
  private parkInputRequired(
    cfg: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    res: unknown,
    startedAt: number,
    actingIdentity: string | null,
  ): string {
    const store = this.options?.pendingInput;
    if (!store) {
      const failure = mcpInputUnsupportedError(cfg.name, toolName);
      this.emitCall(cfg, toolName, 'fail', failure, startedAt, actingIdentity);
      return failure;
    }
    const parsed = parseMcpInputRequests(
      (res as { inputRequests?: unknown }).inputRequests,
    );
    if (!parsed.ok) {
      const failure = mcpInputMalformedError(cfg.name, toolName, parsed.reason);
      this.emitCall(cfg, toolName, 'fail', failure, startedAt, actingIdentity);
      return failure;
    }
    const prompt = extractMcpInputPrompt(res);
    const record: PendingMcpInput = {
      correlationId: randomUUID(),
      serverId: cfg.id,
      serverName: cfg.name,
      toolName,
      originalArgs: args,
      inputRequests: parsed.fields,
      ...(prompt !== undefined ? { prompt } : {}),
      // A call that already carries `inputResponses` IS the replay — the only
      // signal available here, since the manager is stateless per call.
      replayDepth: REPLAY_ARG_KEY in args ? MCP_INPUT_MAX_REPLAY_DEPTH : 0,
    };
    // Parked WITHOUT an owner: the manager has no reliable turn identity (see
    // `PendingMcpInputStore`). The orchestrator binds the owner when it claims
    // the record via the correlation id embedded in the sentinel below. Until
    // then the record is replayable by nobody.
    if (store.put(record) === 'replay_capped') {
      const failure = mcpInputReplayCappedError(record);
      this.emitCall(cfg, toolName, 'fail', failure, startedAt, actingIdentity);
      return failure;
    }
    this.emitCall(cfg, toolName, 'input_required', null, startedAt, actingIdentity);
    this.emitInputRequired(cfg, toolName, record);
    return mcpInputRequiredSentinel(record);
  }

  /** Emit one `input_required` sidecar. Same never-throws contract as
   *  `emitStructured`; consumers switch on `kind`. */
  private emitInputRequired(
    cfg: McpServerConfig,
    toolName: string,
    pending: PendingMcpInput,
  ): void {
    if (!this.options?.structuredSink) return;
    try {
      const ctx = turnContext.current();
      this.options.structuredSink({
        kind: 'input_required',
        serverId: cfg.id,
        toolName,
        turnId: ctx !== undefined && ctx.turnId !== '' ? ctx.turnId : null,
        pending,
      });
    } catch {
      /* the sidecar must never break a tool call */
    }
  }

  /** Discover the tool list a server exposes. Throws on connection failure so
   *  the operator-facing `/discover` endpoint can report it. */
  async listTools(cfg: McpServerConfig): Promise<McpToolDescriptor[]> {
    // Attach the OAuth token (issue #459 W9): some servers (e.g. Figma) require
    // authorization even to `initialize`/`tools/list`, so discovery must use the
    // caller's token exactly like a tool call — otherwise every OAuth-protected
    // server 401s on Discover and can never be onboarded.
    let token: string | null = null;
    if (this.options?.auth) {
      try {
        token = await this.options.auth.getToken(cfg);
      } catch {
        /* token resolution must not break discovery */
      }
    }
    const { client } = await this.getOrConnect(await this.withResolvedConfig(cfg), token);
    const res = await client.listTools();
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    const descriptors = tools.map((t) => ({
      name: String(t.name),
      ...(t.description ? { description: String(t.description) } : {}),
      ...(t.inputSchema
        ? { inputSchema: t.inputSchema as Record<string, unknown> }
        : {}),
      // Issue #547 (W1-3): carry the declared output schema through discovery
      // so it can be persisted and later attached to the sidecar. Object-only —
      // a server that sends a non-object here gets it dropped rather than
      // poisoning the descriptor (arrays are objects in JS, so exclude them).
      ...(isPlainObject(t.outputSchema)
        ? { outputSchema: t.outputSchema as Record<string, unknown> }
        : {}),
    }));
    for (const d of descriptors) this.rememberToolSchema(cfg.id, d);
    return descriptors;
  }

  /** Invoke a tool. Never throws — returns an `Error: …` string on failure so
   *  the orchestrator turn keeps going. */
  async callTool(
    cfg: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const startedAt = Date.now();
    // Resolve the acting identity FIRST (W0-1), before the guard can short-
    // circuit: a denied call still has to say whose authority it would have
    // used. Only paid for when auditing is actually on.
    let actingIdentity: string | null = null;
    if (this.options?.onToolCall && this.options.auth?.resolveIdentity) {
      try {
        actingIdentity = await this.options.auth.resolveIdentity(cfg);
      } catch {
        /* identity resolution must not break the call path */
      }
    }
    // Dispatch-time policy gate (issue #454): checked on EVERY call, so a
    // verdict that turned risky on re-discover blocks immediately and an
    // operator ack unblocks immediately — independent of registry rebuilds.
    try {
      const denial = this.options?.guard?.(cfg.id, toolName);
      if (denial) {
        this.emitCall(cfg, toolName, 'fail', denial, startedAt, actingIdentity);
        return denial;
      }
    } catch {
      /* a broken guard must not take down tool dispatch — fall through */
    }
    // Generic auth (issue #459 W9): inject a bearer token if the auth provider
    // has one for this server + caller. Provider-agnostic — the manager knows
    // nothing about OAuth, only "here is a token" / "here is where to log in".
    let token: string | null = null;
    if (this.options?.auth) {
      try {
        token = await this.options.auth.getToken(cfg);
      } catch {
        /* token resolution must not break the call path */
      }
    }
    // Merge Vault-resolved secret config headers (epic #459) into the cfg used
    // for the connection. Per-server, so pooling by id stays valid.
    cfg = await this.withResolvedConfig(cfg);
    // Retry once on a transient transport failure (e.g. a flaky hosted proxy
    // that intermittently returns "-32001 Request timed out" or drops the
    // connection). The retry drops the pooled connection first so it reconnects
    // fresh; auth-looking and real tool errors are NOT retried.
    let lastFailure = `Error: MCP tool "${toolName}" on "${cfg.name}" failed.`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let pooled: Pooled;
      try {
        pooled = await this.getOrConnect(cfg, token);
      } catch (err) {
        // A server that requires OAuth often refuses the connection outright
        // (streamable-HTTP surfaces the 401 as "-32000 Connection closed"), so
        // this path must also offer the auth prompt — not just tool-level errors.
        const failure = `Error: could not connect to MCP server "${cfg.name}": ${msg(err)}`;
        if (attempt < 2 && looksTransient(failure) && token !== null) {
          await this.close(this.poolKey(cfg, token));
          lastFailure = failure;
          continue;
        }
        return this.handleFailure(cfg, toolName, token, failure, startedAt, actingIdentity);
      }
      try {
        const res = await pooled.client.callTool(
          {
            name: toolName,
            arguments: args,
          },
          // Tolerate off-spec `structuredContent` (some third-party MCP servers —
          // e.g. the hosted Strava proxy — return it as a JSON array instead of an
          // object). The strict SDK schema otherwise rejects the whole result and
          // the failure surfaces to the model as "-32000 Connection closed",
          // making every tool call on that server look like a transport failure.
          LENIENT_CALL_TOOL_RESULT_SCHEMA,
          // Stated request policy instead of the SDK's implicit 60s default —
          // see DEFAULT_MCP_CALL_TIMEOUT_MS.
          (() => {
            const policy = resolveMcpCallTimeouts();
            return {
              timeout: policy.timeoutMs,
              resetTimeoutOnProgress: true,
              maxTotalTimeout: policy.maxTotalTimeoutMs,
            };
          })(),
        );
        const rendered = renderToolResult(res);
        // MCP protocol errors resolve (isError result) instead of throwing —
        // the audit row must reflect the failure (codex W2 finding).
        const protocolError =
          res !== null && typeof res === 'object' && (res as { isError?: unknown }).isError === true;
        if (protocolError) {
          return this.handleFailure(cfg, toolName, token, rendered, startedAt, actingIdentity);
        }
        // ── W2-1 (#544) MRTR mid-call user input ─────────────────────────────
        // Checked BEFORE the success audit and INSIDE the attempt loop with an
        // unconditional `return`, which is what makes the two "must nots" true
        // by construction: no retry attempt is consumed (we never `continue`),
        // and no failure row is emitted (`handleFailure` is not on this path).
        if (isInputRequiredResult(res)) {
          return this.parkInputRequired(
            cfg,
            toolName,
            args,
            res,
            startedAt,
            actingIdentity,
          );
        }
        this.emitCall(cfg, toolName, 'ok', null, startedAt, actingIdentity);
        // Issue #547 (W1-3) — hand any `structuredContent` to the out-of-band
        // sink. `rendered` above is already final and is NOT re-derived from
        // this: the model-facing string is byte-identical with or without a
        // sink installed. Error results are skipped by `extractStructured`.
        const structured = extractStructured(res);
        if (structured !== undefined) {
          this.emitStructured(cfg, toolName, structured);
        }
        return rendered;
      } catch (err) {
        // Drop the connection so the next call reconnects (server may have died).
        await this.close(this.poolKey(cfg, token));
        const failure = `Error: MCP tool "${toolName}" on "${cfg.name}" failed: ${msg(err)}`;
        if (attempt < 2 && looksTransient(failure)) {
          lastFailure = failure;
          continue;
        }
        return this.handleFailure(cfg, toolName, token, failure, startedAt, actingIdentity);
      }
    }
    // Both attempts hit a transient failure.
    return this.handleFailure(cfg, toolName, token, lastFailure, startedAt, actingIdentity);
  }

  /**
   * Any failed call goes through here. When the failure looks like auth OR the
   * call ran without a token, ask the auth provider — an OAuth-protected server
   * that the caller has not authorized should always surface a connect prompt,
   * regardless of the exact error string (a 401 can arrive as "-32000
   * Connection closed" over streamable HTTP). Otherwise the raw error stands.
   */
  private async handleFailure(
    cfg: McpServerConfig,
    toolName: string,
    token: string | null,
    rawFailure: string,
    startedAt: number,
    actingIdentity: string | null,
  ): Promise<string> {
    const maybeAuth = token === null || looksUnauthorized(rawFailure);
    if (maybeAuth && this.options?.auth) {
      // A stale token was rejected — drop its pooled connection so re-auth uses
      // a fresh one.
      if (token) await this.close(this.poolKey(cfg, token));
      let authMessage: string | null = null;
      try {
        authMessage = await this.options.auth.onAuthFailure(cfg);
      } catch {
        /* fall back to the raw failure */
      }
      if (authMessage) {
        this.emitCall(cfg, toolName, 'fail', 'auth_required', startedAt, actingIdentity);
        return authMessage;
      }
    }
    this.emitCall(cfg, toolName, 'fail', rawFailure, startedAt, actingIdentity);
    return rawFailure;
  }

  private poolKey(cfg: McpServerConfig, token: string | null): string {
    // A per-token pool key keeps different callers' authenticated connections
    // separate and lets a refreshed token transparently open a new connection.
    if (!token) return cfg.id;
    const h = createHash('sha256').update(token).digest('hex').slice(0, 12);
    return `${cfg.id}#${h}`;
  }

  async close(id: string): Promise<void> {
    const pooled = this.pool.get(id);
    this.pool.delete(id);
    this.connecting.delete(id);
    if (!pooled) return;
    try {
      await pooled.client.close();
    } catch {
      /* best-effort */
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pool.keys()].map((id) => this.close(id)));
  }

  private getOrConnect(cfg: McpServerConfig, token: string | null = null): Promise<Pooled> {
    const key = this.poolKey(cfg, token);
    const existing = this.pool.get(key);
    if (existing) return Promise.resolve(existing);
    const inflight = this.connecting.get(key);
    if (inflight) return inflight;

    const p = this.connect(cfg, token)
      .then((pooled) => {
        this.pool.set(key, pooled);
        this.connecting.delete(key);
        return pooled;
      })
      .catch((err) => {
        this.connecting.delete(key);
        throw err;
      });
    this.connecting.set(key, p);
    return p;
  }

  private async connect(cfg: McpServerConfig, token: string | null): Promise<Pooled> {
    const transport = this.makeTransport(cfg, token);
    const client = new Client(CLIENT_INFO);
    await client.connect(transport);
    return { client, transport };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** Resolve Vault-backed config into a cfg (epic #459): secret headers for
   *  http/sse, environment variables for stdio. Returns cfg unchanged when the
   *  provider has none. */
  private async withResolvedConfig(cfg: McpServerConfig): Promise<McpServerConfig> {
    const auth = this.options?.auth;
    if (!auth) return cfg;
    if (cfg.transport === 'stdio') {
      if (!auth.getConfigEnv) return cfg;
      let env: Record<string, string> = {};
      try {
        env = await auth.getConfigEnv.call(auth, cfg);
      } catch {
        /* config resolution must not break the call path */
      }
      if (!env || Object.keys(env).length === 0) return cfg;
      return { ...cfg, env: { ...(cfg.env ?? {}), ...env } };
    }
    if (!auth.getConfigHeaders) return cfg;
    let extra: Record<string, string> = {};
    try {
      extra = await auth.getConfigHeaders.call(auth, cfg);
    } catch {
      /* secret resolution must not break the call path */
    }
    if (!extra || Object.keys(extra).length === 0) return cfg;
    return { ...cfg, headers: { ...(cfg.headers ?? {}), ...extra } };
  }

  private makeTransport(cfg: McpServerConfig, token: string | null = null): Transport {
    if (!cfg.endpoint) {
      throw new Error(`MCP server "${cfg.name}" has no endpoint configured`);
    }
    if (cfg.transport === 'stdio') {
      const [command, ...args] = splitCommand(cfg.endpoint);
      if (!command) {
        throw new Error(`MCP server "${cfg.name}" stdio command is empty`);
      }
      // Merge our config env (values + Vault secrets) over a SAFE base env
      // (PATH/HOME/… from getDefaultEnvironment — not the full process env) so
      // the spawned server gets its required credentials (epic #459).
      const env =
        cfg.env && Object.keys(cfg.env).length > 0
          ? { ...getDefaultEnvironment(), ...cfg.env }
          : undefined;
      return new StdioClientTransport({ command, args, ...(env ? { env } : {}) });
    }
    const url = new URL(cfg.endpoint);
    // Merge the OAuth bearer token (issue #459 W9) with any configured headers;
    // bearer_methods_supported is 'header' for spec-compliant servers.
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    if (cfg.transport === 'sse') {
      return new SSEClientTransport(url, requestInit ? { requestInit } : {});
    }
    return new StreamableHTTPClientTransport(
      url,
      requestInit ? { requestInit } : {},
    );
  }
}

// ── adapters ────────────────────────────────────────────────────────────────

/** Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Build a stable,
 *  collision-resistant native name for an MCP tool. */
export function mcpNativeToolName(
  serverName: string,
  toolName: string,
): string {
  const raw = `mcp__${serverName}__${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.length <= 64 ? safe : safe.slice(0, 64);
}

function inputSchemaOrEmpty(tool: McpToolDescriptor): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const schema = tool.inputSchema;
  if (schema && schema['type'] === 'object') {
    return {
      type: 'object',
      properties: (schema['properties'] as Record<string, unknown>) ?? {},
      required: Array.isArray(schema['required'])
        ? (schema['required'] as string[])
        : [],
    };
  }
  return { type: 'object', properties: {}, required: [] };
}

/** Adapt an MCP tool into a top-level orchestrator NativeToolSpec. */
export function mcpToolToNativeSpec(
  serverName: string,
  tool: McpToolDescriptor,
): NativeToolSpec {
  return {
    name: mcpNativeToolName(serverName, tool.name),
    description:
      tool.description ?? `MCP tool "${tool.name}" from server "${serverName}".`,
    input_schema: inputSchemaOrEmpty(tool),
    domain: `mcp.${slugifyDomain(serverName)}`,
  };
}

/** Native handler that routes a tool call to the MCP server. */
export function mcpNativeHandler(
  manager: McpManager,
  cfg: McpServerConfig,
  toolName: string,
): NativeToolHandler {
  return async (input: unknown): Promise<string> => {
    const args =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    return manager.callTool(cfg, toolName, args);
  };
}

/** Adapt an MCP tool into a sub-agent tool (for `LocalSubAgent`). */
export function mcpToolToLocalSubAgentTool(
  manager: McpManager,
  cfg: McpServerConfig,
  tool: McpToolDescriptor,
): LocalSubAgentTool {
  // Issue #547 (W1-3): seed the schema cache from the (possibly DB-rehydrated)
  // descriptor so the sidecar carries an outputSchema even when this process
  // never ran discovery for this server.
  manager.rememberToolSchema(cfg.id, tool);
  return {
    spec: {
      name: mcpNativeToolName(cfg.name, tool.name),
      description:
        tool.description ?? `MCP tool "${tool.name}" from "${cfg.name}".`,
      input_schema: inputSchemaOrEmpty(tool),
    },
    async handle(input: unknown): Promise<string> {
      const args =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      return manager.callTool(cfg, tool.name, args);
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Flatten an MCP `CallToolResult` into a plain string for the LLM. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderToolResult(res: any): string {
  const content = res?.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block?.type === 'resource' && block.resource?.text) {
        parts.push(String(block.resource.text));
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    const joined = parts.join('\n').trim();
    const out = joined.length > 0 ? joined : JSON.stringify(content);
    return res?.isError ? `Error: ${out}` : out;
  }
  if (typeof res?.structuredContent !== 'undefined') {
    return JSON.stringify(res.structuredContent);
  }
  return JSON.stringify(res ?? {});
}

/**
 * Issue #547 (W1-3) — pull an MCP result's `structuredContent` out for the
 * out-of-band sidecar. Deliberately a SEPARATE function from
 * `renderToolResult`, which stays byte-for-byte unchanged: the model-facing
 * string must not shift because a sink is installed.
 *
 * Returns the payload exactly as the server sent it (object, or array for
 * off-spec hosted servers — see `LENIENT_CALL_TOOL_RESULT_SCHEMA`), never a
 * re-parse of the rendered string.
 *
 * Returns `undefined` for:
 *   - a non-object / protocol-error result (nothing trustworthy to read),
 *   - `isError: true` (a failed call has no result to render structurally),
 *   - an absent `structuredContent`,
 *   - an explicit `null` — off-spec (the spec requires an object) and carries
 *     nothing to render, so it is folded into "absent" rather than emitting an
 *     empty sidecar. Keeps the sink contract simple: a payload arrives only
 *     when there is genuinely something in it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractStructured(res: any): unknown | undefined {
  if (res === null || typeof res !== 'object') return undefined;
  if (res.isError === true) return undefined;
  const structured = res.structuredContent;
  if (structured === undefined || structured === null) return undefined;
  return structured;
}

/** Cache key for a per-server tool schema — same shape as the verdict maps in
 *  `agentBuilder.ts`. `serverId` is a UUID and so contains no space, which makes
 *  the FIRST space the unambiguous separator no matter what the tool name
 *  contains; no collision is possible. */
function schemaKey(serverId: string, toolName: string): string {
  return `${serverId} ${toolName}`;
}

/** True for a non-null, non-array object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The argument key the replay adds. Also the manager's only signal that a call
 * IS a replay — see `parkInputRequired`. Exported so the replayer and the tests
 * cannot drift from it.
 */
export const REPLAY_ARG_KEY = 'inputResponses';

/**
 * W2-1 (#544) — does this result ask for mid-call user input?
 *
 * Requires `resultType === 'input_required'` exactly. An `isError` result is
 * excluded: a failed call has no pending continuation to park, and treating one
 * as a card would turn every server-side error into a prompt for the user.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isInputRequiredResult(res: any): boolean {
  if (res === null || typeof res !== 'object') return false;
  if (res.isError === true) return false;
  return res.resultType === MCP_RESULT_TYPE_INPUT_REQUIRED;
}

/** Split a shell command line into argv. Honours simple double/single quotes;
 *  not a full shell parser, but enough for `npx -y @scope/pkg --flag "v"`. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function slugifyDomain(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'server';
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
