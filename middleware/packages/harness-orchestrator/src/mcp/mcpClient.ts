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

import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  LocalSubAgentTool,
  NativeToolHandler,
  NativeToolSpec,
} from '@omadia/plugin-api';

import { turnContext } from '../turnContext.js';

/**
 * Relaxed CallToolResult schema: the MCP spec says `structuredContent` MUST be a
 * JSON object, but some hosted proxies (e.g. strava.run.mcp.com.ai) return it as
 * an array. The SDK's strict schema rejects the entire result, and callTool then
 * throws — which we surface as "-32000 Connection closed", making every call on
 * that server look like a dead connection. Accepting any `structuredContent`
 * keeps well-formed servers unchanged while tolerating this one deviation; we
 * only read `content`/`isError` downstream anyway.
 */
// Cast back to the base schema type: the SDK's callTool overload is typed to the
// strict CallToolResultSchema, but our runtime schema only *widens* what parses
// (any structuredContent), so it is a safe superset. We never read
// structuredContent downstream — only `content`/`isError`.
const LENIENT_CALL_TOOL_RESULT_SCHEMA = CallToolResultSchema.extend({
  structuredContent: z.unknown().optional(),
}) as unknown as typeof CallToolResultSchema;

export type McpTransportKind = 'stdio' | 'http' | 'sse';

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
}

/** Caller taxonomy for the MCP call audit log (epic #459 W2, issue #462).
 *  Defined once here; skill (#456) and plugin (#458) surfaces identify
 *  themselves via `turnContext.mcpCallerKind`. */
export type McpCallerKind = 'agent' | 'subagent' | 'skill' | 'plugin' | 'unattributed';

/** One audit entry per `callTool` invocation. Deliberately carries NO tool
 *  arguments — identity and outcome only. */
export interface McpCallLogEntry {
  readonly serverId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly callerKind: McpCallerKind;
  readonly callerAgent: string | null;
  readonly turnId: string | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly durationMs: number;
  readonly calledAt: Date;
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

export interface McpManagerOptions {
  readonly onToolCall?: McpCallObserver;
  readonly guard?: McpCallGuard;
  readonly auth?: McpAuthProvider;
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
  return (
    /-?32001\b/.test(text) ||
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

export class McpManager {
  private readonly pool = new Map<string, Pooled>();
  private readonly connecting = new Map<string, Promise<Pooled>>();

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
    ok: boolean,
    error: string | null,
    startedAt: number,
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
        ok,
        // Bounded: external error strings can carry upstream data; the audit
        // table is append-only, so cap what gets persisted (codex W2 finding).
        error: error === null ? null : error.length > 300 ? `${error.slice(0, 300)}…` : error,
        durationMs: Date.now() - startedAt,
        calledAt: new Date(),
      });
    } catch {
      /* the audit trail must never break a tool call */
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
    return tools.map((t) => ({
      name: String(t.name),
      ...(t.description ? { description: String(t.description) } : {}),
      ...(t.inputSchema
        ? { inputSchema: t.inputSchema as Record<string, unknown> }
        : {}),
    }));
  }

  /** Invoke a tool. Never throws — returns an `Error: …` string on failure so
   *  the orchestrator turn keeps going. */
  async callTool(
    cfg: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const startedAt = Date.now();
    // Dispatch-time policy gate (issue #454): checked on EVERY call, so a
    // verdict that turned risky on re-discover blocks immediately and an
    // operator ack unblocks immediately — independent of registry rebuilds.
    try {
      const denial = this.options?.guard?.(cfg.id, toolName);
      if (denial) {
        this.emitCall(cfg, toolName, false, denial, startedAt);
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
        return this.handleFailure(cfg, toolName, token, failure, startedAt);
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
        );
        const rendered = renderToolResult(res);
        // MCP protocol errors resolve (isError result) instead of throwing —
        // the audit row must reflect the failure (codex W2 finding).
        const protocolError =
          res !== null && typeof res === 'object' && (res as { isError?: unknown }).isError === true;
        if (protocolError) {
          return this.handleFailure(cfg, toolName, token, rendered, startedAt);
        }
        this.emitCall(cfg, toolName, true, null, startedAt);
        return rendered;
      } catch (err) {
        // Drop the connection so the next call reconnects (server may have died).
        await this.close(this.poolKey(cfg, token));
        const failure = `Error: MCP tool "${toolName}" on "${cfg.name}" failed: ${msg(err)}`;
        if (attempt < 2 && looksTransient(failure)) {
          lastFailure = failure;
          continue;
        }
        return this.handleFailure(cfg, toolName, token, failure, startedAt);
      }
    }
    // Both attempts hit a transient failure.
    return this.handleFailure(cfg, toolName, token, lastFailure, startedAt);
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
        this.emitCall(cfg, toolName, false, 'auth_required', startedAt);
        return authMessage;
      }
    }
    this.emitCall(cfg, toolName, false, rawFailure, startedAt);
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

  private makeTransport(cfg: McpServerConfig, token: string | null = null): any {
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
